/**
 * Esta página registra método, rota e resultado HTTP sem armazenar requisições.
 */
import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs';
import { ApiActivityLog } from '../../infrastructure/observability/api-activity-log.js';

interface HttpRequestForActivity {
  readonly method?: string;
  readonly baseUrl?: string;
  readonly route?: { readonly path?: string | readonly string[] };
}

interface HttpResponseForActivity {
  readonly statusCode: number;
}

function routeTemplate(request: HttpRequestForActivity): string {
  const routePath = request.route?.path;
  const path = Array.isArray(routePath) ? routePath[0] : routePath;
  if (typeof path !== 'string') {
    return '/rota-nao-identificada';
  }
  return `${request.baseUrl ?? ''}${path.startsWith('/') ? path : `/${path}`}`;
}

@Injectable()
export class HttpActivityInterceptor implements NestInterceptor {
  constructor(private readonly activityLog: ApiActivityLog) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequestForActivity>();
    const response = http.getResponse<HttpResponseForActivity>();
    const route = routeTemplate(request);

    // A consulta periódica do próprio console não deve gerar uma linha a cada atualização.
    if (route === '/activity') {
      return next.handle();
    }

    const startedAt = performance.now();
    const record = (statusCode: number): void => {
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';
      this.activityLog.append(
        level,
        JSON.stringify({
          event: 'http.request_completed',
          method: request.method ?? 'DESCONHECIDO',
          route,
          statusCode,
          durationMilliseconds: Math.max(0, Math.round(performance.now() - startedAt)),
        }),
        'HttpActivity',
      );
    };

    return next.handle().pipe(
      tap({
        next: () => record(response.statusCode),
        error: (error: unknown) => record(
          error instanceof HttpException ? error.getStatus() : 500,
        ),
      }),
    );
  }
}
