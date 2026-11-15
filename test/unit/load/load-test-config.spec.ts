/** Esta página valida as opções do benchmark e recusa alvos não locais. */
import { describe, expect, test } from 'bun:test';
import {
  InvalidLoadTestConfigurationError,
  parseLoadTestArguments,
  validateLocalApiUrl,
  validateLocalDependencyTargets,
} from '../../../test/load/config.js';

describe('configuração do benchmark', () => {
  test('usa valores locais seguros e aceita somente destinos loopback', () => {
    const parsed = parseLoadTestArguments([], {});

    expect(parsed.config.apiUrls).toEqual(['http://127.0.0.1:3000']);
    expect(parsed.config.scenario).toBe('all');
    expect(parsed.config.concurrencyLevels).toEqual([10, 25, 50]);
    expect(parsed.config.outboxOperationsPerWallet).toBe(10);
    expect(parsed.config.outboxMaxOperations).toBe(120);
    expect(parsed.config.apiInstanceCount).toBeNull();
    expect(parsed.config.confirmPersistentData).toBe(false);
    expect(validateLocalApiUrl('http://localhost:3001')).toBe('http://localhost:3001');
    expect(validateLocalApiUrl('http://[::1]:3002')).toBe('http://[::1]:3002');
  });

  test('interpreta parâmetros CLI e variáveis de ambiente sem conversões monetárias', () => {
    const parsed = parseLoadTestArguments([
      '--scenario', 'contention',
      '--duration-seconds=4',
      '--concurrency', '5,10,5',
      '--wallet-count', '2',
      '--yes',
    ], {
      LOAD_TEST_WARMUP_SECONDS: '0',
      LOAD_TEST_HTTP_TIMEOUT_MS: '1500',
    });

    expect(parsed.config.scenario).toBe('contention');
    expect(parsed.config.durationSeconds).toBe(4);
    expect(parsed.config.concurrencyLevels).toEqual([5, 10]);
    expect(parsed.config.walletCount).toBe(2);
    expect(parsed.config.warmupSeconds).toBe(0);
    expect(parsed.config.httpTimeoutMilliseconds).toBe(1500);
    expect(parsed.config.confirmPersistentData).toBe(true);
  });

  test('recusa destinos remotos, credenciais, fragmentos e opções desconhecidas', () => {
    expect(() => validateLocalApiUrl('https://localhost:3000')).toThrow(InvalidLoadTestConfigurationError);
    expect(() => validateLocalApiUrl('http://example.test')).toThrow(InvalidLoadTestConfigurationError);
    expect(() => validateLocalApiUrl('http://user:secret@127.0.0.1:3000')).toThrow(InvalidLoadTestConfigurationError);
    expect(() => validateLocalApiUrl('http://127.0.0.1:3000/#frag')).toThrow(InvalidLoadTestConfigurationError);
    expect(() => parseLoadTestArguments(['--production'])).toThrow(InvalidLoadTestConfigurationError);
  });

  test('recusa PostgreSQL e SQS fora do ambiente local', () => {
    expect(() => validateLocalDependencyTargets('127.0.0.1', 'http://localhost:4566')).not.toThrow();
    expect(() => validateLocalDependencyTargets('db.example.test', 'http://localhost:4566'))
      .toThrow(InvalidLoadTestConfigurationError);
    expect(() => validateLocalDependencyTargets('127.0.0.1', 'https://sqs.example.test'))
      .toThrow(InvalidLoadTestConfigurationError);
  });

  test('recusa escalas e limites fora do intervalo', () => {
    expect(() => parseLoadTestArguments(['--duration-seconds', '0'])).toThrow(InvalidLoadTestConfigurationError);
    expect(() => parseLoadTestArguments(['--concurrency', '10,201'])).toThrow(InvalidLoadTestConfigurationError);
    expect(() => parseLoadTestArguments(['--scenario', 'unsupported'])).toThrow(InvalidLoadTestConfigurationError);
    expect(() => parseLoadTestArguments(['--outbox-max-operations', '10001'], {})).toThrow(InvalidLoadTestConfigurationError);
    expect(() => parseLoadTestArguments(['--outbox-operations-per-wallet', '1001'], {})).toThrow(InvalidLoadTestConfigurationError);
    expect(() => parseLoadTestArguments(['--api-instance-count', '0'], {})).toThrow(InvalidLoadTestConfigurationError);
  });

  test('aceita limites maiores e topologia declarada com prioridade da CLI', () => {
    const { config } = parseLoadTestArguments(['--outbox-max-operations', '600', '--consumer-count', '0'], {
      LOAD_TEST_OUTBOX_OPERATIONS_PER_WALLET: '50',
      LOAD_TEST_OUTBOX_MAX_OPERATIONS: '500',
      LOAD_TEST_API_INSTANCE_COUNT: '2',
      LOAD_TEST_PUBLISHER_COUNT: '2',
    });
    expect([config.outboxOperationsPerWallet, config.outboxMaxOperations]).toEqual([50, 600]);
    expect([config.apiInstanceCount, config.consumerCount, config.publisherCount]).toEqual([2, 0, 2]);
  });
});
