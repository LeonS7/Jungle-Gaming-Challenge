/** Esta página conecta o laboratório ao runner somente no servidor Vite local. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Plugin, ViteDevServer } from 'vite';
import { parseLoadTestArguments, validateLocalApiUrl } from '../test/load/config.js';
import { summarizeScenarioResult } from '../test/load/reporting/reports.js';
import type { LoadTestProgress } from '../test/load/types.js';

const CONTROL_PREFIX = '/__local-load-test';
const MAX_REQUEST_BYTES = 12_000;

interface PublicProgress {
  readonly executionId: string;
  readonly state: LoadTestProgress['state'];
  readonly message: string;
  readonly currentScenario?: LoadTestProgress['currentScenario'];
  readonly currentRepetition?: number;
  readonly currentConcurrency?: number;
  readonly completedRequests?: number;
  readonly startedAt: string;
  readonly error?: string;
  readonly report?: {
    readonly integrityPassed: boolean;
    readonly reportDirectory: string;
    readonly results: readonly (ReturnType<typeof summarizeScenarioResult> & {
      readonly scenario: string;
      readonly repetition: number;
      readonly concurrency: number;
      readonly outboxDrainMilliseconds: number | null;
      readonly passedChecks: number;
      readonly failedChecks: readonly string[];
      readonly error?: string;
    })[];
    readonly markdownUrl: string;
    readonly jsonUrl: string;
  };
}

function isLocalHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLoopbackConnection(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (!address) {
    return false;
  }
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return isIP(normalized) !== 0 && isLocalHostname(normalized);
}

function hasLocalOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' &&
      parsed.host.toLowerCase() === host.toLowerCase() &&
      isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error('A configuração do benchmark excede o limite permitido.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('A configuração do benchmark precisa ser JSON válido.');
  }
}

function parseWebConfiguration(
  value: unknown,
  apiUrl: string,
): ReturnType<typeof parseLoadTestArguments>['config'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A configuração do benchmark precisa ser um objeto.');
  }
  const body = value as Record<string, unknown>;
  const allowedFields = new Set([
    'confirmedPersistentData', 'scenario', 'durationSeconds', 'warmupSeconds',
    'repetitions', 'concurrencyLevels', 'walletCount', 'operationsPerWallet',
    'outboxOperationsPerWallet', 'outboxMaxOperations',
    'metricsIntervalSeconds', 'httpTimeoutMilliseconds', 'outboxDrainTimeoutSeconds',
  ]);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw new Error('A configuração contém campos não permitidos.');
  }
  if (body.confirmedPersistentData !== true) {
    throw new Error('Confirme na tela que os registros financeiros serão permanentes.');
  }
  const text = (key: string): string => {
    const field = body[key];
    if (typeof field !== 'string' && typeof field !== 'number') {
      throw new Error(`O campo ${key} é obrigatório.`);
    }
    return String(field);
  };
  if (!Array.isArray(body.concurrencyLevels) || body.concurrencyLevels.some((item) => typeof item !== 'number')) {
    throw new Error('concurrencyLevels precisa ser uma lista de inteiros.');
  }
  const args = [
    '--scenario', text('scenario'),
    '--duration-seconds', text('durationSeconds'),
    '--warmup-seconds', text('warmupSeconds'),
    '--repetitions', text('repetitions'),
    '--concurrency', body.concurrencyLevels.map(String).join(','),
    '--wallet-count', text('walletCount'),
    '--operations-per-wallet', text('operationsPerWallet'),
    ...(body.outboxOperationsPerWallet === undefined ? [] : ['--outbox-operations-per-wallet', text('outboxOperationsPerWallet')]),
    ...(body.outboxMaxOperations === undefined ? [] : ['--outbox-max-operations', text('outboxMaxOperations')]),
    '--metrics-interval-seconds', text('metricsIntervalSeconds'),
    '--http-timeout-ms', text('httpTimeoutMilliseconds'),
    '--outbox-drain-timeout-seconds', text('outboxDrainTimeoutSeconds'),
  ];
  const parsed = parseLoadTestArguments(args, { LOAD_TEST_API_URL: apiUrl });
  return { ...parsed.config, apiUrls: [validateLocalApiUrl(apiUrl)], confirmPersistentData: true };
}

function parseProgressLine(line: string): PublicProgress | undefined {
  const prefix = 'LOAD_TEST_EVENT ';
  if (!line.startsWith(prefix)) {
    return undefined;
  }
  try {
    const value = JSON.parse(line.slice(prefix.length)) as Partial<PublicProgress>;
    if (
      typeof value.executionId !== 'string' ||
      typeof value.state !== 'string' ||
      typeof value.message !== 'string' ||
      typeof value.startedAt !== 'string'
    ) {
      return undefined;
    }
    return value as PublicProgress;
  } catch {
    return undefined;
  }
}

async function consumeChildOutput(
  stream: Readable,
  onProgress: (progress: PublicProgress) => void,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const progress = parseProgressLine(line);
    if (progress) {
      onProgress(progress);
    }
  }
}

function runnerArguments(config: ReturnType<typeof parseLoadTestArguments>['config']): string[] {
  return [
    '--scenario', config.scenario,
    '--duration-seconds', String(config.durationSeconds),
    '--warmup-seconds', String(config.warmupSeconds),
    '--repetitions', String(config.repetitions),
    '--concurrency', config.concurrencyLevels.join(','),
    '--wallet-count', String(config.walletCount),
    '--operations-per-wallet', String(config.operationsPerWallet),
    '--outbox-operations-per-wallet', String(config.outboxOperationsPerWallet),
    '--outbox-max-operations', String(config.outboxMaxOperations),
    '--metrics-interval-seconds', String(config.metricsIntervalSeconds),
    '--http-timeout-ms', String(config.httpTimeoutMilliseconds),
    '--outbox-drain-timeout-seconds', String(config.outboxDrainTimeoutSeconds),
    '--yes',
  ];
}

function serverIsLoopback(server: ViteDevServer): boolean {
  const host = server.config.server.host;
  if (host === false || host === undefined) {
    return true;
  }
  return typeof host === 'string' && isLocalHostname(host);
}

export function createLoadTestControlPlugin(
  repositoryRoot: string,
  serverEnvironment: Readonly<Record<string, string>>,
  rawApiTarget: string,
): Plugin {
  const jobs = new Map<string, PublicProgress>();
  let activeExecutionId: string | null = null;
  let apiTarget: string;
  try {
    apiTarget = validateLocalApiUrl(rawApiTarget);
  } catch {
    apiTarget = '';
  }

  return {
    name: 'jungle-local-load-test-control',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (!requestUrl.pathname.startsWith(CONTROL_PREFIX)) {
          next();
          return;
        }
        if (!isLoopbackConnection(request) || !serverIsLoopback(server)) {
          sendJson(response, 403, { code: 'LOCAL_ONLY', message: 'O controle de carga está disponível somente no computador local.' });
          return;
        }

        if (request.method === 'GET' && requestUrl.pathname === `${CONTROL_PREFIX}/availability`) {
          let backendReady = false;
          if (apiTarget.length > 0) {
            try {
              const readiness = await fetch(`${apiTarget}/health/ready`, {
                signal: AbortSignal.timeout(2_000),
              });
              backendReady = readiness.ok;
            } catch {
              backendReady = false;
            }
          }
          sendJson(response, 200, {
            available: apiTarget.length > 0 && backendReady,
            mode: 'desenvolvimento-local',
            message: apiTarget.length > 0
              ? backendReady
                ? 'API e dependências locais prontas; os dados financeiros serão permanentes.'
                : 'Controle local disponível, mas a API ou PostgreSQL/SQS ainda não estão prontos.'
              : 'A URL da API configurada no painel não é local.',
          });
          return;
        }

        if (request.method === 'GET' && requestUrl.pathname === `${CONTROL_PREFIX}/status`) {
          const executionId = requestUrl.searchParams.get('executionId');
          const progress = executionId ? jobs.get(executionId) : undefined;
          if (!progress) {
            sendJson(response, 404, { code: 'LOAD_TEST_NOT_FOUND', message: 'Execução de benchmark não encontrada neste processo Vite.' });
            return;
          }
          sendJson(response, 200, progress);
          return;
        }

        const reportMatch = /^\/__local-load-test\/reports\/([0-9a-f-]{36})\/(report\.md|summary\.json)$/i.exec(requestUrl.pathname);
        if (request.method === 'GET' && reportMatch) {
          try {
            const [, executionId, fileName] = reportMatch;
            const filePath = resolve(repositoryRoot, 'artifacts', 'load-tests', executionId!, fileName!);
            const contents = await readFile(filePath);
            response.statusCode = 200;
            response.setHeader('content-type', fileName === 'report.md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8');
            response.setHeader('content-disposition', `attachment; filename="${fileName}"`);
            response.setHeader('cache-control', 'no-store');
            response.end(contents);
          } catch {
            sendJson(response, 404, { code: 'LOAD_TEST_REPORT_NOT_FOUND', message: 'O relatório local ainda não está disponível.' });
          }
          return;
        }

        if (request.method !== 'POST' || requestUrl.pathname !== `${CONTROL_PREFIX}/runs`) {
          sendJson(response, 404, { code: 'LOAD_TEST_ROUTE_NOT_FOUND', message: 'Rota local de benchmark não encontrada.' });
          return;
        }
        if (!hasLocalOrigin(request) || request.headers['x-load-test-confirmed'] !== 'true') {
          sendJson(response, 403, { code: 'LOAD_TEST_ORIGIN_REJECTED', message: 'A execução deve ser iniciada pelo laboratório local e confirmada na tela.' });
          return;
        }
        if (activeExecutionId) {
          sendJson(response, 409, { code: 'LOAD_TEST_ALREADY_RUNNING', message: 'Já existe um benchmark em andamento neste painel local.' });
          return;
        }

        try {
          const body = await readJsonBody(request);
          const config = parseWebConfiguration(body, apiTarget);
          activeExecutionId = 'preparando';
          const runtimeEnvironment: Record<string, string> = {};
          for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined) runtimeEnvironment[name] = value;
          }
          const currentRuntime = basename(process.execPath).toLowerCase();
          const bunExecutable = currentRuntime.startsWith('bun') ? process.execPath : 'bun';
          const child = spawn(bunExecutable, [
            'run', 'test/load/runner.ts', ...runnerArguments(config),
          ], {
            cwd: repositoryRoot,
            env: { ...runtimeEnvironment, ...serverEnvironment, LOAD_TEST_API_URL: apiTarget },
            stdio: ['ignore', 'pipe', 'inherit'],
            windowsHide: true,
          });
          const childExit = new Promise<number>((resolveExit) => {
            child.once('error', (error) => {
              console.error('Não foi possível iniciar o runner Bun:', error.message);
              resolveExit(-1);
            });
            child.once('close', (code) => resolveExit(code ?? -1));
          });
          let resolveFirstProgress: (progress: PublicProgress | undefined) => void = () => undefined;
          const firstProgress = new Promise<PublicProgress | undefined>((resolveFirst) => {
            resolveFirstProgress = resolveFirst;
          });
          const onProgress = (progress: PublicProgress) => {
            activeExecutionId = progress.executionId;
            jobs.set(progress.executionId, progress);
            resolveFirstProgress(progress);
            while (jobs.size > 5) {
              const oldestId = jobs.keys().next().value as string | undefined;
              if (!oldestId || oldestId === activeExecutionId) break;
              jobs.delete(oldestId);
            }
          };
          const stdoutTask = consumeChildOutput(child.stdout!, onProgress);
          let startupTimeout: ReturnType<typeof setTimeout> | undefined;
          const startupTimeoutResult = new Promise<undefined>((resolveTimeout) => {
            startupTimeout = setTimeout(() => resolveTimeout(undefined), 15_000);
          });
          const first = await Promise.race([
            firstProgress,
            childExit.then(() => undefined),
            startupTimeoutResult,
          ]);
          if (startupTimeout) clearTimeout(startupTimeout);
          if (!first) {
            child.kill();
            await childExit;
            activeExecutionId = null;
            sendJson(response, 503, { code: 'LOAD_TEST_RUNNER_UNAVAILABLE', message: 'O runner Bun não iniciou. Confira o terminal local e as dependências do projeto.' });
            return;
          }
          activeExecutionId = first.executionId;
          void childExit.then(async (exitCode) => {
            await stdoutTask;
            const current = jobs.get(first.executionId);
            if (exitCode !== 0 && current && current.state !== 'failed') {
              jobs.set(first.executionId, {
                ...current,
                state: 'failed',
                message: 'O runner terminou com falha. Consulte o terminal local e o relatório gerado.',
                error: 'O runner terminou com código diferente de zero.',
              });
            }
            activeExecutionId = null;
          }).catch(() => {
            activeExecutionId = null;
          });
          sendJson(response, 202, first);
        } catch (error) {
          activeExecutionId = null;
          sendJson(response, 400, {
            code: 'INVALID_LOAD_TEST_REQUEST',
            message: error instanceof Error ? error.message : 'A configuração de benchmark é inválida.',
          });
        }
      });
    },
  };
}
