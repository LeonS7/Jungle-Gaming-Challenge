/** Esta página executa os cenários de carga sobre os contratos HTTP reais. */
import { WageringApiClient, type ApiRequestResult, type WalletView, type WagerPayload } from '../api-client.js';
import { calculatePrometheusDelta, parsePrometheusText } from '../metrics/prometheus.js';
import { PostgresLoadTestReader } from '../validation/postgres-readonly.js';
import type {
  IntegrityCheck,
  LoadScenario,
  LoadTestConfig,
  OutboxSnapshot,
  PrometheusSnapshot,
  ScenarioResult,
} from '../types.js';

export interface TrialContext {
  readonly executionId: string;
  readonly providerId: string;
  readonly repetition: number;
  readonly concurrency: number;
  readonly config: LoadTestConfig;
  readonly api: WageringApiClient;
  readonly database: PostgresLoadTestReader;
  readonly onProgress?: (completedRequests: number) => void;
}

interface MeasuredResponse {
  readonly externalTransactionId: string;
  readonly result: ApiRequestResult<{ readonly status?: string; readonly idempotentReplay?: boolean; readonly code?: string }>;
}

interface TrialWorkload {
  readonly walletIds: readonly string[];
  readonly requiredExternalIds: readonly string[];
  readonly requests: readonly MeasuredResponse[];
  readonly expectedProcessed: number;
  readonly expectedRejected: number;
  readonly expectedReplays: number;
  readonly expectedConflicts: number;
}

interface PeriodicSampler<T> {
  readonly samples: T[];
  stop(): Promise<void>;
}

const WARMUP_REQUEST_LIMIT = 100;
const CENT_VALUE = 1n;
export const OUTBOX_MAX_OPERATIONS_PER_WALLET = 10;
export const OUTBOX_MAX_OPERATIONS = 120;

export function maximumOperationsForScenario(
  scenario: LoadScenario,
  walletCount: number,
  operationsPerWallet: number,
  outboxOperationsPerWallet = OUTBOX_MAX_OPERATIONS_PER_WALLET,
  outboxMaxOperations = OUTBOX_MAX_OPERATIONS,
): number {
  const configuredMaximum = walletCount * operationsPerWallet;
  if (scenario !== 'outbox') {
    return configuredMaximum;
  }
  return Math.min(
    configuredMaximum,
    walletCount * outboxOperationsPerWallet,
    outboxMaxOperations,
  );
}

function formatCents(cents: bigint): string {
  const digits = cents.toString().padStart(3, '0');
  return digits.slice(0, -2) + '.' + digits.slice(-2);
}

function trialPrefix(context: TrialContext, scenario: LoadScenario): string {
  return `${context.executionId}-${scenario}-r${context.repetition}-c${context.concurrency}`;
}

function makePayload(
  providerId: string,
  externalTransactionId: string,
  wallet: WalletView,
  kind: 'BET' | 'LOSS',
  amount: string,
): WagerPayload {
  return {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalTransactionId}`,
    gameId: 'load-test-local',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function createWallets(
  context: TrialContext,
  scenario: LoadScenario,
  count: number,
  amount: string,
): Promise<WalletView[]> {
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const playerId = `load-test:${context.executionId}:${scenario}:${context.repetition}:${context.concurrency}:${index}`;
    return context.api.createWallet(playerId, amount);
  }));
}

async function runFixedRequests(
  concurrency: number,
  request: (index: number) => Promise<MeasuredResponse>,
): Promise<MeasuredResponse[]> {
  const responses: MeasuredResponse[] = [];
  await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    responses.push(await request(index));
  }));
  return responses;
}

async function runBoundedRequests(
  context: TrialContext,
  maximumRequests: number,
  request: (index: number) => Promise<MeasuredResponse>,
): Promise<MeasuredResponse[]> {
  const responses: MeasuredResponse[] = [];
  const endsAt = Date.now() + context.config.durationSeconds * 1000;
  let nextIndex = 0;
  const workerCount = Math.min(context.concurrency, maximumRequests);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (Date.now() < endsAt && nextIndex < maximumRequests) {
      const index = nextIndex;
      nextIndex += 1;
      responses.push(await request(index));
      context.onProgress?.(responses.length);
    }
  }));
  return responses;
}

async function runWarmup(context: TrialContext, scenario: LoadScenario): Promise<{
  readonly wallet: WalletView | null;
  readonly successfulExternalIds: readonly string[];
  readonly failed: boolean;
}> {
  if (context.config.warmupSeconds === 0) {
    return { wallet: null, successfulExternalIds: [], failed: false };
  }
  const wallet = await context.api.createWallet(
    `load-test:${context.executionId}:${scenario}:warmup:${context.repetition}:${context.concurrency}`,
    '0.00',
  );
  const deadline = Date.now() + context.config.warmupSeconds * 1000;
  const requestLimit = Math.min(WARMUP_REQUEST_LIMIT, Math.max(10, context.concurrency * 2));
  const externalIds: string[] = [];
  let failed = false;
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(context.concurrency, requestLimit) }, async () => {
    while (Date.now() < deadline && nextIndex < requestLimit) {
      const index = nextIndex;
      nextIndex += 1;
      const externalId = `warmup-${trialPrefix(context, scenario)}-${index}`;
      const result = await context.api.submitWager(
        makePayload(context.providerId, externalId, wallet, 'LOSS', '0.01'),
        `${context.providerId}:${externalId}`,
      );
      if (result.statusCode === 200 && result.body?.status === 'PROCESSED') {
        externalIds.push(externalId);
      } else {
        failed = true;
      }
    }
  }));
  const remaining = deadline - Date.now();
  if (remaining > 0) {
    await Bun.sleep(remaining);
  }
  return { wallet, successfulExternalIds: externalIds, failed };
}

function startSampler<T>(
  intervalSeconds: number,
  capture: () => Promise<T>,
): PeriodicSampler<T> {
  const samples: T[] = [];
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeLoop: (() => void) | undefined;
  const loop = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wakeLoop = resolve;
        pendingTimer = setTimeout(resolve, intervalSeconds * 1000);
      });
      pendingTimer = undefined;
      wakeLoop = undefined;
      if (!stopped) {
        samples.push(await capture());
      }
    }
  })();
  return {
    samples,
    async stop() {
      stopped = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        wakeLoop?.();
      }
      await loop;
      samples.push(await capture());
    },
  };
}

async function capturePrometheus(context: TrialContext): Promise<PrometheusSnapshot[]> {
  return Promise.all(context.config.apiUrls.map(async (apiUrl) => {
    try {
      return {
        apiUrl,
        capturedAt: new Date().toISOString(),
        samples: parsePrometheusText(await context.api.readMetrics(apiUrl)),
      };
    } catch (error) {
      return {
        apiUrl,
        capturedAt: new Date().toISOString(),
        samples: [],
        error: error instanceof Error ? error.message : 'Não foi possível coletar métricas Prometheus.',
      };
    }
  }));
}

function countResponses(requests: readonly MeasuredResponse[]): {
  readonly processed: number;
  readonly rejected: number;
  readonly replays: number;
  readonly conflicts: number;
} {
  return {
    processed: requests.filter((request) =>
      request.result.statusCode === 200 &&
      request.result.body?.status === 'PROCESSED' &&
      request.result.body.idempotentReplay !== true,
    ).length,
    rejected: requests.filter((request) =>
      request.result.statusCode === 200 && request.result.body?.status === 'REJECTED',
    ).length,
    replays: requests.filter((request) =>
      request.result.statusCode === 200 && request.result.body?.idempotentReplay === true,
    ).length,
    conflicts: requests.filter((request) =>
      request.result.statusCode === 409 && request.result.body?.code === 'IDEMPOTENCY_CONFLICT',
    ).length,
  };
}

function addApiReconciliationChecks(
  checks: readonly IntegrityCheck[],
  successfulCount: number,
  walletCount: number,
): readonly IntegrityCheck[] {
  return [
    ...checks,
    {
      name: 'reconciliação pela API',
      passed: successfulCount === walletCount,
      detail: `${successfulCount} de ${walletCount} carteiras reconciliadas sem divergência pela API.`,
    },
  ];
}

async function reconcileAll(
  context: TrialContext,
  walletIds: readonly string[],
): Promise<number> {
  let completed = 0;
  let nextIndex = 0;
  const workerCount = Math.min(10, walletIds.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < walletIds.length) {
      const walletId = walletIds[nextIndex]!;
      nextIndex += 1;
      const reconciliation = await context.api.reconcile(walletId);
      if (reconciliation?.consistent) {
        completed += 1;
      }
    }
  }));
  return completed;
}

async function executeWorkload(
  context: TrialContext,
  scenario: LoadScenario,
  wallets: readonly WalletView[],
): Promise<TrialWorkload> {
  const prefix = trialPrefix(context, scenario);
  const requests: MeasuredResponse[] = [];
  const requiredExternalIds = new Set<string>();
  let expectedProcessed = 0;
  let expectedRejected = 0;
  let expectedReplays = 0;
  let expectedConflicts = 0;

  if (scenario === 'contention') {
    const wallet = wallets[0]!;
    requests.push(...await runFixedRequests(context.concurrency, async (index) => {
      const externalId = `${prefix}-bet-${index}`;
      const result = await context.api.submitWager(
        makePayload(context.providerId, externalId, wallet, 'BET', '80.00'),
        `${context.providerId}:${externalId}`,
      );
      if (result.statusCode === 200) {
        requiredExternalIds.add(externalId);
      }
      return { externalTransactionId: externalId, result };
    }));
    expectedProcessed = 1;
    expectedRejected = context.concurrency - 1;
  } else if (scenario === 'idempotency') {
    const wallet = wallets[0]!;
    const externalId = `${prefix}-same-operation`;
    const key = `${context.providerId}:${externalId}`;
    const original = makePayload(context.providerId, externalId, wallet, 'BET', '80.00');
    const samePayloadRequests = await runFixedRequests(context.concurrency, async () => {
      const result = await context.api.submitWager(original, key);
      if (result.statusCode === 200) {
        requiredExternalIds.add(externalId);
      }
      return { externalTransactionId: externalId, result };
    });
    const divergent = makePayload(context.providerId, externalId, wallet, 'BET', '81.00');
    const divergentPayloadRequests = await runFixedRequests(context.concurrency, async () => ({
      externalTransactionId: externalId,
      result: await context.api.submitWager(divergent, key),
    }));
    requests.push(...samePayloadRequests, ...divergentPayloadRequests);
    expectedProcessed = 1;
    expectedReplays = context.concurrency - 1;
    expectedConflicts = context.concurrency;
  } else {
    const maxOperations = maximumOperationsForScenario(
      scenario,
      context.config.walletCount,
      context.config.operationsPerWallet,
      context.config.outboxOperationsPerWallet,
      context.config.outboxMaxOperations,
    );
    requests.push(...await runBoundedRequests(context, maxOperations, async (index) => {
      const wallet = wallets[index % wallets.length]!;
      const externalId = `${prefix}-bet-${index}`;
      const result = await context.api.submitWager(
        makePayload(context.providerId, externalId, wallet, 'BET', '0.01'),
        `${context.providerId}:${externalId}`,
      );
      if (result.statusCode === 200) {
        requiredExternalIds.add(externalId);
      }
      return { externalTransactionId: externalId, result };
    }));
    expectedProcessed = requests.length;
  }

  if (scenario === 'outbox') {
    expectedProcessed = requests.length;
  }
  return {
    walletIds: wallets.map((wallet) => wallet.id),
    requiredExternalIds: [...requiredExternalIds],
    requests,
    expectedProcessed,
    expectedRejected,
    expectedReplays,
    expectedConflicts,
  };
}

function scenarioCheck(
  scenario: LoadScenario,
  actual: ReturnType<typeof countResponses>,
  expected: TrialWorkload,
): IntegrityCheck {
  const passed = actual.processed === expected.expectedProcessed &&
    actual.rejected === expected.expectedRejected &&
    actual.replays === expected.expectedReplays &&
    actual.conflicts === expected.expectedConflicts;
  return {
    name: `resultado esperado de ${scenario}`,
    passed,
    detail: `Processadas ${actual.processed}/${expected.expectedProcessed}; rejeitadas ${actual.rejected}/${expected.expectedRejected}; replays ${actual.replays}/${expected.expectedReplays}; conflitos ${actual.conflicts}/${expected.expectedConflicts}.`,
  };
}

async function waitForOutboxDrain(
  context: TrialContext,
  walletIds: readonly string[],
  samples: OutboxSnapshot[],
): Promise<number | null> {
  const startedAt = Date.now();
  const deadline = startedAt + context.config.outboxDrainTimeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const snapshot = await context.database.readOutbox(walletIds);
    samples.push(snapshot);
    if (snapshot.pending === 0) {
      return Date.now() - startedAt;
    }
    await Bun.sleep(500);
  }
  return null;
}

export async function executeScenarioTrial(
  context: TrialContext,
  scenario: LoadScenario,
): Promise<ScenarioResult> {
  const startedAt = new Date();
  let wallets: WalletView[];
  if (scenario === 'contention' || scenario === 'idempotency') {
    wallets = await createWallets(context, scenario, 1, '100.00');
  } else {
    const initialBalance = formatCents(BigInt(context.config.operationsPerWallet) * CENT_VALUE);
    wallets = await createWallets(context, scenario, context.config.walletCount, initialBalance);
  }

  const warmup = await runWarmup(context, scenario);
  const measuredWalletIds = [...wallets.map((wallet) => wallet.id)];
  if (warmup.wallet) {
    measuredWalletIds.push(warmup.wallet.id);
  }
  const allRequiredIds = [...warmup.successfulExternalIds];
  const beforeMetrics = await capturePrometheus(context);
  const beforeOutbox = await context.database.readOutbox(measuredWalletIds);
  const requestStartedAt = performance.now();
  const metricSamples = [...beforeMetrics];
  const outboxSamples = [beforeOutbox];
  const metricsSampler = startSampler(context.config.metricsIntervalSeconds, async () => {
    const snapshots = await capturePrometheus(context);
    metricSamples.push(...snapshots);
    return snapshots;
  });
  const outboxSampler = startSampler(context.config.metricsIntervalSeconds, async () => {
    const snapshot = await context.database.readOutbox(measuredWalletIds);
    outboxSamples.push(snapshot);
    return snapshot;
  });

  let workload: TrialWorkload;
  try {
    workload = await executeWorkload(context, scenario, wallets);
  } finally {
    await Promise.all([metricsSampler.stop(), outboxSampler.stop()]);
  }
  const measuredDuration = performance.now() - requestStartedAt;
  allRequiredIds.push(...workload.requiredExternalIds);
  const expected = {
    scenario,
    repetition: context.repetition,
    concurrency: context.concurrency,
    walletIds: measuredWalletIds,
    startedAt: startedAt.toISOString(),
    durationMilliseconds: measuredDuration,
    requests: workload.requests.map(({ result }) => result.measurement),
    metrics: metricSamples,
    outboxSamples,
    integrity: [] as readonly IntegrityCheck[],
    expectedProcessed: workload.expectedProcessed,
    expectedRejected: workload.expectedRejected,
    expectedReplays: workload.expectedReplays,
    expectedConflicts: workload.expectedConflicts,
    outboxDrainMilliseconds: null as number | null,
  };

  if (scenario === 'outbox') {
    expected.outboxDrainMilliseconds = await waitForOutboxDrain(
      context,
      measuredWalletIds,
      outboxSamples,
    );
  }

  const responseCounts = countResponses(workload.requests);
  const integrityChecks: IntegrityCheck[] = [scenarioCheck(scenario, responseCounts, workload)];
  if (warmup.failed) {
    integrityChecks.push({
      name: 'aquecimento concluído',
      passed: false,
      detail: 'Uma ou mais operações de aquecimento não foram processadas pela API.',
    });
  } else {
    integrityChecks.push({
      name: 'aquecimento concluído',
      passed: true,
      detail: `${warmup.successfulExternalIds.length} operação(ões) de aquecimento processada(s), fora das medições principais.`,
    });
  }
  if (scenario === 'outbox') {
    integrityChecks.push({
      name: 'outbox drenada',
      passed: expected.outboxDrainMilliseconds !== null,
      detail: expected.outboxDrainMilliseconds === null
        ? `A outbox não drenou em ${context.config.outboxDrainTimeoutSeconds} segundos.`
        : `A outbox drenou em ${expected.outboxDrainMilliseconds} ms.`,
    });
  }

  try {
    const financialSnapshot = await context.database.verifyWallets(measuredWalletIds, allRequiredIds);
    integrityChecks.push(...financialSnapshot.checks);
  } catch (error) {
    integrityChecks.push({
      name: 'verificação PostgreSQL',
      passed: false,
      detail: error instanceof Error ? error.message : 'Falha desconhecida ao validar o PostgreSQL.',
    });
  }
  try {
    const reconciled = await reconcileAll(context, measuredWalletIds);
    integrityChecks.push(...addApiReconciliationChecks([], reconciled, measuredWalletIds.length));
  } catch (error) {
    integrityChecks.push({
      name: 'reconciliação pela API',
      passed: false,
      detail: error instanceof Error ? error.message : 'Falha desconhecida ao consultar reconciliação.',
    });
  }

  const finalMetrics = await capturePrometheus(context);
  metricSamples.push(...finalMetrics);
  const metricDelta = calculatePrometheusDelta(beforeMetrics, finalMetrics);
  return {
    ...expected,
    metrics: metricSamples,
    prometheusCounters: metricDelta.counters,
    prometheusGauges: metricDelta.gauges,
    integrity: integrityChecks,
  };
}
