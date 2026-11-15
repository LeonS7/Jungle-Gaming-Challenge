/** Esta página gera relatórios exclusivos com medições observadas pelo runner. */
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, arch, platform } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateLatencyStatistics } from '../metrics/latency.js';
import type {
  LoadTestConfig,
  LoadTestEnvironment,
  LoadTestReport,
  ScenarioMetricsSummary,
  ScenarioResult,
} from '../types.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function numberText(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? 'N/A' : value.toFixed(digits);
}

function scenarioName(scenario: string): string {
  const names: Readonly<Record<string, string>> = {
    distributed: 'Carteiras distribuídas',
    contention: 'Concorrência na mesma carteira',
    idempotency: 'Idempotência sob carga',
    outbox: 'Pressão e drenagem da outbox',
  };
  return names[scenario] ?? scenario;
}

function sumCounter(result: ScenarioResult, metric: string): number {
  return Object.entries(result.prometheusCounters)
    .filter(([key]) => key.startsWith(metric))
    .reduce((total, [, value]) => total + value, 0);
}

export function summarizeScenarioResult(result: ScenarioResult): ScenarioMetricsSummary {
  const requests = result.requests;
  const latencies = calculateLatencyStatistics(
    requests
      .filter((request) => request.httpStatus !== null)
      .map((request) => request.elapsedMilliseconds),
  );
  const httpCompleted = requests.filter((request) => request.httpStatus !== null).length;
  const http4xx = requests.filter((request) =>
    request.httpStatus !== null && request.httpStatus >= 400 && request.httpStatus < 500,
  ).length;
  const http5xx = requests.filter((request) => request.httpStatus !== null && request.httpStatus >= 500).length;
  const expectedIdempotencyConflicts = requests.filter((request) =>
    request.httpStatus === 409 && request.responseCode === 'IDEMPOTENCY_CONFLICT',
  ).length;
  const operationalErrors = requests.filter((request) =>
    request.errorKind !== undefined ||
    request.httpStatus !== null && request.httpStatus >= 500 ||
    request.httpStatus !== null && request.httpStatus >= 400 && request.httpStatus < 500 &&
      !(request.httpStatus === 409 && request.responseCode === 'IDEMPOTENCY_CONFLICT'),
  ).length;
  const financialProcessed = requests.filter((request) =>
    request.transactionStatus === 'PROCESSED' && request.idempotentReplay !== true,
  ).length;
  const businessRejected = requests.filter((request) => request.transactionStatus === 'REJECTED').length;
  const replays = requests.filter((request) => request.idempotentReplay === true).length;
  const timeoutCount = requests.filter((request) => request.errorKind === 'timeout').length;
  const connectionFailureCount = requests.filter((request) => request.errorKind === 'connection').length;
  const unexpectedFailureCount = requests.filter((request) => request.errorKind === 'unexpected').length;
  const durationSeconds = result.durationMilliseconds / 1000;
  const outboxLagMaximum = result.outboxSamples.length > 0
    ? Math.max(...result.outboxSamples.map((sample) => sample.oldestPendingAgeSeconds))
    : null;
  const lastOutbox = result.outboxSamples.at(-1);
  const lockWaitCount = sumCounter(result, 'wagering_wallet_lock_acquisition_seconds_count');
  const lockWaitSum = sumCounter(result, 'wagering_wallet_lock_acquisition_seconds_sum');
  const unavailableSnapshotCount = result.metrics.filter((snapshot) =>
    snapshot.error !== undefined || snapshot.samples.length === 0,
  ).length;
  const prometheusUnavailableSnapshots = result.metrics.length === 0
    ? 1
    : unavailableSnapshotCount;
  const prometheusMetricsComplete = result.metrics.length > 0 && unavailableSnapshotCount === 0;

  return {
    scenario: result.scenario,
    repetition: result.repetition,
    concurrency: result.concurrency,
    durationMilliseconds: result.durationMilliseconds,
    requestCount: requests.length,
    httpCompleted,
    http4xx,
    http5xx,
    timeoutCount,
    connectionFailureCount,
    unexpectedFailureCount,
    operationalErrors,
    expectedIdempotencyConflicts,
    financialProcessed,
    businessRejected,
    replays,
    httpRequestsPerSecond: durationSeconds > 0 ? httpCompleted / durationSeconds : null,
    financialOperationsPerSecond: durationSeconds > 0 ? financialProcessed / durationSeconds : null,
    businessRejectionsPerSecond: durationSeconds > 0 ? businessRejected / durationSeconds : null,
    replaysPerSecond: durationSeconds > 0 ? replays / durationSeconds : null,
    operationalErrorRatePercent: requests.length > 0 ? operationalErrors * 100 / requests.length : null,
    latencies,
    lockConflicts: prometheusMetricsComplete ? sumCounter(result, 'wagering_lock_conflicts_total') : null,
    lockWaitCount: prometheusMetricsComplete ? lockWaitCount : null,
    lockWaitAverageMilliseconds: prometheusMetricsComplete && lockWaitCount > 0 ? lockWaitSum * 1000 / lockWaitCount : null,
    prometheusUnavailableSnapshots,
    outboxTotal: lastOutbox?.total ?? null,
    outboxPublished: lastOutbox?.published ?? null,
    outboxPending: lastOutbox?.pending ?? null,
    outboxAttempts: lastOutbox?.attempts ?? null,
    outboxLagMaximumSeconds: outboxLagMaximum,
    outboxDrainMilliseconds: result.outboxDrainMilliseconds,
  };
}

export function createLoadTestEnvironment(): LoadTestEnvironment {
  return {
    runtime: `Bun ${Bun.version}`,
    operatingSystem: platform(),
    architecture: arch(),
    cpuCount: cpus().length,
  };
}

export function formatMarkdownReport(report: LoadTestReport): string {
  const rows = report.summaries.map((summary) =>
    `| ${scenarioName(summary.scenario)} | ${summary.repetition} | ${summary.concurrency} | ${numberText(summary.durationMilliseconds / 1000)} | ${summary.httpCompleted} | ${numberText(summary.httpRequestsPerSecond)} | ${numberText(summary.financialOperationsPerSecond)} | ${numberText(summary.businessRejectionsPerSecond)} | ${numberText(summary.replaysPerSecond)} | ${numberText(summary.latencies.minimumMilliseconds)} | ${numberText(summary.latencies.meanMilliseconds)} | ${numberText(summary.latencies.maximumMilliseconds)} | ${numberText(summary.latencies.p50Milliseconds)} | ${numberText(summary.latencies.p95Milliseconds)} | ${numberText(summary.latencies.p99Milliseconds)} |`,
  );
  const diagnosticRows = report.summaries.map((summary) =>
    `| ${scenarioName(summary.scenario)} / ${summary.repetition} / ${summary.concurrency} | ${summary.http4xx} | ${summary.http5xx} | ${summary.timeoutCount} | ${summary.connectionFailureCount} | ${summary.unexpectedFailureCount} | ${numberText(summary.operationalErrorRatePercent)}% | ${summary.expectedIdempotencyConflicts} | ${summary.lockConflicts ?? 'N/A'} | ${summary.prometheusUnavailableSnapshots} | ${numberText(summary.lockWaitAverageMilliseconds)} | ${summary.outboxTotal ?? 'N/A'} | ${summary.outboxPublished ?? 'N/A'} | ${summary.outboxPending ?? 'N/A'} | ${summary.outboxAttempts ?? 'N/A'} | ${numberText(summary.outboxLagMaximumSeconds)} | ${numberText(summary.outboxDrainMilliseconds)} |`,
  );
  const integrityRows = report.results.flatMap((result) => result.integrity.map((item) =>
    `| ${scenarioName(result.scenario)} / ${result.repetition} / ${result.concurrency} | ${item.passed ? 'Aprovado' : 'Falhou'} | ${item.name} | ${item.detail.replaceAll('|', '\\|')} |`,
  ));
  const failedResults = report.results.filter((result) => result.error);

  return `# Relatório de teste de carga

- **Execução:** \`${report.executionId}\`
- **Início:** ${report.startedAt}
- **Fim:** ${report.finishedAt}
- **Resultado de integridade:** ${report.integrityPassed ? 'Aprovado' : 'Falhou'}
- **Ambiente de execução:** ${report.environment.runtime}
- **Sistema:** ${report.environment.operatingSystem} / ${report.environment.architecture}, ${report.environment.cpuCount} CPUs lógicas
- **API local:** ${report.configuration.apiUrls.join(', ')}

## Metodologia

As latências são medidas com \`performance.now()\` ao redor de cada chamada HTTP concluída. p50, p95 e p99 usam o método nearest-rank: ordenar as amostras e selecionar a posição \`ceil(p × n)\`, com índice mínimo 1. As taxas usam o tempo observado da execução principal. Replays e rejeições de negócio são exibidos separadamente de erros operacionais.

O runner coleta Prometheus antes, durante e depois de cada cenário. Contadores são apresentados como deltas; gauges não são somados entre instâncias. A espera média pelo lock é derivada do delta \`sum/count\` do histograma existente. O atraso da outbox também é consultado no PostgreSQL para as carteiras desta execução.

## Configuração

| Opção | Valor |
|---|---|
| Cenário | ${report.configuration.scenario} |
| Duração máxima por cenário | ${report.configuration.durationSeconds} s |
| Aquecimento | ${report.configuration.warmupSeconds} s |
| Repetições | ${report.configuration.repetitions} |
| Concorrências | ${report.configuration.concurrencyLevels.join(', ')} |
| Carteiras distribuídas | ${report.configuration.walletCount} |
| Operações máximas por carteira | ${report.configuration.operationsPerWallet} |
| Intervalo de métricas | ${report.configuration.metricsIntervalSeconds} s |
| Timeout HTTP | ${report.configuration.httpTimeoutMilliseconds} ms |
| Timeout de drenagem | ${report.configuration.outboxDrainTimeoutSeconds} s |

## Resultados

| Cenário | Repetição | Concorrência | Duração real (s) | Respostas HTTP | HTTP/s | Financeiras/s | Rejeições/s | Replays/s | Mín. (ms) | Média (ms) | Máx. (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

O throughput HTTP considera respostas recebidas, incluindo respostas 4xx/5xx. O throughput financeiro conta respostas \`PROCESSED\` sem replay; \`REJECTED\` e replays idempotentes têm taxas separadas. Rejeições por saldo insuficiente não são erros operacionais.

### Diagnóstico de erros, concorrência e outbox

| Cenário / repetição / concorrência | 4xx | 5xx | Timeouts | Falhas de conexão | Erros inesperados | Taxa operacional (%) | Conflitos de idempotência | Conflitos de lock | Coletas Prometheus indisponíveis | Espera média de lock (ms) | Eventos da outbox | Publicados | Pendentes | Tentativas | Atraso máximo (s) | Drenagem (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${diagnosticRows.join('\n')}

## Verificações de integridade

| Execução | Resultado | Verificação | Evidência |
|---|---|---|---|
${integrityRows.join('\n') || '| N/A | N/A | Nenhuma execução concluída | N/A |'}

${failedResults.length > 0 ? `## Falhas durante a preparação ou execução\n\n${failedResults.map((result) => `- ${scenarioName(result.scenario)}, repetição ${result.repetition}, concorrência ${result.concurrency}: ${result.error}`).join('\n')}\n` : ''}
## Limitações

${report.limitations.map((item) => `- ${item}`).join('\n')}

Os registros financeiros criados permanecem no PostgreSQL. O relatório não contém credenciais nem apaga carteiras, transações, ledger ou eventos.
`;
}

export async function writeLoadTestReport(
  executionId: string,
  startedAt: string,
  config: LoadTestConfig,
  results: readonly ScenarioResult[],
  error?: string,
): Promise<LoadTestReport> {
  const finishedAt = new Date().toISOString();
  const reportDirectory = resolve(REPOSITORY_ROOT, 'artifacts', 'load-tests', executionId);
  await mkdir(dirname(reportDirectory), { recursive: true });
  await mkdir(reportDirectory, { recursive: false });
  const report: LoadTestReport = {
    executionId,
    startedAt,
    finishedAt,
    configuration: {
      apiUrls: config.apiUrls,
      scenario: config.scenario,
      durationSeconds: config.durationSeconds,
      warmupSeconds: config.warmupSeconds,
      repetitions: config.repetitions,
      concurrencyLevels: config.concurrencyLevels,
      walletCount: config.walletCount,
      operationsPerWallet: config.operationsPerWallet,
      metricsIntervalSeconds: config.metricsIntervalSeconds,
      httpTimeoutMilliseconds: config.httpTimeoutMilliseconds,
      outboxDrainTimeoutSeconds: config.outboxDrainTimeoutSeconds,
    },
    environment: createLoadTestEnvironment(),
    results,
    summaries: results.map(summarizeScenarioResult),
    integrityPassed: error === undefined && results.length > 0 && results.every((result) =>
      result.integrity.every((item) => item.passed) && result.error === undefined,
    ),
    reportDirectory: relative(REPOSITORY_ROOT, reportDirectory).replaceAll('\\', '/'),
    limitations: [
      'O experimento usa apenas endereços HTTP de loopback e depende dos recursos desta máquina.',
      'As métricas Prometheus são locais a cada instância; contadores são comparados por URL e gauges não são somados.',
      'LocalStack e PostgreSQL locais não representam latência, disponibilidade ou capacidade garantida da AWS e do ambiente de produção.',
      'Nenhum alvo ou meta de RPS é presumido; os números descrevem somente as amostras registradas nesta execução.',
      ...(results.some((result) => result.metrics.length === 0 || result.metrics.some((snapshot) => snapshot.error !== undefined || snapshot.samples.length === 0))
        ? ['Uma ou mais coletas Prometheus ficaram indisponíveis; as métricas afetadas são apresentadas como N/A e os detalhes permanecem no JSON.']
        : []),
      ...(error ? [`A execução terminou com falha: ${error}`] : []),
    ],
  };
  const jsonPath = resolve(reportDirectory, 'summary.json');
  const markdownPath = resolve(reportDirectory, 'report.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(markdownPath, formatMarkdownReport(report), { flag: 'wx' });
  return report;
}
