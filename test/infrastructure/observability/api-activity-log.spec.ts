/**
 * Esta página verifica retenção limitada e paginação do registro de atividade.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import { ApiActivityLog } from '../../../src/infrastructure/observability/api-activity-log.js';
import { ApiActivityLogger } from '../../../src/infrastructure/observability/api-activity-logger.js';

test('o registro retorna páginas ordenadas depois do cursor informado', () => {
  const activityLog = new ApiActivityLog();
  activityLog.append('log', 'primeiro');
  activityLog.append('warn', 'segundo');
  activityLog.append('error', 'terceiro');

  const page = activityLog.readPage(1, 1);

  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.sequence).toBe(2);
  expect(page.items[0]?.message).toBe('segundo');
  expect(page.nextCursor).toBe(2);
  expect(page.hasMore).toBe(true);
  expect(page.gap).toBe(false);
});

test('o registro conserva somente as 500 entradas mais recentes', () => {
  const activityLog = new ApiActivityLog();
  for (let index = 1; index <= 501; index += 1) {
    activityLog.append('log', `evento-${index}`);
  }

  const page = activityLog.readPage(undefined, 100);

  expect(page.items).toHaveLength(100);
  expect(page.items[0]?.sequence).toBe(402);
  expect(page.items.at(-1)?.sequence).toBe(501);
  expect(page.gap).toBe(true);
});

test('a primeira página sinaliza entradas retidas que ficaram antes dela', () => {
  const activityLog = new ApiActivityLog();
  for (let index = 1; index <= 150; index += 1) {
    activityLog.append('log', `evento-${index}`);
  }

  const page = activityLog.readPage(undefined, 100);

  expect(page.items[0]?.sequence).toBe(51);
  expect(page.items.at(-1)?.sequence).toBe(150);
  expect(page.gap).toBe(true);
  expect(page.hasMore).toBe(false);
});

test('o adaptador inclui no registro as mensagens do NestJS com contexto', () => {
  const activityLog = new ApiActivityLog();
  const logger = new ApiActivityLogger(activityLog);

  logger.log('{"event":"teste.de.atividade"}', 'ContextoDeTeste');

  const page = activityLog.readPage(undefined, 10);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.level).toBe('log');
  expect(page.items[0]?.context).toBe('ContextoDeTeste');
  expect(page.items[0]?.message).toBe('{"event":"teste.de.atividade"}');
});
