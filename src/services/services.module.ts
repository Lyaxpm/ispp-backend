/**
 * services.module.ts
 * Modul global untuk service-service lintas domain (billing, dst).
 *
 * @Global agar BillingAutomationService dapat di-inject di controller/
 * worker manapun tanpa mengimpor modul ini secara eksplisit.
 *
 * BillingAutomationService meng-inject NetworkOrchestratorService
 * (dari NetworkModule), RadiusSyncService (dari RadiusModule), dan
 * queue BullMQ 'notifications' — ketiganya HARUS di-import di sini,
 * sebab provider modul global me-resolve dependensi dari konteks
 * modulnya sendiri, bukan dari AppModule.
 */
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { NetworkModule } from '../network/network.module';
import { RadiusModule } from '../modules/radius/radius.module';
import { BillingAutomationService } from './billing-automation.service';
import { QUEUE_NOTIFICATIONS } from '../workers/queues';

@Global()
@Module({
  imports: [
    NotificationsModule,
    NetworkModule,
    RadiusModule,
    BullModule.registerQueue({ name: QUEUE_NOTIFICATIONS }),
  ],
  providers: [BillingAutomationService],
  exports: [BillingAutomationService],
})
export class ServicesModule {}
