/** Esta página verifica que o relatório distingue respostas, falhas e operações. */
import { describe, expect, test } from 'bun:test';
import { collectLoadTestEnvironment, formatMarkdownReport, parsePhysicalCoreCount, summarizeScenarioResult } from '../../../test/load/reporting/reports.js';
import { parseLoadTestArguments } from '../../../test/load/config.js';
import type { LoadTestReport, ScenarioResult } from '../../../test/load/types.js';

const scenario: ScenarioResult = {
  scenario: 'contention',
  repetition: 1,
  concurrency: 3,
  walletIds: ['carteira-de-teste'],
  startedAt: '2026-11-14T12:00:00.000Z',
  durationMilliseconds: 1000,
  requests: [
    { elapsedMilliseconds: 4, httpStatus: 200, transactionStatus: 'PROCESSED' },
    { elapsedMilliseconds: 8, httpStatus: 200, transactionStatus: 'REJECTED' },
    { elapsedMilliseconds: 15, httpStatus: 409, responseCode: 'IDEMPOTENCY_CONFLICT', businessConflict: true },
    { elapsedMilliseconds: 40, httpStatus: null, errorKind: 'timeout' },
  ],
  metrics: [{
    apiUrl: 'http://127.0.0.1:3000',
    capturedAt: '2026-11-14T12:00:00.000Z',
    samples: [{ metric: 'wagering_transactions_total', labels: { status: 'PROCESSED' }, value: 1 }],
  }],
  prometheusCounters: {
    'wagering_lock_conflicts_total[]': 2,
    'wagering_wallet_lock_acquisition_seconds_count[]': 4,
    'wagering_wallet_lock_acquisition_seconds_sum[]': 0.02,
  },
  prometheusGauges: {},
  outboxSamples: [{
    total: 4,
    published: 2,
    pending: 2,
    attempts: 1,
    oldestPendingAgeSeconds: 5,
  }],
  integrity: [{ name: 'conferência', passed: true, detail: 'coerente' }],
  expectedProcessed: 1,
  expectedRejected: 1,
  expectedReplays: 0,
  expectedConflicts: 0,
  outboxDrainMilliseconds: null,
};

describe('relatório do benchmark', () => {
  test('calcula latência somente para respostas HTTP recebidas', () => {
    const summary = summarizeScenarioResult(scenario);
    expect(summary.httpCompleted).toBe(3);
    expect(summary.financialProcessed).toBe(1);
    expect(summary.businessRejected).toBe(1);
    expect(summary.expectedIdempotencyConflicts).toBe(1);
    expect(summary.operationalErrors).toBe(1);
    expect(summary.timeoutCount).toBe(1);
    expect(summary.latencies).toEqual({
      count: 3,
      minimumMilliseconds: 4,
      maximumMilliseconds: 15,
      meanMilliseconds: 9,
      p50Milliseconds: 8,
      p95Milliseconds: 15,
      p99Milliseconds: 15,
    });
    expect(summary.lockConflicts).toBe(2);
    expect(summary.lockWaitAverageMilliseconds).toBe(5);
    expect(summary.outboxPending).toBe(2);
  });

  test('apresenta medições, verificações e limites em português', () => {
    const report: LoadTestReport = {
      executionId: 'execucao-teste',
      startedAt: '2026-11-14T12:00:00.000Z',
      finishedAt: '2026-11-14T12:00:01.000Z',
      configuration: {
        apiUrls: ['http://127.0.0.1:3000'],
        scenario: 'contention',
        durationSeconds: 1,
        warmupSeconds: 0,
        repetitions: 1,
        concurrencyLevels: [3],
        walletCount: 1,
        operationsPerWallet: 3,
        outboxOperationsPerWallet: 10,
        outboxMaxOperations: 120,
        apiInstanceCount: 1,
        consumerCount: 1,
        publisherCount: 1,
        metricsIntervalSeconds: 1,
        httpTimeoutMilliseconds: 1000,
        outboxDrainTimeoutSeconds: 5,
      },
      environment: {
        runtime: 'Bun teste',
        operatingSystem: 'sistema local',
        architecture: 'arquitetura local',
        cpuCount: 1,
        cpuModel: 'CPU teste',
        physicalCoreCount: 1,
        totalMemoryBytes: 8 * 1024 ** 3,
        postgresVersion: '17.1',
        localstackVersion: '4.0.0',
        dockerServerVersion: null,
        apiInstanceCount: 1,
        consumerCount: 1,
        publisherCount: 1,
      },
      results: [scenario],
      summaries: [summarizeScenarioResult(scenario)],
      integrityPassed: true,
      reportDirectory: 'artifacts/load-tests/execucao-teste',
      limitations: ['Medição local.'],
    };
    const markdown = formatMarkdownReport(report);
    expect(markdown).toContain('Concorrência na mesma carteira');
    expect(markdown).toContain('Média (ms)');
    expect(markdown).toContain('| Duração real (s) | Respostas HTTP | HTTP/s |');
    const resultRow = markdown.split('\n').find((line) =>
      line.startsWith('| Concorrência na mesma carteira |'),
    );
    expect(resultRow?.split('|')).toHaveLength(17);
    expect(markdown).toContain('Timeouts');
    expect(markdown).toContain('Verificações de integridade');
    expect(markdown).toContain('Medição local.');
    expect(markdown).toContain('CPU teste; núcleos físicos visíveis: 1; memória total do host: 8.00 GiB');
    expect(markdown).toContain('PostgreSQL:** 17.1; **LocalStack:** 4.0.0; **Docker servidor:** N/A');
    expect(markdown).toContain('1 instâncias da API, 1 consumers, 1 publishers');
  });

  test('conta núcleos físicos por socket e trata topologia ausente como desconhecida', () => {
    expect(parsePhysicalCoreCount('processor: 0\nphysical id: 0\ncore id: 0\n\nprocessor: 1\nphysical id: 0\ncore id: 0\n\nprocessor: 2\nphysical id: 1\ncore id: 0')).toBe(2);
    expect(parsePhysicalCoreCount('processor: 0\n')).toBeNull();
  });

  test('coleta versões disponíveis e preserva dados ausentes sem interromper a execução', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ version: '4.2.0:abcd' }) });
    try {
      const config = parseLoadTestArguments(['--api-instance-count', '1'], {}).config;
      const environment = await collectLoadTestEnvironment(config, async () => '17.2', server.url.toString());
      expect(environment.postgresVersion).toBe('17.2');
      expect(environment.localstackVersion).toBe('4.2.0:abcd');
      expect(environment.apiInstanceCount).toBe(1);
      expect(environment.consumerCount).toBeNull();
      const unavailable = await collectLoadTestEnvironment(config, async () => { throw new Error('indisponível'); }, 'http://127.0.0.1:1');
      expect(unavailable.postgresVersion).toBeNull();
      expect(unavailable.localstackVersion).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
