import { Injectable } from '@nestjs/common';
import { CustomerStatus, InvoiceStatus, OnuStatus, PaymentStatus } from '@prisma/client';
import dayjs from 'dayjs';
import 'dayjs/locale/id';
import { PrismaService } from '../../prisma/prisma.service';

dayjs.locale('id');

export interface RevenuePoint {
  month: string;
  revenue: number;
}

/**
 * Agregasi untuk dashboard utama: statistik kartu, grafik pendapatan,
 * distribusi status pelanggan, dan umpan alarm NOC terakhir.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const monthStart = dayjs().startOf('month').toDate();
    const [
      activeCustomers,
      isolatedCount,
      overdueInvoices,
      onlineOnus,
      monthlyRevenueAgg,
      ticketsOpen,
      byStatus,
      recentAlarms,
    ] = await this.prisma.$transaction([
      this.prisma.customer.count({ where: { status: CustomerStatus.ACTIVE } }),
      this.prisma.customer.count({ where: { status: CustomerStatus.ISOLATED } }),
      this.prisma.invoice.count({
        where: {
          status: { in: [InvoiceStatus.OVERDUE, InvoiceStatus.UNPAID, InvoiceStatus.PARTIAL] },
          dueDate: { lt: new Date() },
        },
      }),
      this.prisma.onu.count({ where: { status: OnuStatus.ONLINE } }),
      this.prisma.payment.aggregate({
        _sum: { amount: true },
        where: { status: PaymentStatus.PAID, paidAt: { gte: monthStart } },
      }),
      this.prisma.ticket.count({
        where: { status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] } },
      }),
      this.prisma.customer.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.notificationLog.findMany({
        where: { channel: 'TELEGRAM' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          template: true,
          payload: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      activeCustomers,
      monthlyRevenue: Number(monthlyRevenueAgg._sum.amount ?? 0),
      overdueInvoices,
      onlineOnus,
      isolatedCount,
      ticketsOpen,
      customersByStatus: byStatus.map((r) => ({
        status: r.status,
        count:
          typeof r._count === 'object' && r._count !== null
            ? (r._count._all ?? 0)
            : 0,
      })),
      alarms: recentAlarms.map((a, i) => {
        const payload =
          a.payload && typeof a.payload === 'object'
            ? (a.payload as Record<string, unknown>)
            : {};
        const title = String(payload['title'] ?? a.template ?? 'Alarm NOC');
        return {
          id: String(a.id),
          severity:
            i === 0 ? ('CRITICAL' as const)
            : a.status === 'FAILED' ? ('WARNING' as const)
            : ('INFO' as const),
          title,
          message: String(payload['message'] ?? ''),
          nodeType: (payload['nodeType'] as string) ?? null,
          nodeCode: (payload['nodeCode'] as string) ?? null,
          createdAt: a.createdAt.toISOString(),
        };
      }),
    };
  }

  /** Pendapatan per bulan (pembayaran PAID), N bulan terakhir. */
  async getRevenueChart(months = 6): Promise<RevenuePoint[]> {
    const n = Math.min(Math.max(months, 1), 24);
    const points: RevenuePoint[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const start = dayjs().subtract(i, 'month').startOf('month');
      const end = start.add(1, 'month');
      const agg = await this.prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          status: PaymentStatus.PAID,
          paidAt: { gte: start.toDate(), lt: end.toDate() },
        },
      });
      points.push({
        month: start.format('MMM YYYY'),
        revenue: Number(agg._sum.amount ?? 0),
      });
    }
    return points;
  }
}
