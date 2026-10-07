import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { BillingAutomationService } from '../../services/billing-automation.service';

/**
 * Webhook pembayaran dari gateway.
 *
 * TIDAK memakai JwtAuthGuard — autentikasinya adalah HMAC signature
 * (Midtrans) dan token callback (Xendit) yang diverifikasi di
 * BillingAutomationService.
 *
 * Catatan: endpoint /webhooks/midtrans membutuhkan express.raw()
 * di main.ts agar body mentah tersedia untuk verifikasi signature.
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly billingAutomation: BillingAutomationService,
  ) {}

  @Post('midtrans')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async midtrans(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string,
  ) {
    const rawBody = req.body as unknown;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException(
        'Body mentah tidak tersedia — pastikan express.raw() terpasang di main.ts',
      );
    }
    this.logger.log('Webhook Midtrans diterima');
    return this.billingAutomation.handleMidtransWebhook(
      rawBody,
      signature ?? '',
    );
  }

  @Post('xendit')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async xendit(
    @Body() payload: any,
    @Headers('x-callback-token') token: string,
  ) {
    this.logger.log('Webhook Xendit diterima');
    return this.billingAutomation.handleXenditWebhook(payload, token ?? '');
  }
}
