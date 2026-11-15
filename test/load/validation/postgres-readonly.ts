/** Esta página consulta somente dados do benchmark e nunca altera o banco. */
import { Decimal } from 'decimal.js';
import { MikroORM } from '@mikro-orm/postgresql';
import type { ApplicationConfig } from '../../../src/config/application-config.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';
import type { IntegrityCheck, OutboxSnapshot } from '../types.js';

interface WalletRow {
  readonly id: string;
  readonly balance: string;
  readonly currency: string;
}

interface LedgerRow {
  readonly walletId: string;
  readonly entryCount: string;
  readonly transactionCount: string;
  readonly calculatedBalance: string;
}

interface TransactionRow {
  readonly id: string;
  readonly externalTransactionId: string;
  readonly kind: string;
  readonly status: string;
  readonly providerId: string;
}

interface EventRow {
  readonly transactionId: string;
  readonly eventType: string;
  readonly count: string;
}

interface TransactionUniquenessRow {
  readonly transactionCount: string;
  readonly idempotencyKeyCount: string;
  readonly providerExternalIdCount: string;
}

interface OutboxRow {
  readonly total: string;
  readonly published: string;
  readonly pending: string;
  readonly attempts: string;
  readonly oldestPendingAgeSeconds: string;
}

export interface FinancialSnapshot {
  readonly wallets: readonly WalletRow[];
  readonly transactions: readonly TransactionRow[];
  readonly checks: readonly IntegrityCheck[];
}

function table(schema: string | undefined, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('O nome da tabela de leitura é inválido.');
  }
  if (!schema) {
    return `"${name}"`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('O nome do schema PostgreSQL contém caracteres inválidos.');
  }
  return `"${schema}"."${name}"`;
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('A consulta de integridade exige ao menos uma carteira.');
  }
  return Array.from({ length: count }, () => '?').join(', ');
}

function check(name: string, passed: boolean, detail: string): IntegrityCheck {
  return { name, passed, detail };
}

export class PostgresLoadTestReader {
  private constructor(
    private readonly orm: MikroORM,
    private readonly config: ApplicationConfig,
  ) {}

  static async connect(config: ApplicationConfig): Promise<PostgresLoadTestReader> {
    const orm = await MikroORM.init(createMikroOrmOptions(config, config.postgres.schema));
    return new PostgresLoadTestReader(orm, config);
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }

  async checkConnection(): Promise<void> {
    await this.orm.em.getConnection().execute('select 1 as "available"');
  }

  async readOutbox(walletIds: readonly string[]): Promise<OutboxSnapshot> {
    const walletParameters = [...walletIds];
    const rows = await this.orm.em.getConnection().execute(
      `select count(*)::text as "total",
              count(*) filter (where "published_at" is not null)::text as "published",
              count(*) filter (where "published_at" is null)::text as "pending",
              coalesce(sum("attempts"), 0)::text as "attempts",
              coalesce(
                extract(epoch from (
                  now() - min("created_at") filter (where "published_at" is null)
                )),
                0
              )::text as "oldestPendingAgeSeconds"
       from ${table(this.config.postgres.schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(this.config.postgres.schema, 'wager_transactions')}
         where "wallet_id" in (${placeholders(walletParameters.length)})
       )`,
      walletParameters,
      'all',
    );
    const row = rows[0] as unknown as OutboxRow | undefined;
    if (!row) {
      throw new Error('O PostgreSQL não retornou a consulta da outbox.');
    }
    return {
      total: Number(row.total),
      published: Number(row.published),
      pending: Number(row.pending),
      attempts: Number(row.attempts),
      oldestPendingAgeSeconds: Number(row.oldestPendingAgeSeconds),
    };
  }

  async verifyWallets(
    walletIds: readonly string[],
    requiredExternalTransactionIds: readonly string[],
  ): Promise<FinancialSnapshot> {
    const ids = [...walletIds];
    const parameters = [...ids];
    const walletRows = await this.orm.em.getConnection().execute(
      `select "id"::text as "id", "balance"::text as "balance", "currency"::text as "currency"
       from ${table(this.config.postgres.schema, 'wallets')}
       where "id" in (${placeholders(ids.length)})`,
      parameters,
      'all',
    ) as unknown as WalletRow[];
    const ledgerRows = await this.orm.em.getConnection().execute(
      `select "wallet_id"::text as "walletId",
              count(*)::text as "entryCount",
              count(distinct "transaction_id")::text as "transactionCount",
              coalesce(sum(case "direction"
                when 'CREDIT' then "amount"
                when 'DEBIT' then -"amount"
                else 0::numeric
              end), 0::numeric)::numeric(30, 2)::text as "calculatedBalance"
       from ${table(this.config.postgres.schema, 'wallet_ledger_entries')}
       where "wallet_id" in (${placeholders(ids.length)})
       group by "wallet_id"`,
      parameters,
      'all',
    ) as unknown as LedgerRow[];
    const transactionRows = await this.orm.em.getConnection().execute(
      `select "id"::text as "id",
              "external_transaction_id" as "externalTransactionId",
              "kind", "status", "provider_id" as "providerId"
       from ${table(this.config.postgres.schema, 'wager_transactions')}
       where "wallet_id" in (${placeholders(ids.length)})`,
      parameters,
      'all',
    ) as unknown as TransactionRow[];
    const eventRows = await this.orm.em.getConnection().execute(
      `select outbox."transaction_id"::text as "transactionId",
              outbox."event_type" as "eventType",
              count(*)::text as "count"
       from ${table(this.config.postgres.schema, 'outbox_messages')} outbox
       where outbox."transaction_id" in (
         select wager."id" from ${table(this.config.postgres.schema, 'wager_transactions')} as wager
         where wager."wallet_id" in (${placeholders(ids.length)})
       )
       group by outbox."transaction_id", outbox."event_type"`,
      parameters,
      'all',
    ) as unknown as EventRow[];
    const uniquenessRows = await this.orm.em.getConnection().execute(
      `select count(*)::text as "transactionCount",
              count(distinct "idempotency_key")::text as "idempotencyKeyCount",
              count(distinct ("provider_id", "external_transaction_id"))::text as "providerExternalIdCount"
       from ${table(this.config.postgres.schema, 'wager_transactions')}
       where "wallet_id" in (${placeholders(ids.length)})`,
      parameters,
      'all',
    ) as unknown as TransactionUniquenessRow[];

    const ledgerByWallet = new Map(ledgerRows.map((row) => [row.walletId, row]));
    const ledgerByTransaction = await this.orm.em.getConnection().execute(
      `select "wallet_id"::text as "walletId",
              "transaction_id"::text as "transactionId",
              count(*)::text as "count"
       from ${table(this.config.postgres.schema, 'wallet_ledger_entries')}
       where "wallet_id" in (${placeholders(ids.length)})
       group by "wallet_id", "transaction_id"`,
      parameters,
      'all',
    ) as unknown as { readonly walletId: string; readonly transactionId: string; readonly count: string }[];
    const eventsByTransaction = new Map<string, Map<string, number>>();
    for (const event of eventRows) {
      const byType = eventsByTransaction.get(event.transactionId) ?? new Map<string, number>();
      byType.set(event.eventType, Number(event.count));
      eventsByTransaction.set(event.transactionId, byType);
    }
    const ledgerTransactions = new Map<string, number>();
    for (const row of ledgerByTransaction) {
      ledgerTransactions.set(row.transactionId, Number(row.count));
    }

    let balanceMatchesLedger = walletRows.length === ids.length;
    for (const wallet of walletRows) {
      const ledger = ledgerByWallet.get(wallet.id);
      const ledgerBalance = ledger?.calculatedBalance ?? '0.00';
      if (!new Decimal(wallet.balance).equals(new Decimal(ledgerBalance))) {
        balanceMatchesLedger = false;
      }
    }
    const duplicateLedgerEntries = ledgerRows.some(
      (row) => Number(row.entryCount) !== Number(row.transactionCount),
    );

    let transactionAndLedgerRulesHold = true;
    let requiredTransactionsExist = true;
    let transactionAndEventRulesHold = true;
    for (const transaction of transactionRows) {
      const ledgerCount = ledgerTransactions.get(transaction.id) ?? 0;
      const changesBalance = transaction.kind !== 'LOSS';
      const expectedLedgerCount = transaction.status === 'PROCESSED' && changesBalance ? 1 : 0;
      if (ledgerCount !== expectedLedgerCount) {
        transactionAndLedgerRulesHold = false;
      }

      const events = eventsByTransaction.get(transaction.id);
      const processedEventCount = events?.get('WagerTransactionProcessed') ?? 0;
      const rejectedEventCount = events?.get('WagerTransactionRejected') ?? 0;
      const balanceEventCount = events?.get('WalletBalanceChanged') ?? 0;
      const totalEventCount = events
        ? [...events.values()].reduce((sum, count) => sum + count, 0)
        : 0;
      const expectedEventCount = transaction.status === 'PROCESSED'
        ? 1 + expectedLedgerCount
        : transaction.status === 'REJECTED' ? 1 : 0;
      if (
        transaction.status === 'PROCESSED' && processedEventCount !== 1 ||
        transaction.status === 'REJECTED' && rejectedEventCount !== 1 ||
        transaction.status !== 'PROCESSED' && transaction.status !== 'REJECTED' ||
        balanceEventCount !== expectedLedgerCount ||
        totalEventCount !== expectedEventCount
      ) {
        transactionAndEventRulesHold = false;
      }
    }
    const observedExternalIds = new Set(transactionRows.map((row) => row.externalTransactionId));
    for (const externalId of requiredExternalTransactionIds) {
      if (!observedExternalIds.has(externalId)) {
        requiredTransactionsExist = false;
      }
    }

    const outbox = await this.readOutbox(ids);
    const uniqueness = uniquenessRows[0];
    const transactionCount = Number(uniqueness?.transactionCount ?? '0');
    const uniquenessHolds = uniqueness !== undefined &&
      transactionCount === Number(uniqueness.idempotencyKeyCount) &&
      transactionCount === Number(uniqueness.providerExternalIdCount);
    const checks = [
      check('carteiras da execução', walletRows.length === ids.length, `${walletRows.length} de ${ids.length} carteiras foram encontradas.`),
      check('saldo igual ao ledger', balanceMatchesLedger, 'Saldo materializado comparado com a soma NUMERIC dos lançamentos.'),
      check('sem lançamento duplicado', !duplicateLedgerEntries, 'Cada transação possui no máximo um lançamento por carteira.'),
      check('chaves e identidades únicas', uniquenessHolds, 'As chaves de idempotência e os identificadores externos são únicos no escopo das carteiras do benchmark.'),
      check('regras de movimentação', transactionAndLedgerRulesHold, 'BET e operações financeiras processadas têm lançamento; LOSS e rejeições não alteram o ledger.'),
      check('transações aceitas persistidas', requiredTransactionsExist, 'As operações com resposta HTTP de aceite estão presentes no PostgreSQL.'),
      check('eventos correspondentes', transactionAndEventRulesHold, 'Transações processadas/rejeitadas e mudanças de saldo têm eventos correspondentes na outbox.'),
      check('transações sem estado pendente', transactionRows.every((row) => row.status === 'PROCESSED' || row.status === 'REJECTED'), 'Nenhuma transação desta execução permaneceu PENDING, PENDING_REFERENCE ou FAILED.'),
      check('outbox sem perda de evento', outbox.total >= transactionRows.length, `${outbox.total} eventos da execução para ${transactionRows.length} transações; aberturas podem emitir dois eventos.`),
    ];

    return { wallets: walletRows, transactions: transactionRows, checks };
  }
}
