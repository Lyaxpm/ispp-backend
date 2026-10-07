import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { WebhooksController } from './webhooks.controller';
import { PaymentsService } from './payments.service';

/**
 * Modul pembayaran: transaksi gateway (Midtrans Snap, Xendit Invoice),
 * pembayaran manual, konfirmasi transfer, unggah bukti, kanal pembayaran,
 * rekonsiliasi mutasi bank, dan webhook gateway.
 *
 * BillingAutomationService disediakan secara global oleh ServicesModule,
 * sehingga tidak perlu didaftarkan ulang di sini.
 */
@Module({
  controllers: [PaymentsController, WebhooksController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
