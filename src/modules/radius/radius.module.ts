import { Module } from '@nestjs/common';
import { RadiusSyncService } from './radius-sync.service';

/**
 * RadiusModule — FreeRADIUS PostgreSQL table synchronization.
 * PrismaService is provided globally, so no imports are needed here.
 */
@Module({
  providers: [RadiusSyncService],
  exports: [RadiusSyncService],
})
export class RadiusModule {}
