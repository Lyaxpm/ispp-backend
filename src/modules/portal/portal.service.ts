import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Invoice } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketsService } from '../tickets/tickets.service';
import { RadiusSyncService } from '../radius/radius-sync.service';
import { CreatePortalTicketDto } from './dto/portal.dto';

/** Email akun sistem pelapor tiket yang dibuat dari portal pelanggan. */
const PORTAL_REPORTER_EMAIL = 'portal@system.local';

/** Bentuk invoice yang aman untuk portal (Decimal → number). */
function toPortalInvoiceDto(inv: Invoice) {
  return {
    id: inv.id,
    number: inv.number,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    subtotal: Number(inv.subtotal),
    discount: Number(inv.discount),
    ppn: Number(inv.ppn),
    adminFee: Number(inv.adminFee),
    penalty: Number(inv.penalty),
    total: Number(inv.total),
    amountPaid: Number(inv.amountPaid),
    status: inv.status,
    notes: inv.notes,
  };
}

/**
 * Portal pelanggan: profil, tagihan, tiket, dan ganti password WiFi/PPPoE.
 * Semua operasi dibatasi pada customer milik token (CustomerJwtGuard).
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly radiusSync: RadiusSyncService,
  ) {}

  /** Profil: data customer + info akun portal (tanpa passwordHash). */
  async profile(customerId: number) {
    const account = await this.requireAccount(customerId);
    const { passwordHash: _removed, ...safeAccount } = account;
    void _removed;
    return { account: safeAccount, customer: account.customer };
  }

  /** Daftar invoice milik customer, terbaru dulu. */
  async invoices(customerId: number) {
    const rows = await this.prisma.invoice.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPortalInvoiceDto);
  }

  /** Detail invoice — 404 bila bukan milik customer ini. */
  async invoiceDetail(customerId: number, id: number) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, customerId },
      include: { payments: true },
    });
    if (!inv) {
      throw new NotFoundException('Invoice tidak ditemukan');
    }
    return {
      ...toPortalInvoiceDto(inv),
      payments: inv.payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: p.method,
        status: p.status,
        paidAt: p.paidAt,
      })),
    };
  }

  /** Daftar tiket milik customer, terbaru dulu. */
  async ticketsList(customerId: number) {
    return this.prisma.ticket.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        priority: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
  }

  /**
   * Buat tiket dari portal. Kolom reportedBy (FK User) wajib diisi schema,
   * jadi dipakai akun sistem "Portal Pelanggan" sebagai pelapor.
   */
  async createTicket(customerId: number, dto: CreatePortalTicketDto) {
    const reporter = await this.ensurePortalReporter();
    const description = dto.category
      ? `[Kategori: ${dto.category}] ${dto.message}`
      : dto.message;
    const created = await this.tickets.create(
      { customerId, title: dto.subject, description },
      reporter.id,
    );
    this.logger.log(`Tiket portal ${created.ticketNo} dibuat untuk customer #${customerId}`);
    return created;
  }

  /**
   * Ganti password PPPoE/WiFi pelanggan: simpan ke Setting
   * PPPOE_PASSWORD_<customerNo> lalu sinkronkan ke RADIUS.
   * Tidak pernah throw — selalu {ok, message}.
   */
  async changePppoePassword(
    customerId: number,
    newPassword: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const account = await this.requireAccount(customerId);
      const key = `PPPOE_PASSWORD_${account.customer.customerNo}`;
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value: newPassword },
        update: { value: newPassword },
      });
      try {
        const synced = await this.radiusSync.syncCustomer(customerId);
        return {
          ok: true,
          message: `Password WiFi berhasil diganti dan disinkronkan ke RADIUS (${synced.synced.join(', ')})`,
        };
      } catch (syncErr) {
        const reason = syncErr instanceof Error ? syncErr.message : String(syncErr);
        this.logger.warn(`Sinkronisasi RADIUS gagal untuk customer #${customerId}: ${reason}`);
        return {
          ok: true,
          message:
            'Password WiFi tersimpan, tetapi sinkronisasi RADIUS gagal — akan disinkronkan otomatis berikutnya',
        };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ganti password PPPoE gagal untuk customer #${customerId}: ${reason}`);
      return { ok: false, message: `Gagal mengganti password WiFi: ${reason}` };
    }
  }

  /* ------------------------------------------------------------------ */

  private async requireAccount(customerId: number) {
    const account = await this.prisma.customerAccount.findFirst({
      where: { customerId, isActive: true },
      include: { customer: true },
    });
    if (!account) {
      throw new UnauthorizedException('Akun pelanggan tidak ditemukan');
    }
    return account;
  }

  /**
   * Pastikan akun sistem pelapor tiket portal ada (idempoten).
   * Akun ini nonaktif untuk login — hanya memenuhi FK reportedBy.
   */
  private async ensurePortalReporter() {
    const existing = await this.prisma.user.findUnique({
      where: { email: PORTAL_REPORTER_EMAIL },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.user.create({
      data: {
        name: 'Portal Pelanggan',
        email: PORTAL_REPORTER_EMAIL,
        passwordHash: await bcrypt.hash(`portal-${Date.now()}-${Math.random()}`, 10),
        role: 'CS',
        isActive: false,
      },
    });
  }
}
