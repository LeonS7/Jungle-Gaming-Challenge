/** Esta página interrompe processos reais nos limites de commit/ACK e envio/registro da outbox. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../../src/application/wallets/open-wallet.js';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { Money } from '../../../src/domain/money/money.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';
import { PostgresWalletOpeningPersistence } from '../../../src/infrastructure/persistence/postgres-wallet-opening-persistence.js';

interface TestQueues {
  readonly wagerName: string;
  readonly deadLetterName: string;
  readonly eventName: string;
  readonly wagerUrl: string;
  readonly deadLetterUrl: string;
  readonly eventUrl: string;
}

interface BarrierObservation {
  readonly action: string;
  readonly queueUrl: string;
  readonly receiptHandle?: string;
  readonly messageBody?: string;
}

interface BarrierProxy {
  readonly endpoint: string;
  readonly reached: Promise<BarrierObservation>;
  readonly requests: string[];
  close(): Promise<void>;
}

interface StartedApplication {
  readonly port: number;
  readonly child: ChildProcess;
  readonly output: string[];
  readonly exited: Promise<void>;
}

function table(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

async function availablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar uma porta HTTP.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(condition: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Tempo esgotado aguardando ${description}.`);
}

async function startBarrierProxy(
  targetEndpoint: string,
  actionToPause: string,
  queueName: string,
  pauseAfterForward: boolean,
): Promise<BarrierProxy> {
  const target = new URL(targetEndpoint);
  let resolveReached!: (observation: BarrierObservation) => void;
  const reached = new Promise<BarrierObservation>((resolve) => { resolveReached = resolve; });
  let signaled = false;
  const requests: string[] = [];

  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const parameters = new URLSearchParams(body.toString('utf8'));
      let jsonBody: Record<string, unknown> = {};
      if (incoming.headers['content-type']?.includes('json')) {
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            jsonBody = parsed as Record<string, unknown>;
          }
        } catch {
          jsonBody = {};
        }
      }
      const query = new URL(incoming.url ?? '/', 'http://127.0.0.1').searchParams;
      const actionHeader = incoming.headers['x-amz-target'];
      const action = parameters.get('Action') ?? query.get('Action') ??
        (typeof actionHeader === 'string' ? actionHeader.split('.').at(-1) : '') ?? '';
      const queueUrl = parameters.get('QueueUrl') ?? query.get('QueueUrl') ??
        (typeof jsonBody.QueueUrl === 'string' ? jsonBody.QueueUrl : '');
      requests.push(`${incoming.method} ${incoming.url} ${incoming.headers['content-type'] ?? ''} action=${action} queue=${decodeURIComponent(queueUrl)}`);
      const selected = action === actionToPause && decodeURIComponent(queueUrl).includes(queueName);
      const observation: BarrierObservation = {
        action,
        queueUrl: decodeURIComponent(queueUrl),
        ...(typeof jsonBody.ReceiptHandle === 'string' || parameters.get('ReceiptHandle')
          ? { receiptHandle: String(jsonBody.ReceiptHandle ?? parameters.get('ReceiptHandle')) }
          : {}),
        ...(typeof jsonBody.MessageBody === 'string' || parameters.get('MessageBody')
          ? { messageBody: String(jsonBody.MessageBody ?? parameters.get('MessageBody')) }
          : {}),
      };

      if (selected && !pauseAfterForward) {
        if (!signaled) {
          signaled = true;
          resolveReached(observation);
        }
        // O processo cliente será encerrado pelo teste antes de receber uma resposta.
        return;
      }

      const upstream = httpRequest({
        hostname: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
        port: target.port ? Number(target.port) : 80,
        method: incoming.method,
        path: incoming.url ?? '/',
        headers: { ...incoming.headers, host: incoming.headers.host ?? target.host },
      }, (response) => {
        const responseChunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => responseChunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseBody = Buffer.concat(responseChunks);
          if (selected && pauseAfterForward && !signaled && response.statusCode === 200) {
            signaled = true;
            resolveReached(observation);
            // O SQS aceitou o evento, mas o publisher não recebe a resposta para gravar published_at.
            return;
          }
          const headers = { ...response.headers };
          delete headers.connection;
          delete headers['transfer-encoding'];
          outgoing.writeHead(response.statusCode ?? 502, headers);
          outgoing.end(responseBody);
        });
      });
      upstream.on('error', (error) => {
        if (!outgoing.destroyed) {
          outgoing.writeHead(502, { 'content-type': 'text/plain' });
          outgoing.end(error.message);
        }
      });
      upstream.end(body);
    })().catch((error: unknown) => {
      if (!outgoing.destroyed) {
        outgoing.writeHead(500, { 'content-type': 'text/plain' });
        outgoing.end(error instanceof Error ? error.message : 'Falha no proxy de teste.');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('O proxy SQS não abriu uma porta.');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    reached,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function waitForBarrier(proxy: BarrierProxy, application: StartedApplication): Promise<BarrierObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proxy.reached,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `O processo não atingiu a barreira SQS. Saída: ${application.output.join('')} Requisições observadas: ${proxy.requests.join(' | ')}`,
        )), 20_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startApplication(
  port: number,
  schema: string,
  queues: TestQueues,
  endpoint: string,
): StartedApplication {
  const output: string[] = [];
  const child = spawn(process.execPath, ['run', 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_PORT: String(port),
      DATABASE_SCHEMA: schema,
      AWS_ENDPOINT: endpoint,
      SQS_QUEUE_NAME: queues.wagerName,
      SQS_DLQ_QUEUE_NAME: queues.deadLetterName,
      SQS_OUTBOX_QUEUE_NAME: queues.eventName,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk: Uint8Array): void => {
    output.push(Buffer.from(chunk).toString('utf8'));
    while (output.join('').length > 12_000) output.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  return { port, child, output, exited };
}

async function waitForReady(application: StartedApplication): Promise<void> {
  await waitFor(async () => {
    if (application.child.exitCode !== null || application.child.signalCode !== null) {
      throw new Error(`A aplicação encerrou na inicialização: ${application.output.join('')}`);
    }
    try {
      return (await fetch(`http://127.0.0.1:${application.port}/health/ready`)).ok;
    } catch {
      return false;
    }
  }, 'readiness da aplicação filha');
}

async function terminate(application: StartedApplication, forced = false): Promise<void> {
  if (application.child.exitCode !== null || application.child.signalCode !== null) return;
  application.child.kill(forced ? 'SIGKILL' : 'SIGTERM');
  await Promise.race([
    application.exited,
    new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
  ]);
  if (application.child.exitCode === null && application.child.signalCode === null) {
    application.child.kill('SIGKILL');
    await application.exited;
  }
}

async function createQueues(sqs: SQSClient, suffix: string): Promise<TestQueues> {
  const wagerName = `wager-crash-${suffix}.fifo`;
  const deadLetterName = `wager-crash-dlq-${suffix}.fifo`;
  const eventName = `wager-crash-events-${suffix}.fifo`;
  const common = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const deadLetter = await sqs.send(new CreateQueueCommand({ QueueName: deadLetterName, Attributes: common }));
  if (!deadLetter.QueueUrl) throw new Error('LocalStack não criou a DLQ do teste.');
  const attributes = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: deadLetter.QueueUrl,
    AttributeNames: ['QueueArn'],
  }));
  const arn = attributes.Attributes?.QueueArn;
  if (!arn) throw new Error('LocalStack não retornou o ARN da DLQ.');
  const wager = await sqs.send(new CreateQueueCommand({
    QueueName: wagerName,
    Attributes: {
      ...common,
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '3' }),
    },
  }));
  const events = await sqs.send(new CreateQueueCommand({ QueueName: eventName, Attributes: common }));
  if (!wager.QueueUrl || !events.QueueUrl) throw new Error('LocalStack não criou todas as filas de teste.');
  return {
    wagerName,
    deadLetterName,
    eventName,
    wagerUrl: wager.QueueUrl,
    deadLetterUrl: deadLetter.QueueUrl,
    eventUrl: events.QueueUrl,
  };
}

async function initializeDatabase(schema: string): Promise<{
  readonly admin: MikroORM;
  readonly orm: MikroORM;
  close(): Promise<void>;
}> {
  const config = loadApplicationConfig();
  const admin = await MikroORM.init(createMikroOrmOptions(config));
  await admin.em.getConnection().execute(`create schema "${schema}"`);
  const orm = await MikroORM.init(createMikroOrmOptions(config, schema));
  try {
    await orm.migrator.up();
  } catch (error) {
    await orm.close(true);
    await admin.em.getConnection().execute(`drop schema if exists "${schema}" cascade`);
    await admin.close(true);
    throw error;
  }
  return {
    admin,
    orm,
    async close(): Promise<void> {
      await orm.close(true);
      await admin.em.getConnection().execute(`drop schema if exists "${schema}" cascade`);
      await admin.close(true);
    },
  };
}

async function openWallet(orm: MikroORM, schema: string): Promise<string> {
  return (await new OpenWallet(new PostgresWalletOpeningPersistence(orm, schema)).execute({
    playerId: `jogador-${randomUUID()}`,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  })).id;
}

async function deleteQueues(sqs: SQSClient, queues: TestQueues): Promise<void> {
  for (const queueUrl of [queues.wagerUrl, queues.deadLetterUrl, queues.eventUrl]) {
    try {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    } catch {
      // A limpeza continua para as outras filas se um recurso já tiver expirado.
    }
  }
}

test('processo consumidor morto depois do commit confirma redelivery sem segundo débito', async () => {
  const baseConfig = loadApplicationConfig();
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `teste_crash_inbox_${suffix}`;
  const portFirst = await availablePort();
  const portSecond = await availablePort();
  const database = await initializeDatabase(schema);
  const sqs = new SQSClient({
    region: baseConfig.sqs.region,
    endpoint: baseConfig.sqs.endpoint,
    credentials: { accessKeyId: baseConfig.sqs.accessKeyId, secretAccessKey: baseConfig.sqs.secretAccessKey },
  });
  let queues: TestQueues | undefined;
  let proxy: BarrierProxy | undefined;
  let first: StartedApplication | undefined;
  let second: StartedApplication | undefined;

  try {
    queues = await createQueues(sqs, suffix);
    const walletId = await openWallet(database.orm, schema);
    const walletRows = await database.orm.em.getConnection().execute(
      `select "player_id" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    ) as { player_id: string }[];
    const playerId = walletRows[0]?.player_id;
    if (!playerId) throw new Error('A carteira de teste não foi criada.');
    const messageId = `crash-${suffix}`;
    await sqs.send(new SendMessageCommand({
      QueueUrl: queues.wagerUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provedor-crash',
          externalTransactionId: `bet-${suffix}`,
          idempotencyKey: `crash:${suffix}`,
          playerId,
          walletId,
          roundId: `round-${suffix}`,
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: walletId,
      MessageDeduplicationId: messageId,
    }));

    proxy = await startBarrierProxy(baseConfig.sqs.endpoint, 'DeleteMessage', queues.wagerName, false);
    first = startApplication(portFirst, schema, queues, proxy.endpoint);
    await waitForReady(first);
    const interceptedAck = await waitForBarrier(proxy, first);
    expect(interceptedAck.receiptHandle).toBeTruthy();
    const committedRows = await database.orm.em.getConnection().execute(
      `select wallets."balance"::text as "balance",
              inbox."processed_at" is not null as "inboxProcessed",
              count(ledger."id") filter (where ledger."direction" = 'DEBIT')::text as "debits"
       from ${table(schema, 'wallets')} as wallets
       left join ${table(schema, 'inbox_messages')} as inbox on inbox."message_id" = ?
       left join ${table(schema, 'wallet_ledger_entries')} as ledger on ledger."wallet_id" = wallets."id"
       where wallets."id" = ?
       group by wallets."balance", inbox."processed_at"`,
      [messageId, walletId],
    ) as { balance: string; inboxProcessed: boolean; debits: string }[];
    expect(committedRows).toEqual([{ balance: '20.00', inboxProcessed: true, debits: '1' }]);

    await terminate(first, true);
    first = undefined;
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queues.wagerUrl,
      ReceiptHandle: interceptedAck.receiptHandle!,
      VisibilityTimeout: 0,
    }));

    second = startApplication(portSecond, schema, queues, baseConfig.sqs.endpoint);
    await waitForReady(second);
    await waitFor(async () => {
      const attributes = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: queues!.wagerUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      return attributes.Attributes?.ApproximateNumberOfMessages === '0' &&
        attributes.Attributes?.ApproximateNumberOfMessagesNotVisible === '0';
    }, 'ACK pela segunda instância após a redelivery');

    const finalRows = await database.orm.em.getConnection().execute(
      `select wallets."balance"::text as "balance",
              count(distinct ledger."id") filter (where ledger."direction" = 'DEBIT')::text as "debits",
              count(distinct wager."id") filter (where wager."external_transaction_id" = ?)::text as "bets",
              count(distinct inbox."message_id") filter (where inbox."message_id" = ? and inbox."processed_at" is not null)::text as "processedInbox"
       from ${table(schema, 'wallets')} as wallets
       left join ${table(schema, 'wallet_ledger_entries')} as ledger on ledger."wallet_id" = wallets."id"
       left join ${table(schema, 'wager_transactions')} as wager on wager."wallet_id" = wallets."id"
       left join ${table(schema, 'inbox_messages')} as inbox on inbox."message_id" = ?
       where wallets."id" = ?
       group by wallets."balance"`,
      [`bet-${suffix}`, messageId, messageId, walletId],
    ) as { balance: string; debits: string; bets: string; processedInbox: string }[];
    expect(finalRows).toEqual([{ balance: '20.00', debits: '1', bets: '1', processedInbox: '1' }]);

    const reconciliation = await fetch(`http://127.0.0.1:${portSecond}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({ consistent: true, storedBalance: { amount: '20.00' } });
  } finally {
    if (first) await terminate(first, true);
    if (second) await terminate(second);
    if (proxy) await proxy.close();
    if (queues) await deleteQueues(sqs, queues);
    sqs.destroy();
    await database.close();
  }
});

test('publisher morto depois do envio permite recuperar a outbox sem perder evento', async () => {
  const baseConfig = loadApplicationConfig();
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `teste_crash_outbox_${suffix}`;
  const portFirst = await availablePort();
  const portSecond = await availablePort();
  const database = await initializeDatabase(schema);
  const sqs = new SQSClient({
    region: baseConfig.sqs.region,
    endpoint: baseConfig.sqs.endpoint,
    credentials: { accessKeyId: baseConfig.sqs.accessKeyId, secretAccessKey: baseConfig.sqs.secretAccessKey },
  });
  let queues: TestQueues | undefined;
  let proxy: BarrierProxy | undefined;
  let first: StartedApplication | undefined;
  let second: StartedApplication | undefined;

  try {
    queues = await createQueues(sqs, suffix);
    const walletId = await openWallet(database.orm, schema);
    const outboxRows = await database.orm.em.getConnection().execute(
      `select "id"::text as "id", "event_type" as "eventType", "payload"::text as "payload"
       from ${table(schema, 'outbox_messages')} order by "sequence_number"`,
    ) as { id: string; eventType: string; payload: string }[];
    expect(outboxRows.length).toBeGreaterThan(0);
    const firstEventId = outboxRows[0]?.id;
    if (!firstEventId) throw new Error('A operação não gravou o evento da outbox.');

    proxy = await startBarrierProxy(baseConfig.sqs.endpoint, 'SendMessage', queues.eventName, true);
    first = startApplication(portFirst, schema, queues, proxy.endpoint);
    await waitForReady(first);
    const acceptedBySqs = await waitForBarrier(proxy, first);
    expect(acceptedBySqs.messageBody).toBeTruthy();
    const event = JSON.parse(acceptedBySqs.messageBody ?? '{}') as { eventId?: string };
    expect(event.eventId).toBe(firstEventId);
    const beforeCrash = await database.orm.em.getConnection().execute(
      `select "published_at" is null as "pending", "locked_until" > now() as "leased"
       from ${table(schema, 'outbox_messages')} where "id" = ?`,
      [firstEventId],
    );
    expect(beforeCrash).toEqual([{ pending: true, leased: true }]);
    await terminate(first, true);
    first = undefined;

    // O lease expirado é avançado deterministicamente depois da queda real do processo.
    await database.orm.em.getConnection().execute(
      `update ${table(schema, 'outbox_messages')}
       set "locked_until" = now() - interval '1 second'
       where "id" = ? and "published_at" is null`,
      [firstEventId],
    );
    second = startApplication(portSecond, schema, queues, baseConfig.sqs.endpoint);
    await waitForReady(second);
    await waitFor(async () => {
      const rows = await database.orm.em.getConnection().execute(
        `select count(*)::text as "pending"
         from ${table(schema, 'outbox_messages')} where "published_at" is null`,
      ) as { pending: string }[];
      return rows[0]?.pending === '0';
    }, 'publicação de todos os eventos da outbox recuperada');

    const expectedIds = outboxRows.map((row) => row.id);
    const eventIds: (string | undefined)[] = [];
    for (let index = 0; index < expectedIds.length; index += 1) {
      const queueMessages = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queues.eventUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }));
      const messages = queueMessages.Messages ?? [];
      for (const message of messages) {
        const body = JSON.parse(message.Body ?? '{}') as { eventId?: string };
        eventIds.push(body.eventId);
        if (message.ReceiptHandle) {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queues.eventUrl, ReceiptHandle: message.ReceiptHandle }));
        }
      }
    }
    expect([...eventIds].sort()).toEqual([...expectedIds].sort());
    expect(eventIds.filter((id) => id === firstEventId)).toHaveLength(1);

    const reconciliation = await fetch(`http://127.0.0.1:${portSecond}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({ consistent: true, storedBalance: { amount: '100.00' } });
  } finally {
    if (first) await terminate(first, true);
    if (second) await terminate(second);
    if (proxy) await proxy.close();
    if (queues) await deleteQueues(sqs, queues);
    sqs.destroy();
    await database.close();
  }
});

test('conexão PostgreSQL encerrada antes do commit não deixa efeitos parciais e aceita retry', async () => {
  const baseConfig = loadApplicationConfig();
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `teste_crash_pg_${suffix}`;
  const port = await availablePort();
  const database = await initializeDatabase(schema);
  const sqs = new SQSClient({
    region: baseConfig.sqs.region,
    endpoint: baseConfig.sqs.endpoint,
    credentials: { accessKeyId: baseConfig.sqs.accessKeyId, secretAccessKey: baseConfig.sqs.secretAccessKey },
  });
  let queues: TestQueues | undefined;
  let application: StartedApplication | undefined;
  let triggerCreated = false;

  try {
    queues = await createQueues(sqs, suffix);
    const walletId = await openWallet(database.orm, schema);
    const walletRows = await database.orm.em.getConnection().execute(
      `select "player_id" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    ) as { player_id: string }[];
    const playerId = walletRows[0]?.player_id;
    if (!playerId) throw new Error('A carteira de teste não foi criada.');

    application = startApplication(port, schema, queues, baseConfig.sqs.endpoint);
    await waitForReady(application);
    await waitFor(async () => {
      const rows = await database.orm.em.getConnection().execute(
        `select count(*)::text as "pending" from ${table(schema, 'outbox_messages')} where "published_at" is null`,
      ) as { pending: string }[];
      return rows[0]?.pending === '0';
    }, 'publicação dos eventos iniciais da carteira');

    await database.admin.em.getConnection().execute(`
      create function ${table(schema, 'pause_outbox_insert')}() returns trigger
      language plpgsql as $$
      begin
        perform pg_sleep(30);
        return new;
      end;
      $$;
      create trigger "pause_outbox_insert"
      before insert on ${table(schema, 'outbox_messages')}
      for each row execute function ${table(schema, 'pause_outbox_insert')}();
    `);
    triggerCreated = true;

    const idempotencyKey = `pg-recovery:${suffix}`;
    const payload = {
      providerId: 'provedor-pg-recovery',
      externalTransactionId: `bet-${suffix}`,
      playerId,
      walletId,
      roundId: `round-${suffix}`,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    const responsePromise = fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    let blockedBackendPid: number | undefined;
    await waitFor(async () => {
      const rows = await database.admin.em.getConnection().execute(
        `select pid from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and state = 'active'
           and query ilike ?
         order by query_start desc limit 1`,
        [`%insert into ${table(schema, 'outbox_messages')}%`],
      ) as { pid: number }[];
      blockedBackendPid = rows[0]?.pid;
      return blockedBackendPid !== undefined;
    }, 'operação suspensa dentro da transação antes de inserir a outbox');

    const terminated = await database.admin.em.getConnection().execute(
      'select pg_terminate_backend(?) as terminated',
      [blockedBackendPid],
    ) as { terminated: boolean }[];
    expect(terminated[0]?.terminated).toBe(true);
    const failedResponse = await responsePromise;
    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.json()).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });

    await database.admin.em.getConnection().execute(`
      drop trigger "pause_outbox_insert" on ${table(schema, 'outbox_messages')};
      drop function ${table(schema, 'pause_outbox_insert')}();
    `);
    triggerCreated = false;
    const afterFailure = await database.orm.em.getConnection().execute(
      `select wallets."balance"::text as "balance",
              count(distinct ledger."id") filter (where ledger."direction" = 'DEBIT')::text as "debits",
              count(distinct wager."id") filter (where wager."external_transaction_id" = ?)::text as "bets",
              count(*) filter (where outbox."event_type" like 'WagerTransaction%' and outbox."published_at" is null)::text as "unpublishedEvents"
       from ${table(schema, 'wallets')} as wallets
       left join ${table(schema, 'wallet_ledger_entries')} as ledger on ledger."wallet_id" = wallets."id"
       left join ${table(schema, 'wager_transactions')} as wager on wager."wallet_id" = wallets."id"
       left join ${table(schema, 'outbox_messages')} as outbox on outbox."transaction_id" = wager."id"
       where wallets."id" = ? group by wallets."balance"`,
      [`bet-${suffix}`, walletId],
    ) as { balance: string; debits: string; bets: string; unpublishedEvents: string }[];
    expect(afterFailure).toEqual([{ balance: '100.00', debits: '0', bets: '0', unpublishedEvents: '0' }]);

    const retryResponse = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00' } });
    const reconciliation = await fetch(`http://127.0.0.1:${port}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(await reconciliation.json()).toMatchObject({ consistent: true, storedBalance: { amount: '20.00' } });
  } finally {
    if (triggerCreated) {
      try {
        await database.admin.em.getConnection().execute(`
          drop trigger if exists "pause_outbox_insert" on ${table(schema, 'outbox_messages')};
          drop function if exists ${table(schema, 'pause_outbox_insert')}();
        `);
      } catch {
        // O schema será removido mesmo se a conexão de limpeza já tiver sido encerrada.
      }
    }
    if (application) await terminate(application);
    if (queues) await deleteQueues(sqs, queues);
    sqs.destroy();
    await database.close();
  }
});

test('duas instâncias disputam saldo, preservam o ledger e repetem a chave após reinício', async () => {
  const baseConfig = loadApplicationConfig();
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `teste_corrida_duas_${suffix}`;
  const firstPort = await availablePort();
  const secondPort = await availablePort();
  const restartedPort = await availablePort();
  const database = await initializeDatabase(schema);
  const sqs = new SQSClient({
    region: baseConfig.sqs.region,
    endpoint: baseConfig.sqs.endpoint,
    credentials: { accessKeyId: baseConfig.sqs.accessKeyId, secretAccessKey: baseConfig.sqs.secretAccessKey },
  });
  let queues: TestQueues | undefined;
  let first: StartedApplication | undefined;
  let second: StartedApplication | undefined;
  let restarted: StartedApplication | undefined;

  try {
    queues = await createQueues(sqs, suffix);
    const walletId = await openWallet(database.orm, schema);
    const walletRows = await database.orm.em.getConnection().execute(
      `select "player_id" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    ) as { player_id: string }[];
    const playerId = walletRows[0]?.player_id;
    if (!playerId) throw new Error('A carteira de teste não foi criada.');

    first = startApplication(firstPort, schema, queues, baseConfig.sqs.endpoint);
    second = startApplication(secondPort, schema, queues, baseConfig.sqs.endpoint);
    await Promise.all([waitForReady(first), waitForReady(second)]);

    const requests = [0, 1].map((index) => ({
      key: `concorrencia-${suffix}-${index}`,
      payload: {
        providerId: 'provedor-concorrente',
        externalTransactionId: `bet-concorrente-${suffix}-${index}`,
        playerId,
        walletId,
        roundId: `round-concorrente-${suffix}`,
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
    }));
    const results = await Promise.all(requests.map(async (request, index) => {
      const response = await fetch(`http://127.0.0.1:${index === 0 ? firstPort : secondPort}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
        body: JSON.stringify(request.payload),
      });
      return {
        httpStatus: response.status,
        body: await response.json() as { status?: string; idempotentReplay?: boolean; balance?: { amount?: string } },
      };
    }));
    expect(results.map((result) => result.httpStatus)).toEqual([200, 200]);
    expect(results.filter((result) => result.body.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.body.status === 'REJECTED')).toHaveLength(1);

    const financialRows = await database.orm.em.getConnection().execute(
      `select wallets."balance"::text as "balance",
              count(distinct ledger."id")::text as "ledgerEntries",
              count(distinct ledger."id") filter (where ledger."direction" = 'DEBIT')::text as "debits",
              count(distinct wager."id") filter (where wager."kind" = 'BET' and wager."status" = 'PROCESSED')::text as "processedBets",
              count(distinct wager."id") filter (where wager."kind" = 'BET' and wager."status" = 'REJECTED')::text as "rejectedBets"
       from ${table(schema, 'wallets')} as wallets
       left join ${table(schema, 'wallet_ledger_entries')} as ledger on ledger."wallet_id" = wallets."id"
       left join ${table(schema, 'wager_transactions')} as wager on wager."wallet_id" = wallets."id"
       where wallets."id" = ? group by wallets."balance"`,
      [walletId],
    ) as { balance: string; ledgerEntries: string; debits: string; processedBets: string; rejectedBets: string }[];
    expect(financialRows).toEqual([{
      balance: '20.00',
      ledgerEntries: '2',
      debits: '1',
      processedBets: '1',
      rejectedBets: '1',
    }]);

    const acceptedIndex = results[0]?.body.status === 'PROCESSED' ? 0 : 1;
    const acceptedRequest = requests[acceptedIndex]!;
    await terminate(first);
    first = undefined;
    restarted = startApplication(restartedPort, schema, queues, baseConfig.sqs.endpoint);
    await waitForReady(restarted);

    const replayResponse = await fetch(`http://127.0.0.1:${restartedPort}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': acceptedRequest.key },
      body: JSON.stringify(acceptedRequest.payload),
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '20.00' } });

    const conflictingPayload = {
      ...acceptedRequest.payload,
      gameId: 'fortune-chimp-alterado',
    };
    const conflictResponse = await fetch(`http://127.0.0.1:${restartedPort}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': acceptedRequest.key },
      body: JSON.stringify(conflictingPayload),
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const reconciliation = await fetch(`http://127.0.0.1:${restartedPort}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(await reconciliation.json()).toMatchObject({ consistent: true, storedBalance: { amount: '20.00' } });
  } finally {
    if (first) await terminate(first);
    if (second) await terminate(second);
    if (restarted) await terminate(restarted);
    if (queues) await deleteQueues(sqs, queues);
    sqs.destroy();
    await database.close();
  }
});
