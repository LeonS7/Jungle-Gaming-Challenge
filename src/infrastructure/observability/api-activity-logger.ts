/**
 * Esta página envia os logs do NestJS ao terminal e à janela local de atividade.
 */
import {
  ConsoleLogger,
  Injectable,
  type LoggerService,
} from '@nestjs/common';
import type { LogLevel } from '@nestjs/common/services/logger.service.js';
import {
  ApiActivityLog,
  type ApiActivityLevel,
} from './api-activity-log.js';

function messageText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return `${message.name}: ${message.message}`;
  }
  try {
    const serialized = JSON.stringify(message);
    return serialized ?? String(message);
  } catch {
    return String(message);
  }
}

@Injectable()
export class ApiActivityLogger implements LoggerService {
  private readonly terminal = new ConsoleLogger({ json: true });

  constructor(private readonly activityLog: ApiActivityLog) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('log', message, optionalParams);
    this.terminal.log(message, ...optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('error', message, optionalParams);
    this.terminal.error(message, ...optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('warn', message, optionalParams);
    this.terminal.warn(message, ...optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('debug', message, optionalParams);
    this.terminal.debug(message, ...optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('verbose', message, optionalParams);
    this.terminal.verbose(message, ...optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('fatal', message, optionalParams);
    this.terminal.fatal(message, ...optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.terminal.setLogLevels(levels);
  }

  private capture(
    level: ApiActivityLevel,
    message: unknown,
    optionalParams: readonly unknown[],
  ): void {
    const context = optionalParams.at(-1);
    this.activityLog.append(
      level,
      messageText(message),
      typeof context === 'string' ? context : undefined,
    );
  }
}
