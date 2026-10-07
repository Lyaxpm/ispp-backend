/**
 * services.module.ts
 * Modul global untuk service-service lintas domain (billing, dst).
 *
 * @Global agar BillingAutomationService dapat di-inject di controller/
 * worker manapun tanpa mengimpor modul ini secara eksplisit, dan tanpa
 * circular import: modul ini hanya bergantung ke NotificationsModule
 * (port notifikasi), bukan ke modul-modul yang mengonsumsinya.
 */
import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { BillingAutomationService } from './billing-automation.service';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [BillingAutomationService],
  exports: [BillingAutomationService],
})
export class ServicesModule {}
