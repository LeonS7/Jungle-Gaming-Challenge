/** Esta página coordena preflight, cenários, integridade e relatórios do benchmark. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadApplicationConfig, type ApplicationConfig } from '../../src/config/application-config.js';
import {
  parseLoadTestArguments,
  LOAD_TEST_HELP,
  validateLocalDependencyTargets,
} from './config.js';
import { summarizeScenarioResult, writeLoadTestReport } from './reporting/reports.js';
import { WageringApiClient } from './api-client.js';
import { PostgresLoadTestReader } from './validation/postgres-readonly.js';
import { executeScenarioTrial } from './workloads/scenarios.js';
import type { LoadScenario, LoadTestConfig, LoadTestProgress, LoadTestReport, ScenarioResult } from './types.js';

const SCENARIOS: readonly LoadScenario[] = ['outbox', 'distributed', 'contention', 'idempotency'];

export interface LoadTestRunOptions {
  readonly config: LoadTestConfig;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (progress: LoadTestProgress) => void;
}

function scenariosFor(config: LoadTestConfig): readonly LoadScenario[] {
  return config.scenario === 'all' ? SCENARIOS : [config.scenario];
}

function createFailedResult(
  scenario: LoadScenario,
  repetition: number,
  concurrency: number,
  error: unknown,
): ScenarioResult {
  const detail = error instanceof Error ? error.message : 'Falha desconhecida durante o benchmark.';
  return {
    scenario,
    repetition,
    concurrency,
    walletIds: [],
    startedAt: new Date().toISOString(),
    durationMilliseconds: 0,
    requests: [],
    metrics: [],
    prometheusCounters: {},
    prometheusGauges: {},
    outboxSamples: [],
    integrity: [{ name: 'execução do cenário', passed: false, detail }],
    expectedProcessed: null,
    expectedRejected: null,
    expectedReplays: null,
    expectedConflicts: null,
    outboxDrainMilliseconds: null,
    error: detail,
  };
}

function publishProgress(
  options: LoadTestRunOptions,
  progress: LoadTestProgress,
): void {
  options.onProgress?.(progress);
}

export async function executeLoadTest(options: LoadTestRunOptions): Promise<LoadTestReport> {
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  let reportError: string | undefined;
  let database: PostgresLoadTestReader | undefined;
  publishProgress(options, {
    executionId,
    state: 'starting',
    message: 'Validando alvo local e dependências do benchmark.',
    startedAt,
  });

  try {
    if (!options.config.confirmPersistentData) {
      throw new Error('A criação de carteiras e lançamentos exige confirmação explícita.');
    }
    const applicationConfig: ApplicationConfig = loadApplicationConfig(options.environment);
    validateLocalDependencyTargets(
      applicationConfig.postgres.host,
      applicationConfig.sqs.endpoint,
    );
    for (const apiUrl of options.config.apiUrls) {
      await new WageringApiClient([apiUrl], options.config.httpTimeoutMilliseconds).checkAvailability();
    }
    database = await PostgresLoadTestReader.connect(applicationConfig);
    await database.checkConnection();

    const providerId = `load-${executionId}`;
    const api = new WageringApiClient(options.config.apiUrls, options.config.httpTimeoutMilliseconds);
    for (const scenario of scenariosFor(options.config)) {
      for (const concurrency of options.config.concurrencyLevels) {
        for (let repetition = 1; repetition <= options.config.repetitions; repetition += 1) {
          publishProgress(options, {
            executionId,
            state: 'running',
            message: `Executando ${scenario}, repetição ${repetition}, concorrência ${concurrency}.`,
            currentScenario: scenario,
            currentRepetition: repetition,
            currentConcurrency: concurrency,
            completedRequests: 0,
            startedAt,
          });
          try {
            results.push(await executeScenarioTrial({
              executionId,
              providerId,
              repetition,
              concurrency,
              config: options.config,
              api,
              database,
              onProgress: (completedRequests) => publishProgress(options, {
                executionId,
                state: 'running',
                message: `Executando ${scenario}, repetição ${repetition}, concorrência ${concurrency}.`,
                currentScenario: scenario,
                currentRepetition: repetition,
                currentConcurrency: concurrency,
                completedRequests,
                startedAt,
              }),
            }, scenario));
          } catch (error) {
            results.push(createFailedResult(scenario, repetition, concurrency, error));
            throw error;
          }
        }
      }
    }
  } catch (error) {
    reportError = error instanceof Error ? error.message : 'Falha desconhecida ao executar o benchmark.';
    if (results.length === 0) {
      const scenario = scenariosFor(options.config)[0] ?? 'distributed';
      results.push(createFailedResult(
        scenario,
        1,
        options.config.concurrencyLevels[0] ?? 1,
        error,
      ));
    }
  } finally {
    if (database) {
      await database.close();
    }
  }

  const report = await writeLoadTestReport(executionId, startedAt, options.config, results, reportError);
  publishProgress(options, {
    executionId,
    state: report.integrityPassed ? 'completed' : 'failed',
    message: report.integrityPassed
      ? 'Benchmark concluído; integridade financeira aprovada.'
      : 'Benchmark concluído com falha ou inconsistência; consulte o relatório.',
    startedAt,
    report,
    ...(reportError ? { error: reportError } : {}),
  });
  return report;
}

async function confirmPersistentRecords(): Promise<boolean> {
  if (!stdin.isTTY) {
    throw new Error('O benchmark grava carteiras e transações permanentes. Revise o aviso e execute novamente com --yes para confirmar.');
  }
  const interfaceReadline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await interfaceReadline.question(
      'O benchmark criará carteiras, transações, ledger e eventos permanentes no PostgreSQL local. Continuar? (s/N) ',
    );
    return answer.trim().toLowerCase() === 's';
  } finally {
    interfaceReadline.close();
  }
}

function printSummary(report: LoadTestReport): void {
  console.log(`Execução: ${report.executionId}`);
  console.log(`Integridade financeira: ${report.integrityPassed ? 'aprovada' : 'falhou'}`);
  console.log(`Relatório JSON: ${report.reportDirectory}/summary.json`);
  console.log(`Relatório Markdown: ${report.reportDirectory}/report.md`);
  for (const result of report.results) {
    const failures = result.integrity.filter((item) => !item.passed).length;
    console.log(
      `${result.scenario} c=${result.concurrency} repetição=${result.repetition}: ` +
      `${result.requests.length} chamadas, ${failures} verificação(ões) falharam.`,
    );
  }
}

async function main(): Promise<void> {
  const parsed = parseLoadTestArguments(Bun.argv.slice(2));
  if (parsed.helpRequested) {
    console.log(LOAD_TEST_HELP);
    return;
  }
  if (parsed.config.scenario === 'all') {
    console.log('O modo completo executará os quatro cenários nos níveis de concorrência configurados.');
  }
  const confirmed = parsed.config.confirmPersistentData || await confirmPersistentRecords();
  if (!confirmed) {
    console.log('Execução cancelada; nenhum cenário foi iniciado.');
    return;
  }
  const config = { ...parsed.config, confirmPersistentData: true };
  let lastProgressAt = 0;
  let lastProgressState = '';
  const report = await executeLoadTest({
    config,
    environment: process.env,
    onProgress(progress) {
      const stateKey = `${progress.state}:${progress.currentScenario ?? ''}:${progress.currentRepetition ?? ''}:${progress.currentConcurrency ?? ''}`;
      const now = Date.now();
      if (stateKey === lastProgressState && now - lastProgressAt < 1000) {
        return;
      }
      lastProgressAt = now;
      lastProgressState = stateKey;
      const reportSummary = progress.report
        ? {
            integrityPassed: progress.report.integrityPassed,
            reportDirectory: progress.report.reportDirectory,
            results: progress.report.results.map((result) => ({
              ...summarizeScenarioResult(result),
              scenario: result.scenario,
              repetition: result.repetition,
              concurrency: result.concurrency,
              outboxDrainMilliseconds: result.outboxDrainMilliseconds,
              passedChecks: result.integrity.filter((item) => item.passed).length,
              failedChecks: result.integrity.filter((item) => !item.passed).map((item) => `${item.name}: ${item.detail}`),
              ...(result.error ? { error: result.error } : {}),
            })),
            markdownUrl: `/__local-load-test/reports/${progress.executionId}/report.md`,
            jsonUrl: `/__local-load-test/reports/${progress.executionId}/summary.json`,
          }
        : undefined;
      console.log('LOAD_TEST_EVENT ' + JSON.stringify({
        executionId: progress.executionId,
        state: progress.state,
        message: progress.message,
        ...(progress.currentScenario ? { currentScenario: progress.currentScenario } : {}),
        ...(progress.currentRepetition !== undefined ? { currentRepetition: progress.currentRepetition } : {}),
        ...(progress.currentConcurrency !== undefined ? { currentConcurrency: progress.currentConcurrency } : {}),
        ...(progress.completedRequests !== undefined ? { completedRequests: progress.completedRequests } : {}),
        startedAt: progress.startedAt,
        ...(progress.error ? { error: progress.error } : {}),
        ...(reportSummary ? { report: reportSummary } : {}),
      }));
    },
  });
  printSummary(report);
  if (!report.integrityPassed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Falha desconhecida no runner de carga.');
    process.exitCode = 1;
  });
}
