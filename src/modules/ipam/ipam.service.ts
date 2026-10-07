import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  IpAllocationStatus,
  IpPoolType,
  Prisma,
  VlanPurpose,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AllocateIpDto,
  CreatePoolDto,
  CreateStaticLeaseDto,
  CreateVlanDto,
  ReserveIpDto,
} from './dto/ipam.dto';

/**
 * IPAM service: pool IPv4, alokasi otomatis, VLAN, dan static lease.
 *
 * Mengikuti skema Prisma nyata:
 * - IpPool.poolType: enum IpPoolType (PRIVATE | PUBLIC | CGNAT)
 * - IpAllocation.status: enum IpAllocationStatus (FREE | ALLOCATED | RESERVED)
 * - Vlan.purpose: enum VlanPurpose; @@unique([oltId, vlanId])
 * - StaticLease: customerId @unique, ipAddress @unique
 */

// Batas keamanan: pool lebih besar dari /22 (>1022 host) ditolak agar
// createMany tidak meledak (1022 baris untuk /22, 2046 untuk /21, dst).
const MIN_PREFIX = 22;

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new BadRequestException(`IP tidak valid: ${ip}`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

@Injectable()
export class IpamService {
  private readonly logger = new Logger(IpamService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async audit(
    action: string,
    entity: string,
    entityId: string,
    diff?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          entity,
          entityId,
          diff: (diff ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`Gagal menulis audit log: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------ pools

  /**
   * Buat pool + generate baris IpAllocation untuk semua host usable
   * (network & broadcast dikecualikan), dalam batch 50.
   */
  async createPool(dto: CreatePoolDto) {
    const [ipStr, prefixStr] = dto.cidr.split('/');
    const prefix = Number(prefixStr);
    if (prefix < MIN_PREFIX) {
      throw new BadRequestException(
        `Prefix /${prefix} terlalu besar (maks /${MIN_PREFIX}). Pecah menjadi beberapa pool lebih kecil.`,
      );
    }
    const ipInt = ipToInt(ipStr);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ipInt & mask) >>> 0;
    if (network !== (ipInt >>> 0)) {
      throw new BadRequestException(
        `CIDR ${dto.cidr} bukan alamat network (network address: ${intToIp(network)}/${prefix}).`,
      );
    }
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const firstHost = network + 1;
    const lastHost = broadcast - 1;
    if (lastHost < firstHost) {
      throw new BadRequestException(`CIDR ${dto.cidr} tidak punya host usable.`);
    }

    const dupName = await this.prisma.ipPool.findUnique({ where: { name: dto.name } });
    if (dupName) throw new ConflictException(`Nama pool "${dto.name}" sudah dipakai.`);
    const dupCidr = await this.prisma.ipPool.findFirst({ where: { cidr: dto.cidr } });
    if (dupCidr) {
      throw new ConflictException(`Pool CIDR ${dto.cidr} sudah ada (${dupCidr.name}).`);
    }
    if (dto.nasRouterId) {
      const nas = await this.prisma.nasRouter.findUnique({ where: { id: dto.nasRouterId } });
      if (!nas) throw new NotFoundException(`NAS Router id=${dto.nasRouterId} tidak ditemukan.`);
    }
    if (
      dto.gateway &&
      (ipToInt(dto.gateway) < firstHost || ipToInt(dto.gateway) > lastHost)
    ) {
      throw new BadRequestException(`Gateway ${dto.gateway} di luar range host ${dto.cidr}.`);
    }

    const pool = await this.prisma.ipPool.create({
      data: {
        name: dto.name,
        cidr: dto.cidr,
        gateway: dto.gateway ?? null,
        dnsPrimary: dto.dnsPrimary ?? null,
        dnsSecondary: dto.dnsSecondary ?? null,
        poolType: dto.poolType ?? IpPoolType.PRIVATE,
        nasRouterId: dto.nasRouterId ?? null,
        isActive: dto.isActive ?? true,
      },
    });

    // Generate host rows dalam batch.
    const hostCount = lastHost - firstHost + 1;
    const BATCH = 50;
    let created = 0;
    for (let start = firstHost; start <= lastHost; start += BATCH) {
      const end = Math.min(start + BATCH - 1, lastHost);
      const rows = [];
      for (let n = start; n <= end; n++) {
        rows.push({
          poolId: pool.id,
          ipAddress: intToIp(n),
          status: IpAllocationStatus.FREE,
        });
      }
      await this.prisma.ipAllocation.createMany({ data: rows });
      created += rows.length;
    }
    this.logger.log(`Pool ${dto.name} (${dto.cidr}): ${created} IP di-generate.`);
    await this.audit('IP_POOL_CREATE', 'IpPool', String(pool.id), {
      cidr: dto.cidr,
      hostCount: created,
    });
    return { ...pool, generatedHosts: created };
  }

  listPools(activeOnly = false) {
    return this.prisma.ipPool.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { name: 'asc' },
      include: { nasRouter: { select: { name: true } } },
    });
  }

  async getPool(id: number) {
    const pool = await this.prisma.ipPool.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException(`Pool id=${id} tidak ditemukan.`);
    return pool;
  }

  async deletePool(id: number) {
    const pool = await this.getPool(id);
    const used = await this.prisma.ipAllocation.count({
      where: {
        poolId: id,
        status: { in: [IpAllocationStatus.ALLOCATED, IpAllocationStatus.RESERVED] },
      },
    });
    if (used > 0) {
      throw new ConflictException(
        `Pool ${pool.name} tidak bisa dihapus: ${used} IP masih terpakai/reserved.`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.ipAllocation.deleteMany({ where: { poolId: id } }),
      this.prisma.ipPool.delete({ where: { id } }),
    ]);
    await this.audit('IP_POOL_DELETE', 'IpPool', String(id));
    return { deleted: true, id };
  }

  // ------------------------------------------------------------ allocation

  /**
   * Alokasikan 1 IP FREE pertama (urutan numerik) ke pelanggan.
   * Satu pelanggan hanya boleh punya 1 alokasi aktif (customerId @unique).
   */
  async allocateIp(poolId: number, dto: AllocateIpDto) {
    const pool = await this.getPool(poolId);
    if (!pool.isActive) {
      throw new ConflictException(`Pool ${pool.name} tidak aktif.`);
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, customerNo: true },
    });
    if (!customer) throw new NotFoundException(`Pelanggan id=${dto.customerId} tidak ditemukan.`);

    const existing = await this.prisma.ipAllocation.findFirst({
      where: { customerId: dto.customerId, status: IpAllocationStatus.ALLOCATED },
      select: { id: true, ipAddress: true },
    });
    if (existing) {
      throw new ConflictException(
        `Pelanggan ${customer.customerNo} sudah punya IP ${existing.ipAddress}. Lepaskan dulu sebelum alokasi baru.`,
      );
    }

    const alloc = await this.prisma.$transaction(async (tx) => {
      // SKIP LOCKED: aman untuk alokasi konkuren dari banyak worker/request.
      // Urutan numerik via cast ::inet (kolom disimpan sebagai String).
      const rows = await tx.$queryRaw<Array<{ id: number; ipAddress: string }>>`
        SELECT id, "ipAddress" FROM "IpAllocation"
        WHERE "poolId" = ${poolId} AND status = 'FREE'
        ORDER BY "ipAddress"::inet ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      const row = rows[0];
      if (!row) {
        throw new ConflictException(`Pool ${pool.name} kehabisan IP FREE.`);
      }
      return tx.ipAllocation.update({
        where: { id: row.id },
        data: { status: IpAllocationStatus.ALLOCATED, customerId: dto.customerId },
      });
    });

    await this.audit('IP_ALLOCATE', 'IpAllocation', String(alloc.id), {
      poolId,
      customerId: dto.customerId,
      ipAddress: alloc.ipAddress,
    });
    return alloc;
  }

  /** Lepaskan alokasi milik pelanggan (kembali FREE). */
  async releaseIp(customerId: number) {
    const alloc = await this.prisma.ipAllocation.findFirst({
      where: { customerId, status: IpAllocationStatus.ALLOCATED },
      select: { id: true, ipAddress: true },
    });
    if (!alloc) {
      throw new NotFoundException(`Pelanggan id=${customerId} tidak punya IP teralokasi.`);
    }
    await this.prisma.ipAllocation.update({
      where: { id: alloc.id },
      data: { status: IpAllocationStatus.FREE, customerId: null },
    });
    await this.audit('IP_RELEASE', 'Customer', String(customerId), {
      released: [alloc.ipAddress],
    });
    return { released: [alloc.ipAddress] };
  }

  /** Tandai satu IP sebagai RESERVED (tidak ikut alokasi otomatis). */
  async reserveIp(poolId: number, dto: ReserveIpDto) {
    await this.getPool(poolId);
    const row = await this.prisma.ipAllocation.findFirst({
      where: { poolId, ipAddress: dto.ipAddress },
    });
    if (!row) throw new NotFoundException(`IP ${dto.ipAddress} tidak ada di pool id=${poolId}.`);
    if (row.status !== IpAllocationStatus.FREE) {
      throw new ConflictException(
        `IP ${dto.ipAddress} berstatus ${row.status}, tidak bisa di-reserve.`,
      );
    }
    const updated = await this.prisma.ipAllocation.update({
      where: { id: row.id },
      data: { status: IpAllocationStatus.RESERVED },
    });
    await this.audit('IP_RESERVE', 'IpAllocation', String(row.id), {
      ipAddress: dto.ipAddress,
      note: dto.note,
    });
    return updated;
  }

  /** Utilisasi pool: jumlah per status + persen terpakai. */
  async getPoolUtilization(poolId: number) {
    const pool = await this.getPool(poolId);
    const groups = await this.prisma.ipAllocation.groupBy({
      by: ['status'],
      where: { poolId },
      _count: { status: true },
    });
    const counts: Record<string, number> = {
      [IpAllocationStatus.FREE]: 0,
      [IpAllocationStatus.ALLOCATED]: 0,
      [IpAllocationStatus.RESERVED]: 0,
    };
    for (const g of groups) counts[g.status] = g._count.status;
    const total = counts.FREE + counts.ALLOCATED + counts.RESERVED;
    const usedPct =
      total === 0 ? 0 : Math.round(((counts.ALLOCATED + counts.RESERVED) / total) * 1000) / 10;
    return {
      poolId,
      cidr: pool.cidr,
      name: pool.name,
      total,
      free: counts.FREE,
      allocated: counts.ALLOCATED,
      reserved: counts.RESERVED,
      usedPercent: usedPct,
    };
  }

  // ------------------------------------------------------------ VLAN

  async createVlan(dto: CreateVlanDto) {
    if (dto.oltId) {
      const olt = await this.prisma.olt.findUnique({ where: { id: dto.oltId } });
      if (!olt) throw new NotFoundException(`OLT id=${dto.oltId} tidak ditemukan.`);
    }
    const dup = await this.prisma.vlan.findFirst({
      where: { vlanId: dto.vlanId, oltId: dto.oltId ?? null },
    });
    if (dup) {
      throw new ConflictException(
        `VLAN ${dto.vlanId} sudah terdaftar${dto.oltId ? ` di OLT id=${dto.oltId}` : ''}.`,
      );
    }
    const vlan = await this.prisma.vlan.create({
      data: {
        vlanId: dto.vlanId,
        name: dto.name,
        purpose: dto.purpose ?? VlanPurpose.INTERNET,
        oltId: dto.oltId ?? null,
      },
    });
    await this.audit('VLAN_CREATE', 'Vlan', String(vlan.id), {
      vlanId: dto.vlanId,
      name: dto.name,
    });
    return vlan;
  }

  listVlans(oltId?: number) {
    return this.prisma.vlan.findMany({
      where: oltId ? { oltId } : undefined,
      orderBy: { vlanId: 'asc' },
      include: { olt: { select: { name: true } } },
    });
  }

  async deleteVlan(id: number) {
    const vlan = await this.prisma.vlan.findUnique({ where: { id } });
    if (!vlan) throw new NotFoundException(`VLAN id=${id} tidak ditemukan.`);
    await this.prisma.vlan.delete({ where: { id } });
    await this.audit('VLAN_DELETE', 'Vlan', String(id));
    return { deleted: true, id };
  }

  // ------------------------------------------------------------ static lease

  private normalizeMac(mac: string): string {
    return mac.replace(/-/g, ':').toUpperCase();
  }

  async createStaticLease(dto: CreateStaticLeaseDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, customerNo: true },
    });
    if (!customer) throw new NotFoundException(`Pelanggan id=${dto.customerId} tidak ditemukan.`);
    const existingLease = await this.prisma.staticLease.findUnique({
      where: { customerId: dto.customerId },
      select: { id: true },
    });
    if (existingLease) {
      throw new ConflictException(
        `Pelanggan ${customer.customerNo} sudah punya static lease (satu pelanggan = satu lease).`,
      );
    }
    const nas = await this.prisma.nasRouter.findUnique({ where: { id: dto.nasRouterId } });
    if (!nas) throw new NotFoundException(`NAS Router id=${dto.nasRouterId} tidak ditemukan.`);
    const mac = this.normalizeMac(dto.macAddress);
    const dupIp = await this.prisma.staticLease.findUnique({
      where: { ipAddress: dto.ipAddress },
      select: { id: true },
    });
    if (dupIp) throw new ConflictException(`IP ${dto.ipAddress} sudah dipakai static lease lain.`);
    const lease = await this.prisma.staticLease.create({
      data: {
        customerId: dto.customerId,
        macAddress: mac,
        ipAddress: dto.ipAddress,
        nasRouterId: dto.nasRouterId,
      },
    });
    await this.audit('STATIC_LEASE_CREATE', 'StaticLease', String(lease.id), {
      mac,
      ip: dto.ipAddress,
      customerId: dto.customerId,
    });
    return lease;
  }

  listStaticLeases(nasRouterId?: number) {
    return this.prisma.staticLease.findMany({
      where: nasRouterId ? { nasRouterId } : undefined,
      include: { customer: { select: { customerNo: true, name: true } } },
      orderBy: { ipAddress: 'asc' },
    });
  }

  async deleteStaticLease(id: number) {
    const lease = await this.prisma.staticLease.findUnique({ where: { id } });
    if (!lease) throw new NotFoundException(`Static lease id=${id} tidak ditemukan.`);
    await this.prisma.staticLease.delete({ where: { id } });
    await this.audit('STATIC_LEASE_DELETE', 'StaticLease', String(id));
    return { deleted: true, id };
  }
}
