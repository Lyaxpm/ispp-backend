import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../modules/auth/guards/roles.guard';
import { Roles } from '../modules/auth/decorators/roles.decorator';

class NocFilterDto {
  /**
   * Filter konektivitas versi frontend: ALL | ONLINE | OFFLINE.
   * ONLINE = ONU status ONLINE atau ada sesi RADIUS yang masih terbuka.
   */
  @IsOptional()
  @IsIn(['ALL', 'ONLINE', 'OFFLINE'])
  status?: 'ALL' | 'ONLINE' | 'OFFLINE';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  limit?: number;
}

/**
 * Konsol NOC: tabel pelanggan dengan status online/offline real-time,
 * IP teralokasi, dan daya optik ONU. "Online" ditentukan dari status ONU
 * terakhir ATAU sesi RADIUS (radacct) yang masih terbuka.
 *
 * Mengembalikan array polos (bukan {data,meta}) sesuai kontrak frontend.
 */
@Controller('network/noc')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'NOC')
export class NocController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('customers')
  async getNocCustomers(@Query() filter: NocFilterDto) {
    const limit = filter.limit ?? 500;

    // Username dengan sesi RADIUS terbuka — dipakai untuk filter & badge online.
    const openSessions = await this.prisma.radAcct.findMany({
      where: { acctStopTime: null },
      select: { username: true, framedIpAddress: true },
    });
    const openUsernames = [...new Set(openSessions.map((s) => s.username))];
    const sessionByUser = new Map(openSessions.map((s) => [s.username, s]));

    const and: Prisma.CustomerWhereInput[] = [];
    if (filter.search) {
      const q = filter.search.trim();
      and.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { customerNo: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      });
    }
    const connectivity = filter.status ?? 'ALL';
    if (connectivity === 'ONLINE') {
      and.push({
        OR: [{ onu: { status: 'ONLINE' } }, { customerNo: { in: openUsernames } }],
      });
    } else if (connectivity === 'OFFLINE') {
      and.push({ NOT: { onu: { status: 'ONLINE' } } });
      and.push({ customerNo: { notIn: openUsernames } });
    }
    const where: Prisma.CustomerWhereInput = and.length ? { AND: and } : {};

    const rows = await this.prisma.customer.findMany({
      where,
      take: limit,
      orderBy: { customerNo: 'asc' },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { package: true },
          take: 1,
        },
        onu: true,
        ipAllocation: true,
        staticLease: true,
      },
    });

    const customerNos = rows.map((r) => r.customerNo);
    const framedIps = await this.prisma.radReply.findMany({
      where: {
        username: { in: customerNos },
        attribute: 'Framed-IP-Address',
      },
      select: { username: true, value: true },
    });
    const framedByUser = new Map(framedIps.map((r) => [r.username, r.value]));

    return rows.map((c) => {
      const session = sessionByUser.get(c.customerNo);
      const online = c.onu?.status === 'ONLINE' || session !== undefined;
      const ipAddress =
        c.ipAllocation?.ipAddress ??
        c.staticLease?.ipAddress ??
        session?.framedIpAddress ??
        framedByUser.get(c.customerNo) ??
        null;
      return {
        id: String(c.id),
        customerNo: c.customerNo,
        name: c.name,
        packageName: c.subscriptions[0]?.package?.name ?? '-',
        ipAddress,
        online,
        rxPower: c.onu?.rxPower ?? null,
        status: c.status,
        lastSeenAt: c.onu?.lastSeen ? c.onu.lastSeen.toISOString() : null,
      };
    });
  }
}
