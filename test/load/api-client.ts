/** Esta página envia operações HTTP reais e mede o tempo de resposta da API. */
import type { HttpMeasurement } from './types.js';

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
}

export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'LOSS';
  readonly money: { readonly amount: string; readonly currency: string };
}

export interface WagerResponse {
  readonly transactionId?: string;
  readonly status?: string;
  readonly idempotentReplay?: boolean;
  readonly failureCode?: string;
}

export interface ApiRequestResult<T> {
  readonly statusCode: number | null;
  readonly body: T | null;
  readonly measurement: HttpMeasurement;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function errorKind(error: unknown): HttpMeasurement['errorKind'] {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'timeout';
  }
  if (error instanceof TypeError) {
    return 'connection';
  }
  return 'unexpected';
}

export class WageringApiClient {
  private nextApiIndex = 0;

  constructor(
    private readonly apiUrls: readonly string[],
    private readonly timeoutMilliseconds: number,
  ) {
    if (apiUrls.length === 0) {
      throw new Error('É necessário informar ao menos uma URL de API.');
    }
  }

  private nextBaseUrl(): string {
    const selected = this.apiUrls[this.nextApiIndex % this.apiUrls.length]!;
    this.nextApiIndex += 1;
    return selected;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<ApiRequestResult<T>> {
    const baseUrl = this.nextBaseUrl();
    const startedAt = performance.now();
    try {
      const response = await fetch(baseUrl + path, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      const rawBody = await response.text();
      const parsedBody = parseJson(rawBody);
      const measurement: HttpMeasurement = {
        elapsedMilliseconds: performance.now() - startedAt,
        httpStatus: response.status,
        ...(response.status === 409
          ? { businessConflict: true }
          : {}),
        ...(typeof parsedBody === 'object' && parsedBody !== null && 'status' in parsedBody
          ? { transactionStatus: String(parsedBody.status) }
          : {}),
        ...(typeof parsedBody === 'object' && parsedBody !== null && 'idempotentReplay' in parsedBody
          ? { idempotentReplay: parsedBody.idempotentReplay === true }
          : {}),
        ...(typeof parsedBody === 'object' && parsedBody !== null && 'code' in parsedBody
          ? { responseCode: String(parsedBody.code) }
          : {}),
      };
      return {
        statusCode: response.status,
        body: parsedBody as T | null,
        measurement,
      };
    } catch (error) {
      return {
        statusCode: null,
        body: null,
        measurement: {
          elapsedMilliseconds: performance.now() - startedAt,
          httpStatus: null,
          errorKind: errorKind(error),
        },
      };
    }
  }

  async checkAvailability(): Promise<void> {
    const live = await this.request<{ readonly status?: string }>('GET', '/health/live');
    const ready = await this.request<{ readonly status?: string }>('GET', '/health/ready');
    if (live.statusCode !== 200 || ready.statusCode !== 200) {
      throw new Error('A API ou suas dependências não estão prontas para o benchmark local.');
    }
  }

  async readMetrics(apiUrl: string): Promise<string> {
    const response = await fetch(apiUrl + '/metrics', {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    if (!response.ok) {
      throw new Error(`A API local retornou HTTP ${response.status} ao consultar as métricas.`);
    }
    return response.text();
  }

  async createWallet(playerId: string, initialBalance: string): Promise<WalletView> {
    const response = await this.request<WalletView>('POST', '/wallets', {
      playerId,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    });
    if (response.statusCode !== 201 || !response.body?.id) {
      throw new Error(`Não foi possível preparar uma carteira exclusiva (HTTP ${response.statusCode ?? 'sem resposta'}).`);
    }
    return response.body;
  }

  async submitWager(
    payload: WagerPayload,
    idempotencyKey: string,
  ): Promise<ApiRequestResult<WagerResponse>> {
    return this.request<WagerResponse>(
      'POST',
      '/wagering/transactions',
      payload,
      idempotencyKey,
    );
  }

  async reconcile(walletId: string): Promise<{
    readonly consistent: boolean;
    readonly checkedEntries: number;
  } | null> {
    const response = await this.request<{
      readonly consistent?: unknown;
      readonly checkedEntries?: unknown;
    }>('POST', `/wallets/${encodeURIComponent(walletId)}/reconciliation`);
    if (
      response.statusCode !== 200 ||
      response.body?.consistent !== true ||
      typeof response.body.checkedEntries !== 'number'
    ) {
      return null;
    }
    return {
      consistent: response.body.consistent,
      checkedEntries: response.body.checkedEntries,
    };
  }
}
