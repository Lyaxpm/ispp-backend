import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import * as fs from 'fs';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { BillingAutomationService } from '../../services/billing-automation.service';
import { RecordPaymentDto } from '../billing/dto/record-payment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';

/**
 * Direktori penyimpanan bukti pembayaran.
 * Dibuat saat modul dimuat agar multer tidak gagal pada unggahan pertama.
 */
const PROOF_UPLOAD_DIR = './uploads/proofs';
fs.mkdirSync(PROOF_UPLOAD_DIR, { recursive: true });

/**
 * Mengambil ID pengguna dari request yang sudah diautentikasi.
 * JwtStrategy menaruh { userId, email, role } di req.user.
 */
function getUserId(req: Request): number {
  const user = (req as Request & { user?: Partial<AuthUser> }).user;
  const id = Number(user?.userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestException('Token autentikasi tidak valid');
  }
  return id;
}

@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly billingAutomation: BillingAutomationService,
  ) {}

  @Post('snap/:invoiceId')
  @Roles('ADMIN', 'CASHIER', 'CS')
  createSnap(@Param('invoiceId', ParseIntPipe) invoiceId: number) {
    return this.paymentsService.createMidtransSnap(invoiceId);
  }

  @Post('xendit/:invoiceId')
  @Roles('ADMIN', 'CASHIER', 'CS')
  createXendit(@Param('invoiceId', ParseIntPipe) invoiceId: number) {
    return this.paymentsService.createXenditInvoice(invoiceId);
  }

  @Post('manual')
  @Roles('ADMIN', 'CASHIER')
  recordManual(@Body() dto: RecordPaymentDto, @Req() req: Request) {
    return this.billingAutomation.recordManualPayment(dto, getUserId(req));
  }

  @Post(':id/confirm')
  @Roles('ADMIN', 'CASHIER')
  confirmTransfer(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.billingAutomation.confirmTransferPayment(id, getUserId(req));
  }

  @Post(':id/proof')
  @Roles('ADMIN', 'CASHIER')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: PROOF_UPLOAD_DIR,
        filename: (req, file, cb) => {
          const params = (req as unknown as { params: { id: string } }).params;
          cb(null, `${params.id}-${Date.now()}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (req, file, cb) => {
        if (/\.(jpg|jpeg|png|pdf)$/i.test(extname(file.originalname))) {
          cb(null, true);
        } else {
          cb(new BadRequestException('File harus JPG/PNG/PDF'), false);
        }
      },
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadProof(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File bukti pembayaran wajib diunggah');
    }
    const payment = await this.paymentsService.attachProof(id, file.filename);
    return { proofUrl: payment.proofUrl };
  }

  /** Daftar kanal pembayaran — dapat diakses semua pengguna terautentikasi. */
  @Get('channels')
  getChannels() {
    return this.paymentsService.getPaymentChannels();
  }

  @Post('reconcile')
  @Roles('ADMIN')
  reconcile(
    @Body() body: { entries: { reference: string; amount: number; date: string }[] },
  ) {
    if (!Array.isArray(body?.entries)) {
      throw new BadRequestException('Body harus berisi array "entries"');
    }
    return this.paymentsService.reconcileBankStatement(body.entries);
  }
}
