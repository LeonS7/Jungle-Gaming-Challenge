/** Esta página verifica os limites seguros do cenário de pressão da outbox. */
import { describe, expect, test } from 'bun:test';
import {
  OUTBOX_MAX_OPERATIONS,
  OUTBOX_MAX_OPERATIONS_PER_WALLET,
  maximumOperationsForScenario,
} from '../../../test/load/workloads/scenarios.js';

describe('volume dos cenários de carga', () => {
  test('mantém o volume distribuído configurado pelo operador', () => {
    expect(maximumOperationsForScenario('distributed', 12, 100)).toBe(1200);
  });

  test('limita a pressão da outbox por carteira e por execução', () => {
    expect(maximumOperationsForScenario('outbox', 12, 100)).toBe(OUTBOX_MAX_OPERATIONS);
    expect(maximumOperationsForScenario('outbox', 1, 100)).toBe(OUTBOX_MAX_OPERATIONS_PER_WALLET);
    expect(maximumOperationsForScenario('outbox', 3, 4)).toBe(12);
  });

  test('aplica os limites explícitos sem exceder o volume geral configurado', () => {
    expect(maximumOperationsForScenario('outbox', 12, 100, 50, 500)).toBe(500);
    expect(maximumOperationsForScenario('outbox', 3, 100, 50, 500)).toBe(150);
    expect(maximumOperationsForScenario('outbox', 3, 4, 50, 500)).toBe(12);
  });
});
