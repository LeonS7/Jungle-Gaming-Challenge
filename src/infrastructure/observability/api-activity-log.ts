/**
 * Esta página mantém uma janela limitada de atividades recentes do processo.
 */
import { Injectable } from '@nestjs/common';

export type ApiActivityLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

export interface ApiActivityRecord {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly level: ApiActivityLevel;
  readonly context?: string;
  readonly message: string;
}

export interface ApiActivityPage {
  readonly items: readonly ApiActivityRecord[];
  readonly nextCursor: number;
  readonly gap: boolean;
  readonly hasMore: boolean;
}

const MAX_RETAINED_RECORDS = 500;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CONTEXT_LENGTH = 120;

@Injectable()
export class ApiActivityLog {
  private sequence = 0;
  private readonly records: ApiActivityRecord[] = [];

  append(
    level: ApiActivityLevel,
    message: string,
    context?: string,
  ): ApiActivityRecord {
    const record: ApiActivityRecord = {
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      level,
      ...(context ? { context: context.slice(0, MAX_CONTEXT_LENGTH) } : {}),
      message: message.slice(0, MAX_MESSAGE_LENGTH),
    };

    this.records.push(record);
    if (this.records.length > MAX_RETAINED_RECORDS) {
      this.records.shift();
    }

    return record;
  }

  readPage(after: number | undefined, limit: number): ApiActivityPage {
    const oldestSequence = this.records[0]?.sequence;
    const candidates = this.records.filter((record) =>
      after === undefined || record.sequence > after
    );
    const initialOffset = after === undefined
      ? Math.max(0, candidates.length - limit)
      : 0;
    const items = candidates.slice(initialOffset, initialOffset + limit);
    const lastItem = items.at(-1);
    const currentSequence = this.sequence;

    return {
      items,
      nextCursor: lastItem?.sequence ?? after ?? currentSequence,
      gap: oldestSequence !== undefined && (
        after === undefined
          ? oldestSequence > 1 || initialOffset > 0
          : after < oldestSequence - 1
      ),
      hasMore: candidates.length > initialOffset + items.length,
    };
  }
}
