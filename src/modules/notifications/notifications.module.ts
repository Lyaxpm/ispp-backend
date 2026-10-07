import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NOTIFICATION_PORT } from './ports/notification.port';
import { TelegramService } from './telegram.service';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'notifications' })],
  providers: [
    WhatsAppService,
    TelegramService,
    { provide: NOTIFICATION_PORT, useExisting: WhatsAppService },
  ],
  exports: [NOTIFICATION_PORT, TelegramService, WhatsAppService],
})
export class NotificationsModule {}
