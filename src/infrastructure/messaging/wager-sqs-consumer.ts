/**
 * Esta página consome wagers por SQS, aguarda commit e controla retry e DLQ.
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  InboxMessagePayloadConflictError,
} from '../../application/messaging/inbox-errors.js';
import {
  IdempotencyConflictError,
  ProcessWager,
  ProviderTransactionConflictError,
  WagerCurrencyMismatchError,
  WagerWalletNotFoundError,
  WagerWalletOwnerMismatchError,
} from '../../application/wagering/process-wager.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import type { ApplicationConfig } from '../../config/application-config.js';
import { APPLICATION_CONFIG } from '../../config/config.constants.js';
import { parseWagerQueueMessage } from './wager-message-parser.js';
import { WageringMetrics } from '../observability/wagering-metrics.js';

const VISIBILITY_TIMEOUT_SECONDS = 45;
const VISIBILITY_HEARTBEAT_MILLISECONDS = 15_000;
const MAX_RETRY_VISIBILITY_SECONDS = 60;
const MAX_PROCESSING_ATTEMPTS = 5; // Alinhado ao maxReceiveCount da fila.

interface QueueUrls {
  readonly source: string;
  readonly deadLetter: string;
}

function logStructured(
  logger: Logger,
  level: 'log' | 'warn' | 'error',
  event: string,
  details: Record<string, string | number | boolean | undefined>,
): void {
  logger[level](JSON.stringify({ event, ...details }));
}

function receiveCount(message: Message): number {
  const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function isTerminalBusinessError(error: unknown): boolean {
  return (
    error instanceof IdempotencyConflictError ||
    error instanceof ProviderTransactionConflictError ||
    error instanceof WagerCurrencyMismatchError ||
    error instanceof WagerWalletNotFoundError ||
    error instanceof WagerWalletOwnerMismatchError
  );
}

@Injectable()
export class WagerSqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerSqsConsumer.name);
  private readonly client: SQSClient;
  private readonly abortController = new AbortController();
  private queueUrls: QueueUrls | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private lastDlqMetricAt = 0;
  private dlqMetricsInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly processWager: ProcessWager,
    private readonly metrics: WageringMetrics,
  ) {
    this.client = new SQSClient({
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      },
    });
  }

  onModuleInit(): void {
    this.loop = this.consumeLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abortController.abort();
    if (this.dlqMetricsInterval) {
      clearInterval(this.dlqMetricsInterval);
    }
    await this.loop;
    this.client.destroy();
  }

  private async consumeLoop(): Promise<void> {
    while (!this.stopping && !this.queueUrls) {
      try {
        this.queueUrls = await this.resolveQueueUrls();
      } catch (error) {
        logStructured(this.logger, 'warn', 'sqs.consumer.start_retry', {
          errorName: error instanceof Error ? error.name : 'Erro desconhecido',
        });
        await this.wait(1000);
      }
    }
    const queueUrls = this.queueUrls;
    if (!queueUrls || this.stopping) {
      return;
    }
    await this.refreshDeadLetterGauge(queueUrls.deadLetter);
    this.dlqMetricsInterval = setInterval(() => {
      void this.refreshDeadLetterGauge(queueUrls.deadLetter);
    }, 10_000);

    while (!this.stopping) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrls.source,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.abortController.signal },
        );
        const message = response.Messages?.[0];
        if (message) {
          await this.handleMessage(message);
        }
        if (Date.now() - this.lastDlqMetricAt >= 10_000) {
          await this.refreshDeadLetterGauge(queueUrls.deadLetter);
        }
      } catch (error) {
        if (this.stopping && this.abortController.signal.aborted) {
          break;
        }
        logStructured(this.logger, 'warn', 'sqs.consumer.receive_failed', {
          errorName: error instanceof Error ? error.name : 'Erro desconhecido',
        });
        await this.wait(1000);
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) {
      await this.moveToDeadLetterQueue(message, 'Mensagem sem corpo ou receipt handle.');
      return;
    }

    let parsed: ReturnType<typeof parseWagerQueueMessage>;
    try {
      parsed = parseWagerQueueMessage(message.Body);
    } catch (error) {
      await this.moveToDeadLetterQueue(
        message,
        error instanceof Error ? error.name : 'Mensagem inválida.',
      );
      return;
    }

    let heartbeatActive = true;
    let heartbeatRequest = Promise.resolve();
    const heartbeat = setInterval(() => {
      if (heartbeatActive) {
        heartbeatRequest = heartbeatRequest.then(() =>
          this.extendVisibility(message.ReceiptHandle!),
        );
      }
    }, VISIBILITY_HEARTBEAT_MILLISECONDS);
    const stopHeartbeat = async (): Promise<void> => {
      heartbeatActive = false;
      clearInterval(heartbeat);
      await heartbeatRequest;
    };
    const context = {
      correlationId: parsed.identity.messageId,
      messageId: parsed.identity.messageId,
      providerId: parsed.command.providerId,
      walletId: parsed.command.walletId,
    };

    try {
      const result = await this.processWager.executeFromInbox(
        parsed.command,
        parsed.identity,
      );
      await stopHeartbeat();
      const completeContext = {
        ...context,
        correlationId: result.result?.transactionId ?? context.correlationId,
        ...(result.result?.transactionId
          ? { transactionId: result.result.transactionId }
          : {}),
      };
      if (result.result?.status === WagerTransactionStatus.Failed) {
        await this.moveToDeadLetterQueue(
          message,
          result.result.failureCode ?? 'PROCESSING_RETRIES_EXHAUSTED',
          completeContext,
        );
      } else {
        await this.deleteMessage(message.ReceiptHandle);
        logStructured(this.logger, 'log', 'sqs.consumer.message_committed', {
          ...completeContext,
          consumerName: parsed.identity.consumerName,
          duplicate: result.duplicate,
          status: result.result?.status,
        });
      }
    } catch (error) {
      if (error instanceof InboxMessagePayloadConflictError) {
        await stopHeartbeat();
        await this.moveToDeadLetterQueue(message, error.name, context);
      } else if (isTerminalBusinessError(error)) {
        try {
          await this.processWager.recordTerminalInboxMessage(parsed.identity);
          await stopHeartbeat();
          await this.deleteMessage(message.ReceiptHandle);
          logStructured(this.logger, 'warn', 'sqs.consumer.business_error_acknowledged', {
            ...context,
            errorName: error instanceof Error ? error.name : 'Erro desconhecido',
          });
        } catch (terminalError) {
          await stopHeartbeat();
          await this.retryLater(message, terminalError, context);
        }
      } else if (receiveCount(message) >= MAX_PROCESSING_ATTEMPTS) {
        try {
          const failure = await this.processWager.failAfterRetriesFromInbox(
            parsed.command,
            parsed.identity,
          );
          await stopHeartbeat();
          if (failure.result?.status === WagerTransactionStatus.Failed) {
            logStructured(this.logger, 'error', 'sqs.consumer.transaction_failed', {
              ...context,
              transactionId: failure.result.transactionId,
              failureCode: failure.result.failureCode,
              attempt: receiveCount(message),
            });
            await this.moveToDeadLetterQueue(
              message,
              failure.result.failureCode ?? 'PROCESSING_RETRIES_EXHAUSTED',
              context,
            );
          } else {
            await this.deleteMessage(message.ReceiptHandle);
            logStructured(this.logger, 'log', 'sqs.consumer.final_attempt_already_resolved', {
              ...context,
              status: failure.result?.status,
              duplicate: failure.duplicate,
            });
          }
        } catch (failureError) {
          await stopHeartbeat();
          logStructured(this.logger, 'error', 'sqs.consumer.failed_state_persistence_failed', {
            ...context,
            attempt: receiveCount(message),
            errorName: failureError instanceof Error
              ? failureError.name
              : 'Erro desconhecido',
          });
          await this.moveToDeadLetterQueue(
            message,
            'FAILED_STATE_PERSISTENCE_UNAVAILABLE',
            context,
          );
        }
      } else {
        await stopHeartbeat();
        await this.retryLater(message, error, context);
      }
    } finally {
      await stopHeartbeat();
    }
  }

  private async refreshDeadLetterGauge(queueUrl: string): Promise<void> {
    try {
      const response = await this.client.send(new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      const count = Number(response.Attributes?.ApproximateNumberOfMessages ?? '0');
      this.metrics.setDeadLetterVisibleMessages(count);
      this.lastDlqMetricAt = Date.now();
    } catch (error) {
      logStructured(this.logger, 'warn', 'sqs.consumer.dlq_metric_failed', {
        errorName: error instanceof Error ? error.name : 'Erro desconhecido',
      });
    }
  }

  private async resolveQueueUrls(): Promise<QueueUrls> {
    const [source, deadLetter] = await Promise.all([
      this.client.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.queueName })),
      this.client.send(
        new GetQueueUrlCommand({ QueueName: this.config.sqs.deadLetterQueueName }),
      ),
    ]);
    if (!source.QueueUrl || !deadLetter.QueueUrl) {
      throw new Error('As filas SQS configuradas não retornaram URLs.');
    }
    return { source: source.QueueUrl, deadLetter: deadLetter.QueueUrl };
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    if (!this.queueUrls) {
      throw new Error('A fila SQS ainda não foi inicializada.');
    }
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.queueUrls.source,
      ReceiptHandle: receiptHandle,
    }));
  }

  private async extendVisibility(receiptHandle: string): Promise<void> {
    // O encerramento aguarda o handler atual; mantenha a mensagem invisível até
    // ele concluir ou programar retry, mesmo depois de o processo receber SIGTERM.
    if (!this.queueUrls) {
      return;
    }
    try {
      await this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrls.source,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      }));
    } catch (error) {
      logStructured(this.logger, 'warn', 'sqs.consumer.visibility_extension_failed', {
        errorName: error instanceof Error ? error.name : 'Erro desconhecido',
      });
    }
  }

  private async retryLater(
    message: Message,
    error: unknown,
    context?: Record<string, string>,
  ): Promise<void> {
    if (!message.ReceiptHandle || !this.queueUrls) {
      return;
    }
    const attempt = receiveCount(message);
    const delay = Math.min(2 ** (attempt - 1), MAX_RETRY_VISIBILITY_SECONDS);
    let retryScheduled = false;
    try {
      await this.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrls.source,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }));
      retryScheduled = true;
      this.metrics.recordRetry('sqs');
    } catch (visibilityError) {
      logStructured(this.logger, 'warn', 'sqs.consumer.retry_visibility_failed', {
        messageId: message.MessageId,
        errorName: visibilityError instanceof Error
          ? visibilityError.name
          : 'Erro desconhecido',
      });
    }
    logStructured(this.logger, 'error', 'sqs.consumer.message_retry_scheduled', {
      ...context,
      messageId: message.MessageId,
      attempt,
      delaySeconds: delay,
      retryScheduled,
      errorName: error instanceof Error ? error.name : 'Erro desconhecido',
      transientPersistenceFailure: error instanceof PersistenceUnavailableError,
    });
  }

  private async moveToDeadLetterQueue(
    message: Message,
    reason: string,
    context?: Record<string, string>,
  ): Promise<void> {
    if (!this.queueUrls || !message.Body || !message.ReceiptHandle) {
      return;
    }
    const deduplicationId = createHash('sha256')
      .update(message.MessageId ?? message.Body, 'utf8')
      .digest('hex');
    try {
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.queueUrls.deadLetter,
        MessageBody: message.Body,
        MessageGroupId: 'mensagens-invalidas',
        MessageDeduplicationId: deduplicationId,
      }));
      await this.deleteMessage(message.ReceiptHandle);
      await this.refreshDeadLetterGauge(this.queueUrls.deadLetter);
      logStructured(this.logger, 'error', 'sqs.consumer.message_sent_to_dlq', {
        ...context,
        correlationId: context?.correlationId ?? message.MessageId,
        messageId: message.MessageId,
        reason,
      });
    } catch (error) {
      await this.retryLater(message, error, context);
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout);
        this.abortController.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timeout = setTimeout(finish, milliseconds);
      this.abortController.signal.addEventListener('abort', finish, { once: true });
    });
  }
}
