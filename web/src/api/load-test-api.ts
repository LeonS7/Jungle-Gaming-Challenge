/** Esta página consome o controle local do benchmark disponível no Vite de desenvolvimento. */
export interface LoadTestFormValues {
  readonly scenario: 'all' | 'distributed' | 'contention' | 'idempotency' | 'outbox';
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly repetitions: number;
  readonly concurrencyLevels: readonly number[];
  readonly walletCount: number;
  readonly operationsPerWallet: number;
  readonly metricsIntervalSeconds: number;
  readonly httpTimeoutMilliseconds: number;
  readonly outboxDrainTimeoutSeconds: number;
}

export interface LoadTestScenarioSummary {
  readonly scenario: string;
  readonly repetition: number;
  readonly concurrency: number;
  readonly httpCompleted: number;
  readonly http4xx: number;
  readonly http5xx: number;
  readonly operationalErrors: number;
  readonly expectedIdempotencyConflicts: number;
  readonly financialProcessed: number;
  readonly businessRejected: number;
  readonly replays: number;
  readonly httpRequestsPerSecond: number | null;
  readonly financialOperationsPerSecond: number | null;
  readonly businessRejectionsPerSecond: number | null;
  readonly replaysPerSecond: number | null;
  readonly operationalErrorRatePercent: number | null;
  readonly latencies: {
    readonly count: number;
    readonly minimumMilliseconds: number | null;
    readonly maximumMilliseconds: number | null;
    readonly meanMilliseconds: number | null;
    readonly p50Milliseconds: number | null;
    readonly p95Milliseconds: number | null;
    readonly p99Milliseconds: number | null;
  };
  readonly lockConflicts: number | null;
  readonly lockWaitAverageMilliseconds: number | null;
  readonly prometheusUnavailableSnapshots: number;
  readonly outboxTotal: number | null;
  readonly outboxPublished: number | null;
  readonly outboxPending: number | null;
  readonly outboxAttempts: number | null;
  readonly outboxLagMaximumSeconds: number | null;
  readonly outboxDrainMilliseconds: number | null;
  readonly passedChecks: number;
  readonly failedChecks: readonly string[];
  readonly error?: string;
}

export interface LoadTestProgress {
  readonly executionId: string;
  readonly state: 'starting' | 'running' | 'completed' | 'failed';
  readonly message: string;
  readonly currentScenario?: string;
  readonly currentRepetition?: number;
  readonly currentConcurrency?: number;
  readonly completedRequests?: number;
  readonly startedAt: string;
  readonly error?: string;
  readonly report?: {
    readonly integrityPassed: boolean;
    readonly reportDirectory: string;
    readonly results: readonly LoadTestScenarioSummary[];
    readonly markdownUrl: string;
    readonly jsonUrl: string;
  };
}

export interface LoadTestAvailability {
  readonly available: boolean;
  readonly mode: string;
  readonly message: string;
}

export class LoadTestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LoadTestApiError';
  }
}

const CONTROL_URL = '/__local-load-test';
const REQUEST_TIMEOUT_MILLISECONDS = 3_000;

async function readResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    throw new LoadTestApiError('O controle local retornou uma resposta inválida.', response.status);
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body
      ? String(body.message)
      : 'Não foi possível concluir a ação do benchmark local.';
    throw new LoadTestApiError(message, response.status);
  }
  return body as T;
}

export async function readLoadTestAvailability(): Promise<LoadTestAvailability> {
  const response = await fetch(`${CONTROL_URL}/availability`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  return readResponse<LoadTestAvailability>(response);
}

export async function startLoadTest(values: LoadTestFormValues): Promise<LoadTestProgress> {
  const response = await fetch(`${CONTROL_URL}/runs`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-load-test-confirmed': 'true',
    },
    body: JSON.stringify({ ...values, confirmedPersistentData: true }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  return readResponse<LoadTestProgress>(response);
}

export async function readLoadTestProgress(executionId: string): Promise<LoadTestProgress> {
  const response = await fetch(
    `${CONTROL_URL}/status?executionId=${encodeURIComponent(executionId)}`,
    {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    },
  );
  return readResponse<LoadTestProgress>(response);
}
