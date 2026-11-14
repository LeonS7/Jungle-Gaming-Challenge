/** Este módulo persiste somente o contexto visual de uma rodada e reconfirma seu estado pela API. */
import type {
  WagerTransactionView,
  WalletTransactionsPageView,
} from '../../api/wagering-api';

export const ACTIVE_ROUND_STORAGE_KEY = 'jungle-gaming:active-round:v1';

export interface ActiveRoundContext {
  readonly walletId: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly gameId: string;
  readonly roundId: string;
  readonly externalTransactionId: string;
  readonly transactionId?: string;
  readonly amount: string;
  readonly currency: string;
}

export interface ActiveRoundApi {
  getProviderTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView>;
  getWalletTransactions(
    walletId: string,
    cursor?: string,
    limit?: number,
  ): Promise<WalletTransactionsPageView>;
}

export type ActiveRoundInspection =
  | { readonly state: 'active' }
  | { readonly state: 'resolved' }
  | { readonly state: 'bet-pending' }
  | { readonly state: 'invalid-bet' }
  | { readonly state: 'resolution-pending' };

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isActiveRoundContext(value: unknown): value is ActiveRoundContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return isText(context.walletId) &&
    isText(context.providerId) &&
    isText(context.playerId) &&
    isText(context.gameId) &&
    isText(context.roundId) &&
    isText(context.externalTransactionId) &&
    (context.transactionId === undefined || isText(context.transactionId)) &&
    typeof context.amount === 'string' && /^\d{1,28}\.\d{2}$/.test(context.amount) &&
    !/^0+\.00$/.test(context.amount) &&
    typeof context.currency === 'string' && /^[A-Z]{3}$/.test(context.currency);
}

export function storeActiveRound(storage: Storage, context: ActiveRoundContext): void {
  if (!isActiveRoundContext(context)) {
    throw new TypeError('O contexto da rodada não está completo ou é inválido.');
  }
  storage.setItem(ACTIVE_ROUND_STORAGE_KEY, JSON.stringify(context));
}

export function loadActiveRound(storage: Storage): ActiveRoundContext | null {
  const serialized = storage.getItem(ACTIVE_ROUND_STORAGE_KEY);
  if (serialized === null) return null;

  try {
    const value: unknown = JSON.parse(serialized);
    if (isActiveRoundContext(value)) return value;
  } catch {
    // Estado local corrompido não deve impedir a abertura do jogo.
  }
  storage.removeItem(ACTIVE_ROUND_STORAGE_KEY);
  return null;
}

export function clearActiveRound(storage: Storage): void {
  storage.removeItem(ACTIVE_ROUND_STORAGE_KEY);
}

export async function inspectActiveRound(
  context: ActiveRoundContext,
  api: ActiveRoundApi,
): Promise<ActiveRoundInspection> {
  const bet = await api.getProviderTransaction(
    context.providerId,
    context.externalTransactionId,
  );
  if (
    bet.kind !== 'BET' ||
    bet.walletId !== context.walletId ||
    bet.providerId !== context.providerId ||
    bet.playerId !== context.playerId ||
    bet.gameId !== context.gameId ||
    bet.roundId !== context.roundId ||
    bet.money.amount !== context.amount ||
    bet.money.currency !== context.currency ||
    (context.transactionId !== undefined && bet.transactionId !== context.transactionId)
  ) {
    return { state: 'invalid-bet' };
  }
  if (bet.status === 'PENDING' || bet.status === 'PENDING_REFERENCE') {
    return { state: 'bet-pending' };
  }
  if (bet.status !== 'PROCESSED') return { state: 'invalid-bet' };

  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let resolutionPending = false;
  do {
    const page = await api.getWalletTransactions(context.walletId, cursor, 100);
    for (const transaction of page.items) {
      if (
        transaction.walletId !== context.walletId ||
        transaction.playerId !== context.playerId ||
        transaction.providerId !== context.providerId ||
        transaction.gameId !== context.gameId ||
        transaction.roundId !== context.roundId ||
        (transaction.kind !== 'WIN' && transaction.kind !== 'LOSS')
      ) continue;
      if (
        transaction.kind === 'WIN' &&
        transaction.referenceExternalTransactionId !== context.externalTransactionId
      ) continue;
      if (transaction.status === 'PROCESSED') return { state: 'resolved' };
      if (transaction.status === 'PENDING' || transaction.status === 'PENDING_REFERENCE') {
        resolutionPending = true;
      }
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error('A API repetiu o cursor durante a recuperação da rodada.');
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return resolutionPending
    ? { state: 'resolution-pending' }
    : { state: 'active' };
}
