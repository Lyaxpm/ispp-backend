import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from './audit.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Interceptor audit global (didaftarkan via APP_INTERCEPTOR di AuditModule).
 * Mencatat setiap request POST/PUT/PATCH/DELETE yang BERHASIL dengan format
 * action "<controller>.<handler>" huruf kecil, mis. "customers.create".
 * AuthController dikecualikan agar log login tidak membanjiri tabel audit.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      ip: string;
      params: Record<string, string>;
      user?: AuthUser;
    }>();

    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }
    const controllerName = context.getClass().name;
    if (controllerName === 'AuthController') {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: () => {
          void this.record(context, request).catch((err: unknown) => {
            this.logger.error(`Audit gagal: ${err instanceof Error ? err.message : err}`);
          });
        },
        error: () => undefined, // request gagal tidak diaudit
      }),
    );
  }

  private async record(
    context: ExecutionContext,
    request: { ip: string; params: Record<string, string>; user?: AuthUser },
  ): Promise<void> {
    const controller = context.getClass().name.replace(/Controller$/, '');
    const handler = context.getHandler().name;
    const action = `${controller}.${handler}`.toLowerCase();
    const entityId = request.params?.id ?? request.params?.number ?? '';
    await this.audit.log(
      request.user?.userId ?? null,
      action,
      controller,
      String(entityId),
      undefined,
      request.ip,
    );
  }
}
