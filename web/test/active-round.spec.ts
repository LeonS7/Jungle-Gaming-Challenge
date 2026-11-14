/** Esta página verifica persistência local e confirmação remota do contexto de uma rodada. */
import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_ROUND_STORAGE_KEY,
  clearActiveRound,
  inspectActiveRound,
  loadActiveRound,
  storeActiveRound,
  type ActiveRoundContext,
  type ActiveRoundApi,
} from '../src/features/game/active-round';
import type { WagerTransactionView } from '../src/api/wagering-api';

const round: ActiveRoundContext = {
  walletId: 'wallet-1',
  providerId: 'provider-1',
  playerId: 'player-1',
  gameId: 'game-1',
  roundId: 'round-1',
  externalTransactionId: 'bet-1',
  transactionId: 'transaction-1',
  amount: '20.00',
  currency: 'BRL',
};

function transaction(
  overrides: Partial<WagerTransactionView> = {},
): WagerTransactionView {
  return {
    transactionId: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'bet-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    status: 'PROCESSED',
    money: { amount: '20.00', currency: 'BRL' },
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    failureCode: null,
    balance: { amount: '80.00', currency: 'BRL' },
    createdAt: '2026-11-14T12:00:00.000Z',
    processedAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  };
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  } as Storage;
}

function api(
  bet: WagerTransactionView = transaction(),
  pages: readonly { items: readonly WagerTransactionView[]; nextCursor: string | null }[] = [
    { items: [], nextCursor: null },
  ],
): ActiveRoundApi {
  let pageIndex = 0;
  return {
    getProviderTransaction: async () => bet,
    getWalletTransactions: async () => pages[pageIndex++] ?? { items: [], nextCursor: null },
  };
}

describe('recuperação da rodada ativa', () => {
  test('persiste e recupera somente o contexto necessário para consultar a API', () => {
    const local = storage();
    storeActiveRound(local, round);

    expect(loadActiveRound(local)).toEqual(round);
    clearActiveRound(local);
    expect(loadActiveRound(local)).toBeNull();
  });

  test('descarta contexto incompleto, corrompido ou com escala monetária inválida', () => {
    const local = storage();
    local.setItem(ACTIVE_ROUND_STORAGE_KEY, '{malformado');
    expect(loadActiveRound(local)).toBeNull();
    expect(local.getItem(ACTIVE_ROUND_STORAGE_KEY)).toBeNull();
    expect(() => storeActiveRound(local, { ...round, amount: '20.001' })).toThrow();
  });

  test('restaura a BET processada sem resolução depois de percorrer o histórico paginado', async () => {
    const getWalletTransactions = async (_walletId: string, cursor?: string) => {
      expect(cursor).toBe(cursor ? 'cursor-2' : undefined);
      return cursor
        ? { items: [], nextCursor: null }
        : { items: [], nextCursor: 'cursor-2' };
    };
    expect(await inspectActiveRound(round, {
      getProviderTransaction: async () => transaction(),
      getWalletTransactions,
    })).toEqual({ state: 'active' });
  });

  test('não restaura BET pendente ou rejeitada', async () => {
    expect(await inspectActiveRound(round, api(transaction({ status: 'PENDING' })))).toEqual({ state: 'bet-pending' });
    expect(await inspectActiveRound(round, api(transaction({ status: 'REJECTED' })))).toEqual({ state: 'invalid-bet' });
  });

  test('não restaura uma rodada que já possui WIN ou LOSS processado', async () => {
    for (const kind of ['WIN', 'LOSS']) {
      const result = transaction({
        transactionId: `transaction-${kind}`,
        externalTransactionId: `${kind.toLowerCase()}-1`,
        kind,
        status: 'PROCESSED',
        ...(kind === 'WIN' ? { referenceExternalTransactionId: round.externalTransactionId } : {}),
      });
      expect(await inspectActiveRound(round, api(transaction(), [{ items: [result], nextCursor: null }]))).toEqual({ state: 'resolved' });
    }
  });

  test('bloqueia nova resolução enquanto o resultado ainda está pendente', async () => {
    const result = transaction({
      transactionId: 'win-1',
      externalTransactionId: 'win-ext-1',
      kind: 'WIN',
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: round.externalTransactionId,
    });
    expect(await inspectActiveRound(round, api(transaction(), [{ items: [result], nextCursor: null }]))).toEqual({ state: 'resolution-pending' });
  });

  test('não considera um WIN processado que referencia outra BET', async () => {
    const unrelatedWin = transaction({
      transactionId: 'win-1',
      externalTransactionId: 'win-ext-1',
      kind: 'WIN',
      status: 'PROCESSED',
      referenceExternalTransactionId: 'outra-bet',
    });
    expect(await inspectActiveRound(round, api(transaction(), [{ items: [unrelatedWin], nextCursor: null }]))).toEqual({ state: 'active' });
  });

  test('não associa operação de outro provedor, carteira ou rodada à BET salva', async () => {
    const mismatch = transaction({ providerId: 'other-provider' });
    expect(await inspectActiveRound(round, api(mismatch))).toEqual({ state: 'invalid-bet' });
  });
});
