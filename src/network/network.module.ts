import { Module } from '@nestjs/common';
import { DriverFactory } from './drivers/driver-factory';
import { NetworkOrchestratorService } from './services/network-orchestrator.service';
import { RadiusCoAService } from './services/radius-coa.service';
import { NocController } from './noc.controller';

/**
 * NetworkModule — the ISP network automation layer.
 *
 * Providers:
 *  - DriverFactory            : cached MikroTik / OLT drivers
 *  - NetworkOrchestratorService : isolate / unisolate / throttle / profile ops
 *  - RadiusCoAService         : RFC 5176 Disconnect-Request over UDP
 *
 * PrismaService is provided globally; NotificationPort ('NotificationPort'
 * token) is optional — the orchestrator degrades gracefully when the
 * notifications module is not registered.
 */
@Module({
  controllers: [NocController],
  providers: [DriverFactory, NetworkOrchestratorService, RadiusCoAService],
  exports: [DriverFactory, NetworkOrchestratorService, RadiusCoAService],
})
export class NetworkModule {}
