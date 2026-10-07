import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

/**
 * Modul penagihan: pembuatan, pencarian, pembatalan invoice,
 * dan pencatatan pembayaran manual.
 *
 * BillingAutomationService disediakan secara global oleh ServicesModule,
 * sehingga tidak perlu didaftarkan ulang di sini.
 */
@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class BillingModule {}
