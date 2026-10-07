import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CustomerStatus, OnuStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { buildMeta, paginate } from '../../common/utils/pagination.util';
import { NetworkOrchestratorService } from '../../network/services/network-orchestrator.service';
import { RadiusSyncService } from '../../modules/radius/radius-sync.service';
import { OltService } from '../../modules/olt/olt.service';
import { CustomerFilterDto } from './dto/customer-filter.dto';

type CustomerRow = Prisma.CustomerGetPayload<{
  include: {
    subscriptions: { include: { package: true } };
    odpPort: { include: { odp: true } };
    onu: true;
  };
}>;

/** Petakan status ONU backend ke status yang dimengerti frontend. */
function mapOnuStatus(s: OnuStatus): 'ONLINE' | 'OFFLINE' | 'LOS' | 'DYING_GASP' {
  switch (s) {
    case 'ONLINE':
      return 'ONLINE';
    case 'LOS':
      return 'LOS';
    case 'DEGRADED':
      return 'DYING_GASP';
    case 'OFFLINE':
    case 'UNCONFIGURED':
    default:
      return 'OFFLINE';
  }
}

/**
 * Bentuk Customer sesuai kontrak frontend (id string, category, odpCode,
 * subscription aktif + paket, onu).
 */
export function toCustomerDto(c: CustomerRow) {
  const activeSub = c.subscriptions[0] ?? null;
  return {
    id: String(c.id),
    customerNo: c.customerNo,
    name: c.name,
    email: c.email,
    phone: c.phone,
    address: c.address,
    latitude: c.latitude,
    longitude: c.longitude,
    ktpNumber: c.ktpNumber,
    category: c.type,
    status: c.status,
    dueDay: c.dueDay,
    odpCode: c.odpPort?.odp?.code ?? null,
    odpPort: c.odpPort?.portNo ?? null,
    subscription: activeSub
      ? {
          id: String(activeSub.id),
          packageId: String(activeSub.packageId),
          package: activeSub.package
            ? {
                id: String(activeSub.package.id),
                name: activeSub.package.name,
                code: activeSub.package.name,
                downloadKbps: activeSub.package.downloadMbps * 1000,
                uploadKbps: activeSub.package.uploadMbps * 1000,
                price: Number(activeSub.package.price),
                validityDays: activeSub.package.validityDays,
                serviceType: activeSub.package.serviceType,
                billingType: activeSub.package.billingType,
                isActive: activeSub.package.isActive,
              }
            : null,
          startDate: activeSub.startDate.toISOString(),
          endDate: activeSub.endDate ? activeSub.endDate.toISOString() : null,
          ipAddress: null,
          pppoeUsername: c.customerNo,
          status: c.status,
        }
      : null,
    onu: c.onu
      ? {
          id: String(c.onu.id),
          serialNumber: c.onu.sn,
          mac: c.onu.mac,
          model: c.onu.model,
          vendor: c.onu.vendor,
          firmware: c.onu.firmware,
          status: mapOnuStatus(c.onu.status),
          rxPowerDbm: c.onu.rxPower,
          txPowerDbm: c.onu.txPower,
          lastSeenAt: c.onu.lastSeen ? c.onu.lastSeen.toISOString() : null,
        }
      : null,
    balance: Number(c.balance),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

const CUSTOMER_INCLUDE = {
  subscriptions: {
    where: { status: 'ACTIVE' as const },
    include: { package: true },
    take: 1,
    orderBy: { startDate: 'desc' as const },
  },
  odpPort: { include: { odp: true } },
  onu: true,
} satisfies Prisma.CustomerInclude;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: NetworkOrchestratorService,
    private readonly radiusSync: RadiusSyncService,
    private readonly oltService: OltService,
  ) {}

  /** Daftar pelanggan dengan pencarian & filter, sesuai kontrak frontend. */
  async findAll(filter: CustomerFilterDto) {
    const { skip, take, page, limit } = paginate(filter.page, filter.limit);
    const where: Prisma.CustomerWhereInput = {};

    if (filter.search) {
      const q = filter.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { customerNo: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { address: { contains: q, mode: 'insensitive' } },
        { odpPort: { odp: { code: { contains: q, mode: 'insensitive' } } } },
      ];
    }
    if (filter.status) where.status = filter.status as CustomerStatus;
    if (filter.packageId) {
      where.subscriptions = {
        some: { packageId: filter.packageId, status: 'ACTIVE' },
      };
    }
    if (filter.odpCode) {
      where.odpPort = {
        odp: { code: { contains: filter.odpCode, mode: 'insensitive' } },
      };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: CUSTOMER_INCLUDE,
      }),
    ]);
    return { data: rows.map(toCustomerDto), meta: buildMeta(total, page, limit) };
  }

  /** Detail pelanggan: langganan aktif, 10 invoice terakhir, ONU, ODP. */
  async findOne(id: number) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        ...CUSTOMER_INCLUDE,
        invoices: {
          orderBy: { issueDate: 'desc' },
          take: 10,
          select: {
            id: true,
            number: true,
            total: true,
            amountPaid: true,
            status: true,
            dueDate: true,
          },
        },
      },
    });
    if (!c) throw new NotFoundException('Pelanggan tidak ditemukan');
    const { invoices, ...rest } = c;
    return {
      ...toCustomerDto(rest as CustomerRow),
      recentInvoices: invoices.map((inv) => ({
        id: String(inv.id),
        invoiceNo: inv.number,
        total: Number(inv.total),
        paidAmount: Number(inv.amountPaid),
        status: inv.status,
        dueDate: inv.dueDate.toISOString(),
      })),
    };
  }

  /** Isolir manual dari konsol NOC. */
  async isolate(id: number, reason: string, actorId: number) {
    await this.ensureExists(id);
    const result = await this.orchestrator.isolateCustomer(
      id,
      reason || 'Isolir manual dari NOC',
    );
    await this.prisma.auditLog.create({
      data: {
        action: 'customer.isolate_manual',
        entity: 'Customer',
        entityId: String(id),
        actorId,
        customerId: id,
        diff: { reason },
      },
    });
    return result;
  }

  /** Aktifkan kembali + sinkronisasi RADIUS. */
  async unisolate(id: number, actorId: number) {
    await this.ensureExists(id);
    const result = await this.orchestrator.unisolateCustomer(id);
    await this.radiusSync.syncCustomer(id).catch((err: unknown) => {
      this.logger.warn(`Radius sync gagal setelah unisolate ${id}: ${String(err)}`);
    });
    await this.prisma.auditLog.create({
      data: {
        action: 'customer.unisolate_manual',
        entity: 'Customer',
        entityId: String(id),
        actorId,
        customerId: id,
        diff: {},
      },
    });
    return result;
  }

  /** Throttle bandwidth manual (tiered isolation). */
  async throttle(id: number, downKbps: number, upKbps: number, actorId: number) {
    await this.ensureExists(id);
    const result = await this.orchestrator.throttleCustomer(id, downKbps, upKbps);
    await this.prisma.auditLog.create({
      data: {
        action: 'customer.throttle_manual',
        entity: 'Customer',
        entityId: String(id),
        actorId,
        customerId: id,
        diff: { downKbps, upKbps },
      },
    });
    return result;
  }

  /** Tendang sesi PPPoE aktif pelanggan. */
  async kickSession(id: number, actorId: number) {
    await this.ensureExists(id);
    const result = await this.orchestrator.kickCustomerSession(id);
    await this.prisma.auditLog.create({
      data: {
        action: 'customer.kick_session',
        entity: 'Customer',
        entityId: String(id),
        actorId,
        customerId: id,
        diff: {},
      },
    });
    return result;
  }

  /** Reboot ONU milik pelanggan via driver OLT. */
  async rebootOnu(id: number, actorId: number) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: { onu: true },
    });
    if (!c) throw new NotFoundException('Pelanggan tidak ditemukan');
    if (!c.onu) {
      throw new BadRequestException(
        'Pelanggan tidak memiliki ONU terdaftar — reboot dibatalkan',
      );
    }
    const result = await this.oltService.rebootOnu(c.onu.id);
    await this.prisma.auditLog.create({
      data: {
        action: 'customer.reboot_onu',
        entity: 'Onu',
        entityId: String(c.onu.id),
        actorId,
        customerId: id,
        diff: { sn: c.onu.sn },
      },
    });
    return result;
  }

  private async ensureExists(id: number) {
    const exists = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Pelanggan tidak ditemukan');
  }
}
