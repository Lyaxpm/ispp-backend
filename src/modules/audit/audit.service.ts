import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Layanan audit log terpusat. TIDAK PERNAH melempar error — kegagalan
 * pencatatan hanya di-log agar tidak menggagalkan request utama.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(
    actorId: number | null,
    action: string,
    entity: string,
    entityId: string,
    diff?: Prisma.InputJsonValue,
    ip?: string,
    customerId?: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId,
          action,
          entity,
          entityId,
          diff: diff ?? Prisma.JsonNull,
          ipAddress: ip ?? null,
          customerId: customerId ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Gagal mencatat audit ${action} ${entity}#${entityId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
