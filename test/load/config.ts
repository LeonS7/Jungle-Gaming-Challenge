/** Esta página interpreta e valida as opções seguras do benchmark local. */
import type { LoadScenario, LoadTestConfig } from './types.js';

export class InvalidLoadTestConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLoadTestConfigurationError';
  }
}

export const LOAD_TEST_HELP = `Teste de carga local do processador de apostas

Uso: bun run test:load [opções]

Opções:
  --api-url URL                    Uma ou mais URLs locais separadas por vírgula
  --scenario NOME                  all, distributed, contention, idempotency ou outbox
  --duration-seconds N             Duração máxima por execução (padrão: 10)
  --warmup-seconds N               Aquecimento excluído das métricas principais (padrão: 2)
  --repetitions N                  Repetições por nível de concorrência (padrão: 1)
  --concurrency N,N,...            Níveis de concorrência (padrão: 10,25,50)
  --wallet-count N                 Carteiras distribuídas (padrão: 12)
  --operations-per-wallet N        Limite de operações por carteira (padrão: 100)
  --metrics-interval-seconds N     Intervalo de coleta (padrão: 5)
  --http-timeout-ms N              Timeout HTTP (padrão: 10000)
  --outbox-drain-timeout-seconds N Limite para drenagem da outbox (padrão: 60)
  --yes                            Confirma a criação de registros financeiros locais
  --help                           Mostra esta ajuda

O runner aceita somente API, PostgreSQL e SQS em localhost, 127.0.0.1 ou ::1.
As operações e o ledger permanecem no banco; nenhum relatório é sobrescrito e nenhum dado é apagado.`;

const SCENARIOS = new Set<LoadScenario | 'all'>([
  'all',
  'distributed',
  'contention',
  'idempotency',
  'outbox',
]);

type Environment = Readonly<Record<string, string | undefined>>;

function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidLoadTestConfigurationError(`${name} deve ser um inteiro positivo.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvalidLoadTestConfigurationError(
      `${name} deve estar entre ${minimum} e ${maximum}.`,
    );
  }
  return parsed;
}

function readOption(
  args: readonly string[],
  index: number,
  inlineValue: string | undefined,
  name: string,
): string {
  const value = inlineValue ?? args[index + 1];
  if (value === undefined || value.length === 0 || (inlineValue === undefined && value.startsWith('--'))) {
    throw new InvalidLoadTestConfigurationError(`Informe um valor para ${name}.`);
  }
  return value;
}

function isLocalAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function validateLocalHttpUrl(value: string, serviceName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidLoadTestConfigurationError(`A URL de ${serviceName} não é válida.`);
  }
  if (
    parsed.protocol !== 'http:' ||
    !isLocalAddress(parsed.hostname) ||
    parsed.pathname !== '/' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new InvalidLoadTestConfigurationError(
      `O benchmark só aceita HTTP local para ${serviceName}, sem credenciais, parâmetros ou fragmentos.`,
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

export function validateLocalApiUrl(value: string): string {
  return validateLocalHttpUrl(value, 'a API');
}

export function validateLocalDependencyTargets(
  databaseHost: string,
  sqsEndpoint: string,
): void {
  if (!isLocalAddress(databaseHost.trim())) {
    throw new InvalidLoadTestConfigurationError(
      'O benchmark só aceita um PostgreSQL local em localhost, 127.0.0.1 ou ::1.',
    );
  }
  validateLocalHttpUrl(sqsEndpoint, 'o endpoint SQS');
}

function defaults(environment: Environment): LoadTestConfig {
  const rawScenario = environment.LOAD_TEST_SCENARIO ?? 'all';
  if (!SCENARIOS.has(rawScenario as LoadScenario | 'all')) {
    throw new InvalidLoadTestConfigurationError('LOAD_TEST_SCENARIO não é um cenário conhecido.');
  }
  const rawConcurrency = environment.LOAD_TEST_CONCURRENCY ?? '10,25,50';
  const concurrencyLevels = rawConcurrency.split(',').map((value) =>
    parseInteger(value.trim(), 'concorrência', 1, 200),
  );
  const apiUrls = (environment.LOAD_TEST_API_URL ?? 'http://127.0.0.1:3000')
    .split(',')
    .map((value) => validateLocalApiUrl(value.trim()));

  return {
    apiUrls: [...new Set(apiUrls)],
    scenario: rawScenario as LoadScenario | 'all',
    durationSeconds: parseInteger(environment.LOAD_TEST_DURATION_SECONDS ?? '10', 'duração', 1, 3600),
    warmupSeconds: parseInteger(environment.LOAD_TEST_WARMUP_SECONDS ?? '2', 'aquecimento', 0, 300),
    repetitions: parseInteger(environment.LOAD_TEST_REPETITIONS ?? '1', 'repetições', 1, 10),
    concurrencyLevels: [...new Set(concurrencyLevels)],
    walletCount: parseInteger(environment.LOAD_TEST_WALLET_COUNT ?? '12', 'wallet-count', 1, 250),
    operationsPerWallet: parseInteger(
      environment.LOAD_TEST_OPERATIONS_PER_WALLET ?? '100',
      'operations-per-wallet',
      1,
      100_000,
    ),
    metricsIntervalSeconds: parseInteger(
      environment.LOAD_TEST_METRICS_INTERVAL_SECONDS ?? '5',
      'metrics-interval-seconds',
      1,
      3600,
    ),
    httpTimeoutMilliseconds: parseInteger(
      environment.LOAD_TEST_HTTP_TIMEOUT_MS ?? '10000',
      'http-timeout-ms',
      100,
      120_000,
    ),
    outboxDrainTimeoutSeconds: parseInteger(
      environment.LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_SECONDS ?? '60',
      'outbox-drain-timeout-seconds',
      1,
      3600,
    ),
    confirmPersistentData: false,
  };
}

export interface ParsedLoadTestArguments {
  readonly config: LoadTestConfig;
  readonly helpRequested: boolean;
}

export function parseLoadTestArguments(
  args: readonly string[],
  environment: Environment = process.env,
): ParsedLoadTestArguments {
  const base = defaults(environment);
  const values = new Map<string, string>();
  let confirmPersistentData = false;
  let helpRequested = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--help' || argument === '-h') {
      helpRequested = true;
      continue;
    }
    if (argument === '--yes') {
      confirmPersistentData = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new InvalidLoadTestConfigurationError(`Opção desconhecida: ${argument}`);
    }
    const separator = argument.indexOf('=');
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    const allowed = new Set([
      '--api-url', '--scenario', '--duration-seconds', '--warmup-seconds',
      '--repetitions', '--concurrency', '--wallet-count', '--operations-per-wallet',
      '--metrics-interval-seconds', '--http-timeout-ms', '--outbox-drain-timeout-seconds',
    ]);
    if (!allowed.has(name)) {
      throw new InvalidLoadTestConfigurationError(`Opção desconhecida: ${name}`);
    }
    values.set(name, readOption(args, index, inlineValue, name));
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const rawScenario = values.get('--scenario') ?? base.scenario;
  if (!SCENARIOS.has(rawScenario as LoadScenario | 'all')) {
    throw new InvalidLoadTestConfigurationError('--scenario não é um cenário conhecido.');
  }
  const concurrency = values.get('--concurrency');
  const apiUrls = (values.get('--api-url') ?? base.apiUrls.join(','))
    .split(',')
    .map((value) => validateLocalApiUrl(value.trim()));

  return {
    helpRequested,
    config: {
      ...base,
      apiUrls: [...new Set(apiUrls)],
      scenario: rawScenario as LoadScenario | 'all',
      durationSeconds: parseInteger(values.get('--duration-seconds') ?? String(base.durationSeconds), 'duração', 1, 3600),
      warmupSeconds: parseInteger(values.get('--warmup-seconds') ?? String(base.warmupSeconds), 'aquecimento', 0, 300),
      repetitions: parseInteger(values.get('--repetitions') ?? String(base.repetitions), 'repetições', 1, 10),
      concurrencyLevels: concurrency
        ? [...new Set(concurrency.split(',').map((value) => parseInteger(value.trim(), 'concorrência', 1, 200)))]
        : base.concurrencyLevels,
      walletCount: parseInteger(values.get('--wallet-count') ?? String(base.walletCount), 'wallet-count', 1, 250),
      operationsPerWallet: parseInteger(values.get('--operations-per-wallet') ?? String(base.operationsPerWallet), 'operations-per-wallet', 1, 100_000),
      metricsIntervalSeconds: parseInteger(values.get('--metrics-interval-seconds') ?? String(base.metricsIntervalSeconds), 'metrics-interval-seconds', 1, 3600),
      httpTimeoutMilliseconds: parseInteger(values.get('--http-timeout-ms') ?? String(base.httpTimeoutMilliseconds), 'http-timeout-ms', 100, 120_000),
      outboxDrainTimeoutSeconds: parseInteger(values.get('--outbox-drain-timeout-seconds') ?? String(base.outboxDrainTimeoutSeconds), 'outbox-drain-timeout-seconds', 1, 3600),
      confirmPersistentData,
    },
  };
}
