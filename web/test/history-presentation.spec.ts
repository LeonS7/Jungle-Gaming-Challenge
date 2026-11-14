/** Esta página valida a separação de rodadas e rótulos apresentados no extrato. */
import { describe, expect, test } from 'bun:test';
import type { WagerTransactionView } from '../src/api/wagering-api';
import { groupTransactionsByRound, transactionStatusLabel } from '../src/features/history/history-presentation';

function transaction(
  transactionId: string,
  overrides: Partial<WagerTransactionView> = {},
): WagerTransactionView {
  return {
    transactionId,
    providerId: 'provedor-a',
    externalTransactionId: `externa-${transactionId}`,
    playerId: 'jogador-a',
    walletId: '00000000-0000-4000-8000-000000000001',
    roundId: 'rodada-1',
    gameId: 'jogo-1',
    kind: 'BET',
    status: 'PROCESSED',
    money: { amount: '10.00', currency: 'BRL' },
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    failureCode: null,
    balance: { amount: '90.00', currency: 'BRL' },
    createdAt: '2026-11-14T12:00:00.000Z',
    processedAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  };
}

describe('apresentação do extrato', () => {
  test('agrupa operações da mesma rodada pelo provedor, jogo e rodada', () => {
    const groups = groupTransactionsByRound([
      transaction('a'),
      transaction('b', { kind: 'WIN' }),
      transaction('c', { providerId: 'provedor-b' }),
      transaction('d', { roundId: 'rodada-2' }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.transactions.map(({ transactionId }) => transactionId)).toEqual(['a', 'b']);
    expect(groups.map(({ providerId, roundId }) => [providerId, roundId])).toEqual([
      ['provedor-a', 'rodada-1'],
      ['provedor-b', 'rodada-1'],
      ['provedor-a', 'rodada-2'],
    ]);
  });

  test('traduz também o estado FAILED sem alterar estados desconhecidos', () => {
    expect(transactionStatusLabel('FAILED')).toBe('Falha');
    expect(transactionStatusLabel('PENDING_REFERENCE')).toBe('Aguardando referência');
    expect(transactionStatusLabel('CUSTOM')).toBe('CUSTOM');
  });
});
