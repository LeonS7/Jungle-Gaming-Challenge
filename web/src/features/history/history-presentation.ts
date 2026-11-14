/** Esta página agrupa rodadas por provedor e traduz estados para o extrato. */
import type { WagerTransactionView } from '../../api/wagering-api';

export interface RoundGroup {
  readonly providerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly transactions: WagerTransactionView[];
}

export function groupTransactionsByRound(
  transactions: readonly WagerTransactionView[],
): RoundGroup[] {
  const groups = new Map<string, RoundGroup>();

  for (const transaction of transactions) {
    const groupKey = [transaction.providerId, transaction.gameId, transaction.roundId]
      .join('\u0000');
    const existing = groups.get(groupKey);
    if (existing) {
      existing.transactions.push(transaction);
      continue;
    }
    groups.set(groupKey, {
      providerId: transaction.providerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      transactions: [transaction],
    });
  }

  return [...groups.values()];
}

export function transactionStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    PENDING: 'Pendente',
    PENDING_REFERENCE: 'Aguardando referência',
    PROCESSED: 'Processada',
    REJECTED: 'Rejeitada',
    FAILED: 'Falha',
  };
  return labels[status] ?? status;
}
