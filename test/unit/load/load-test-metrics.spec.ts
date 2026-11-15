/** Esta página verifica percentis e deltas das métricas operacionais coletadas. */
import { describe, expect, test } from 'bun:test';
import { calculateLatencyStatistics } from '../../../test/load/metrics/latency.js';
import { calculatePrometheusDelta, parsePrometheusText } from '../../../test/load/metrics/prometheus.js';
import type { PrometheusSnapshot } from '../../../test/load/types.js';

describe('estatísticas de latência medidas', () => {
  test('calcula média, extremos e percentis pelo método nearest-rank', () => {
    expect(calculateLatencyStatistics([1, 2, 3, 4, 100])).toEqual({
      count: 5,
      minimumMilliseconds: 1,
      maximumMilliseconds: 100,
      meanMilliseconds: 22,
      p50Milliseconds: 3,
      p95Milliseconds: 100,
      p99Milliseconds: 100,
    });
  });

  test('não inventa métricas quando não há amostras válidas', () => {
    expect(calculateLatencyStatistics([])).toEqual({
      count: 0,
      minimumMilliseconds: null,
      maximumMilliseconds: null,
      meanMilliseconds: null,
      p50Milliseconds: null,
      p95Milliseconds: null,
      p99Milliseconds: null,
    });
    expect(calculateLatencyStatistics([Number.NaN, -1]).p99Milliseconds).toBeNull();
  });
});

describe('coleta Prometheus', () => {
  test('interpreta nomes e labels sem aceitar linhas malformadas', () => {
    expect(parsePrometheusText([
      '# HELP wagering_transactions_total exemplo',
      '# TYPE wagering_transactions_total counter',
      'wagering_transactions_total{status="PROCESSED"} 12',
      '# TYPE outbox_lag_seconds gauge',
      'outbox_lag_seconds 1.25',
      'linha_invalida',
      'wagering_transactions_total{status="BROKEN"} NaN',
    ].join('\n'))).toEqual([
      { metric: 'wagering_transactions_total', labels: { status: 'PROCESSED' }, value: 12, metricType: 'counter' },
      { metric: 'outbox_lag_seconds', labels: {}, value: 1.25, metricType: 'gauge' },
    ]);
  });

  test('subtrai counters por instância e mantém gauges como máximo observado', () => {
    const before: PrometheusSnapshot[] = [
      { apiUrl: 'http://127.0.0.1:3000', capturedAt: 'antes', samples: [
        { metric: 'wagering_duplicates_total', labels: { source: 'idempotency' }, value: 8 },
        { metric: 'outbox_lag_seconds', labels: {}, value: 3 },
      ] },
      { apiUrl: 'http://127.0.0.1:3001', capturedAt: 'antes', samples: [
        { metric: 'wagering_duplicates_total', labels: { source: 'idempotency' }, value: 4 },
        { metric: 'outbox_lag_seconds', labels: {}, value: 5 },
      ] },
    ];
    const after: PrometheusSnapshot[] = [
      { apiUrl: 'http://127.0.0.1:3000', capturedAt: 'depois', samples: [
        { metric: 'wagering_duplicates_total', labels: { source: 'idempotency' }, value: 10 },
        { metric: 'outbox_lag_seconds', labels: {}, value: 6 },
      ] },
      { apiUrl: 'http://127.0.0.1:3001', capturedAt: 'depois', samples: [
        { metric: 'wagering_duplicates_total', labels: { source: 'idempotency' }, value: 7 },
        { metric: 'outbox_lag_seconds', labels: {}, value: 2 },
      ] },
    ];

    const delta = calculatePrometheusDelta(before, after);
    expect(delta.counters).toEqual({
      'wagering_duplicates_total[["source","idempotency"]]': 5,
    });
    expect(delta.gauges).toEqual({ outbox_lag_seconds: 6 });
  });

  test('trata reinício de contador como trecho novo após a reinicialização', () => {
    const before: PrometheusSnapshot[] = [{
      apiUrl: 'http://127.0.0.1:3000', capturedAt: 'antes',
      samples: [{ metric: 'wagering_retries_total', labels: { source: 'sqs' }, value: 10 }],
    }];
    const after: PrometheusSnapshot[] = [{
      apiUrl: 'http://127.0.0.1:3000', capturedAt: 'depois',
      samples: [{ metric: 'wagering_retries_total', labels: { source: 'sqs' }, value: 2 }],
    }];
    expect(calculatePrometheusDelta(before, after).counters[
      'wagering_retries_total[["source","sqs"]]'
    ]).toBe(2);
  });
});
