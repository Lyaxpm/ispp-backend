import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import 'dayjs/locale/id';
import { PrismaService } from '../../prisma/prisma.service';
import {
  allocateInvoiceNumber,
  computeTotals,
  formatRupiah,
  getSetting,
} from '../../common/utils/billing-math.util';
import { buildMeta, paginate } from '../../common/utils/pagination.util';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvoiceFilterDto } from './dto/invoice-filter.dto';

dayjs.locale('id');

type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: {
    customer: {
      select: { id: true; customerNo: true; name: true; phone: true; email: true; status: true };
    };
    payments: true;
  };
}>;

/** "1–31 Okt 2026" untuk kolom periode di frontend. */
function formatPeriod(start: Date, end: Date): string {
  const s = dayjs(start);
  const e = dayjs(end);
  return s.isSame(e, 'month')
    ? `${s.format('D')}–${e.format('D MMM YYYY')}`
    : `${s.format('D MMM YYYY')} – ${e.format('D MMM YYYY')}`;
}

/**
 * Petakan invoice Prisma ke bentuk yang dimengerti frontend
 * (invoiceNo, period, paidAmount, isOverdue, id string).
 */
export function toInvoiceDto(inv: InvoiceWithRelations) {
  const due = new Date(inv.dueDate);
  const paidTx = (inv.payments ?? []).find((p) => p.status === 'PAID');
  const isOverdue =
    inv.status === InvoiceStatus.OVERDUE ||
    ((inv.status === InvoiceStatus.UNPAID || inv.status === InvoiceStatus.PARTIAL) &&
      due.getTime() < Date.now());
  return {
    id: String(inv.id),
    invoiceNo: inv.number,
    customerId: String(inv.customerId),
    customer: inv.customer
      ? {
          id: String(inv.customer.id),
          customerNo: inv.customer.customerNo,
          name: inv.customer.name,
        }
      : null,
    period: formatPeriod(new Date(inv.periodStart), new Date(inv.periodEnd)),
    subtotal: Number(inv.subtotal),
    discount: Number(inv.discount),
    adminFee: Number(inv.adminFee),
    tax: Number(inv.ppn),
    total: Number(inv.total),
    paidAmount: Number(inv.amountPaid),
    status: inv.status,
    dueDate: due.toISOString(),
    issuedAt: new Date(inv.issueDate).toISOString(),
    paidAt: paidTx?.paidAt ? new Date(paidTx.paidAt).toISOString() : null,
    isOverdue,
  };
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Membuat invoice baru beserta perhitungan total, nomor invoice,
   * pemakaian voucher, dan audit log — semuanya dalam satu transaksi.
   */
  async create(dto: CreateInvoiceDto, createdById: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) {
      throw new NotFoundException('Pelanggan tidak ditemukan');
    }

    // --- Tentukan harga dasar ---
    let price: number;
    if (dto.subscriptionId) {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: dto.subscriptionId },
        include: { package: true },
      });
      if (!subscription) {
        throw new NotFoundException('Langganan tidak ditemukan');
      }
      if (subscription.customerId !== customer.id) {
        throw new BadRequestException(
          'Langganan tersebut bukan milik pelanggan ini',
        );
      }
      price = dto.priceOverride ?? Number(subscription.package.price);
    } else {
      if (dto.priceOverride === undefined || dto.priceOverride === null) {
        throw new BadRequestException(
          'priceOverride wajib diisi untuk invoice manual',
        );
      }
      price = dto.priceOverride;
    }

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('Format tanggal periode tidak valid');
    }
    if (periodEnd <= periodStart) {
      throw new BadRequestException('periodEnd harus setelah periodStart');
    }

    // --- Diskon + voucher ---
    let discount = dto.discount ?? 0;
    let voucherCode: string | null = null;
    if (dto.voucherCode) {
      const now = new Date();
      const voucher = await this.prisma.voucher.findUnique({
        where: { code: dto.voucherCode },
      });
      if (!voucher) {
        throw new NotFoundException('Kode voucher tidak ditemukan');
      }
      if (!voucher.isActive) {
        throw new BadRequestException('Voucher sudah tidak aktif');
      }
      if (voucher.validFrom && now < new Date(voucher.validFrom)) {
        throw new BadRequestException('Voucher belum dapat digunakan');
      }
      if (voucher.validTo && now > new Date(voucher.validTo)) {
        throw new BadRequestException('Masa berlaku voucher sudah habis');
      }
      if (Number(voucher.usedCount) >= Number(voucher.maxUses)) {
        throw new BadRequestException('Kuota pemakaian voucher sudah habis');
      }

      const percent = Number(voucher.discountPercent);
      const voucherDiscount =
        percent > 0
          ? Math.round((price * percent) / 100)
          : Math.round(Number(voucher.discountAmount));
      discount += voucherDiscount;
      voucherCode = voucher.code;
      this.logger.log(
        `Voucher ${voucher.code} dipakai, diskon tambahan ${formatRupiah(voucherDiscount)}`,
      );
    }

    // --- Hitung total ---
    const ppnRate = Number(await getSetting(this.prisma, 'PPN_RATE', '11'));
    const adminFee = Number(await getSetting(this.prisma, 'ADMIN_FEE', '2500'));
    const totals = computeTotals({
      price,
      discount,
      ppnRatePercent: ppnRate,
      adminFee,
    });

    // --- Tanggal jatuh tempo: tanggal dueDay pada bulan periodStart,
    //     digeser ke bulan berikutnya jika tidak jatuh setelah periodStart ---
    const dueDay = Math.min(customer.dueDay || 10, 28);
    const dueDate = new Date(periodStart);
    dueDate.setDate(dueDay);
    if (dueDate <= periodStart) {
      dueDate.setMonth(dueDate.getMonth() + 1);
      dueDate.setDate(Math.min(dueDay, 28));
    }

    const invoice = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const number = await allocateInvoiceNumber(tx, new Date());

        const created = await tx.invoice.create({
          data: {
            number,
            customerId: customer.id,
            subscriptionId: dto.subscriptionId ?? null,
            periodStart,
            periodEnd,
            issueDate: new Date(),
            dueDate,
            ...totals,
            amountPaid: 0,
            status: 'UNPAID',
            notes: dto.notes ?? null,
          },
        });

        if (voucherCode) {
          await tx.voucher.update({
            where: { code: voucherCode },
            data: { usedCount: { increment: 1 } },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'INVOICE_CREATE',
            entity: 'Invoice',
            entityId: String(created.id),
            actorId: createdById,
            customerId: customer.id,
            diff: {
              number,
              total: totals.total,
              voucherCode,
            },
          },
        });

        return created;
      },
    );

    this.logger.log(
      `Invoice ${invoice.number} dibuat untuk pelanggan ${customer.customerNo} ` +
        `sebesar ${formatRupiah(Number(invoice.total))} oleh ${createdById}`,
    );
    return this.findOne(invoice.id);
  }

  /** Daftar invoice dengan filter status/pelanggan/periode + paginasi. */
  async findAll(filter: InvoiceFilterDto) {
    const { skip, take, page, limit } = paginate(filter.page, filter.limit);

    const where: Prisma.InvoiceWhereInput = {};
    if (filter.status) {
      where.status = filter.status as InvoiceStatus;
    }
    if (filter.customerId) {
      where.customerId = filter.customerId;
    }
    if (filter.year && filter.month) {
      const start = new Date(filter.year, filter.month - 1, 1);
      const end = new Date(filter.year, filter.month, 1);
      where.periodStart = { gte: start, lt: end };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        skip,
        take,
        orderBy: { issueDate: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              customerNo: true,
              name: true,
              phone: true,
              email: true,
              status: true,
            },
          },
          payments: {
            where: { status: 'PAID' },
            orderBy: { paidAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    return {
      data: rows.map((r) => toInvoiceDto(r as InvoiceWithRelations)),
      meta: buildMeta(total, page, limit),
    };
  }

  /** Detail invoice beserta pelanggan, riwayat pembayaran, dan paket langganan. */
  async findOne(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            customerNo: true,
            name: true,
            phone: true,
            email: true,
            status: true,
          },
        },
        payments: { orderBy: { paidAt: 'desc' } },
        subscription: { include: { package: true } },
      },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice tidak ditemukan');
    }
    return toInvoiceDto(invoice as InvoiceWithRelations);
  }

  /**
   * Membatalkan invoice. Hanya boleh untuk status DRAFT/UNPAID
   * yang belum memiliki pembayaran sama sekali.
   */
  async cancel(id: number, userId: number) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id } });
    if (!invoice) {
      throw new NotFoundException('Invoice tidak ditemukan');
    }
    const cancellable =
      invoice.status === 'DRAFT' || invoice.status === 'UNPAID';
    if (!cancellable || Number(invoice.amountPaid) !== 0) {
      throw new BadRequestException(
        'Hanya invoice berstatus DRAFT/UNPAID yang belum dibayar yang dapat dibatalkan',
      );
    }

    const cancelled = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const updated = await tx.invoice.update({
          where: { id },
          data: { status: 'CANCELLED' },
        });
        await tx.auditLog.create({
          data: {
            action: 'INVOICE_CANCEL',
            entity: 'Invoice',
            entityId: String(id),
            actorId: userId,
            customerId: invoice.customerId,
            diff: { number: invoice.number, total: Number(invoice.total) },
          },
        });
        return updated;
      },
    );

    this.logger.log(
      `Invoice ${invoice.number} dibatalkan oleh ${userId}`,
    );
    void cancelled;
    return this.findOne(id);
  }

  /**
   * Daftar tunggakan pelanggan (UNPAID/PARTIAL/OVERDUE) diurutkan
   * dari jatuh tempo terdekat, beserta total tunggakan.
   */
  async getOutstanding(customerId: number) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        customerId,
        status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] },
      },
      orderBy: { dueDate: 'asc' },
      include: {
        customer: {
          select: { id: true, customerNo: true, name: true, phone: true },
        },
      },
    });

    const totalOutstanding = invoices.reduce(
      (sum, inv) => sum + (Number(inv.total) - Number(inv.amountPaid)),
      0,
    );

    return { data: invoices, totalOutstanding };
  }
}
