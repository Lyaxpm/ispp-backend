import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

/**
 * Modul audit global — interceptor otomatis mencatat semua mutasi data.
 * Inject AuditService di service manapun untuk pencatatan manual yang kaya
 * (mis. diff sebelum/sesudah, customerId).
 */
@Module({
  providers: [
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
