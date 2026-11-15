/** Esta página reúne os contratos internos usados pelo teste de carga. */
/** Esta página define os dados de configuração, amostras e relatórios do benchmark. */
import type { LatencyStatistics } from './metrics/latency.js';

export type LoadScenario = 'distributed' | 'contention' | 'idempotency' | 'outbox';

export interface LoadTestConfig {
  readonly apiUrls: readonly string[];
  readonly scenario: LoadScenario | 'all';
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly repetitions: number;
  readonly concurrencyLevels: readonly number[];
  readonly walletCount: number;
  readonly operationsPerWallet: number;
  readonly metricsIntervalSeconds: number;
  readonly httpTimeoutMilliseconds: number;
  readonly outboxDrainTimeoutSeconds: number;
  readonly confirmPersistentData: boolean;
}

export interface HttpMeasurement {
  readonly elapsedMilliseconds: number;
  readonly httpStatus: number | null;
  readonly transactionStatus?: string;
  readonly idempotentReplay?: boolean;
  readonly responseCode?: string;
  readonly errorKind?: 'timeout' | 'connection' | 'unexpected';
  readonly businessConflict?: boolean;
}

export interface PrometheusSample {
  readonly metric: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  readonly metricType?: 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';
}

export interface PrometheusSnapshot {
  readonly apiUrl: string;
  readonly capturedAt: string;
  readonly samples: readonly PrometheusSample[];
  readonly error?: string;
}

export interface OutboxSnapshot {
  readonly total: number;
  readonly published: number;
  readonly pending: number;
  readonly attempts: number;
  readonly oldestPendingAgeSeconds: number;
}

export interface IntegrityCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ScenarioResult {
  readonly scenario: LoadScenario;
  readonly repetition: number;
  readonly concurrency: number;
  readonly walletIds: readonly string[];
  readonly startedAt: string;
  readonly durationMilliseconds: number;
  readonly requests: readonly HttpMeasurement[];
  readonly metrics: readonly PrometheusSnapshot[];
  readonly prometheusCounters: Readonly<Record<string, number>>;
  readonly prometheusGauges: Readonly<Record<string, number>>;
  readonly outboxSamples: readonly OutboxSnapshot[];
  readonly integrity: readonly IntegrityCheck[];
  readonly expectedProcessed: number | null;
  readonly expectedRejected: number | null;
  readonly expectedReplays: number | null;
  readonly expectedConflicts: number | null;
  readonly outboxDrainMilliseconds: number | null;
  readonly error?: string;
}

export interface LoadTestEnvironment {
  readonly runtime: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly cpuCount: number;
}

export interface ScenarioMetricsSummary {
  readonly scenario: LoadScenario;
  readonly repetition: number;
  readonly concurrency: number;
  readonly durationMilliseconds: number;
  readonly requestCount: number;
  readonly httpCompleted: number;
  readonly http4xx: number;
  readonly http5xx: number;
  readonly timeoutCount: number;
  readonly connectionFailureCount: number;
  readonly unexpectedFailureCount: number;
  readonly operationalErrors: number;
  readonly operationalErrorRatePercent: number | null;
  readonly expectedIdempotencyConflicts: number;
  readonly financialProcessed: number;
  readonly businessRejected: number;
  readonly replays: number;
  readonly httpRequestsPerSecond: number | null;
  readonly financialOperationsPerSecond: number | null;
  readonly businessRejectionsPerSecond: number | null;
  readonly replaysPerSecond: number | null;
  readonly latencies: LatencyStatistics;
  readonly lockConflicts: number | null;
  readonly lockWaitCount: number | null;
  readonly lockWaitAverageMilliseconds: number | null;
  readonly prometheusUnavailableSnapshots: number;
  readonly outboxTotal: number | null;
  readonly outboxPublished: number | null;
  readonly outboxPending: number | null;
  readonly outboxAttempts: number | null;
  readonly outboxLagMaximumSeconds: number | null;
  readonly outboxDrainMilliseconds: number | null;
}

export interface LoadTestReport {
  readonly executionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly configuration: Omit<LoadTestConfig, 'confirmPersistentData'>;
  readonly environment: LoadTestEnvironment;
  readonly results: readonly ScenarioResult[];
  readonly summaries: readonly ScenarioMetricsSummary[];
  readonly integrityPassed: boolean;
  readonly reportDirectory: string;
  readonly limitations: readonly string[];
}

export interface LoadTestProgress {
  readonly executionId: string;
  readonly state: 'starting' | 'running' | 'completed' | 'failed';
  readonly message: string;
  readonly currentScenario?: LoadScenario;
  readonly currentRepetition?: number;
  readonly currentConcurrency?: number;
  readonly completedRequests?: number;
  readonly startedAt: string;
  readonly report?: LoadTestReport;
  readonly error?: string;
}
