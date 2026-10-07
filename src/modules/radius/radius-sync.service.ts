import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * RadiusSyncService — keeps the FreeRADIUS tables (radcheck / radreply)
 * in sync with billing state.
 *
 * - radcheck : Cleartext-Password, Simultaneous-Use, Session-Timeout, Expiration
 * - radreply : Mikrotik-Rate-Limit, Framed-IP-Address, Mikrotik-Address-List
 *              (:= 'ISOLATED' while the customer is isolated, so the NAS
 *              enforces isolation at login even for dynamic IPs)
 *
 * NOTE on passwords: the Customer model has no password column.
 * Production should add one (encrypted). Until then the working
 * mechanism is resolvePppoePassword(): per-customer Setting
 * `PPPOE_PASSWORD_<customerNo>`, falling back to `PPPOE_DEFAULT_PASSWORD`.
 */
@Injectable()
export class RadiusSyncService {
  private readonly logger = new Logger(RadiusSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* ---------------------------------------------------------------- */
  /*  Single customer sync                                             */
  /* ---------------------------------------------------------------- */

  async syncCustomer(customerId: number): Promise<{ username: string; synced: string[] }> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Pelanggan #${customerId} tidak ditemukan`);
    const username = customer.customerNo;
    const synced: string[] = [];

    // --- radcheck: authentication (@@unique([username, attribute]) -> upsert) ---
    const password = await this.resolvePppoePassword(username);
    await this.upsertCheck(username, 'Cleartext-Password', ':=', password);
    await this.upsertCheck(username, 'Simultaneous-Use', ':=', '1');
    synced.push('Cleartext-Password', 'Simultaneous-Use');

    // --- package-dependent attributes ---
    const sub = await this.prisma.subscription.findFirst({
      where: { customerId, status: 'ACTIVE' },
      include: { package: true },
      orderBy: { id: 'desc' },
    });

    if (sub?.package) {
      const pkg = sub.package;
      // validityDays = 0 means unlimited -> fall back to 30 days.
      const validityDays = pkg.validityDays > 0 ? pkg.validityDays : 30;
      await this.upsertCheck(username, 'Session-Timeout', ':=', String(validityDays * 86400));
      synced.push('Session-Timeout');

      if (sub.endDate) {
        await this.upsertCheck(username, 'Expiration', ':=', RadiusSyncService.formatExpiration(sub.endDate));
        synced.push('Expiration');
      } else {
        await this.deleteCheck(username, 'Expiration');
      }

      await this.upsertReply(username, 'Mikrotik-Rate-Limit', '=', this.buildRateLimitKbps(pkg.uploadMbps, pkg.downloadMbps));
      synced.push('Mikrotik-Rate-Limit');
    }

    // --- radreply: addressing (IpAllocation is the source of truth) ---
    const ip = await this.resolveAllocatedIp(customerId);
    if (ip) {
      await this.upsertReply(username, 'Framed-IP-Address', '=', ip);
      synced.push('Framed-IP-Address');
    } else {
      await this.deleteReply(username, 'Framed-IP-Address');
    }

    // --- radreply: isolation enforcement ---
    if (customer.status === 'ISOLATED') {
      await this.upsertReply(username, 'Mikrotik-Address-List', ':=', 'ISOLATED');
      synced.push('Mikrotik-Address-List=ISOLATED');
    } else {
      await this.deleteReply(username, 'Mikrotik-Address-List');
    }

    this.logger.debug(`RADIUS sync ${username}: ${synced.join(', ')}`);
    return { username, synced };
  }

  /** Delete a customer's RADIUS identity (radcheck + radreply). radacct history is kept. */
  async removeCustomer(username: string): Promise<void> {
    await this.prisma.radCheck.deleteMany({ where: { username } });
    await this.prisma.radReply.deleteMany({ where: { username } });
    this.logger.log(`RADIUS identity dihapus untuk ${username}`);
  }

  /** Full resync with batch pagination and progress logging. */
  async syncAll(batchSize = 200): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    let skip = 0;
    for (;;) {
      const batch = await this.prisma.customer.findMany({
        skip,
        take: batchSize,
        orderBy: { id: 'asc' },
        select: { id: true, customerNo: true },
      });
      if (batch.length === 0) break;
      for (const c of batch) {
        try {
          await this.syncCustomer(c.id);
          synced++;
        } catch (err) {
          failed++;
          this.logger.warn(`RADIUS sync gagal untuk ${c.customerNo}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      skip += batch.length;
      this.logger.log(`RADIUS sync progress: ${synced + failed} diproses (${synced} ok, ${failed} gagal)`);
    }
    this.logger.log(`RADIUS sync selesai: ${synced} ok, ${failed} gagal`);
    return { synced, failed };
  }

  /* ---------------------------------------------------------------- */
  /*  Password resolution                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Working password source under the current schema: per-customer Setting
   * `PPPOE_PASSWORD_<customerNo>`, then `PPPOE_DEFAULT_PASSWORD`.
   */
  async resolvePppoePassword(customerNo: string): Promise<string> {
    const perCustomer = await this.getSetting(`PPPOE_PASSWORD_${customerNo}`);
    if (perCustomer) return perCustomer;
    const fallback = await this.getSetting('PPPOE_DEFAULT_PASSWORD');
    return fallback || 'changeme123';
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private async resolveAllocatedIp(customerId: number): Promise<string | null> {
    const alloc = await this.prisma.ipAllocation.findFirst({ where: { customerId } });
    return alloc?.ipAddress?.trim() || null;
  }

  /**
   * RouterOS/RADIUS rate-limit in kbps units:
   * `up/down burstUp/burstDown thrUp/thrDown 8/8`
   * (rx = customer upload, tx = customer download).
   */
  private buildRateLimitKbps(upMbps: number, downMbps: number, burstFactor = 1.5): string {
    const k = (mbps: number, mul = 1): string => `${Math.max(1, Math.round(mbps * 1000 * mul))}k`;
    return `${k(upMbps)}/${k(downMbps)} ${k(upMbps, burstFactor)}/${k(downMbps, burstFactor)} ${k(upMbps, 0.8)}/${k(downMbps, 0.8)} 8/8`;
  }

  /** FreeRADIUS Expiration format: "27 Oct 2026 23:59:59". */
  private static formatExpiration(date: Date): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  private async upsertCheck(username: string, attribute: string, op: string, value: string): Promise<void> {
    await this.prisma.radCheck.upsert({
      where: { username_attribute: { username, attribute } },
      update: { op, value },
      create: { username, attribute, op, value },
    });
  }

  private async deleteCheck(username: string, attribute: string): Promise<void> {
    await this.prisma.radCheck
      .delete({ where: { username_attribute: { username, attribute } } })
      .catch(() => undefined);
  }

  /**
   * RadReply has no unique constraint in the schema, so the upsert is
   * implemented as findFirst -> update/create.
   */
  private async upsertReply(username: string, attribute: string, op: string, value: string): Promise<void> {
    const existing = await this.prisma.radReply.findFirst({ where: { username, attribute } });
    if (existing) {
      await this.prisma.radReply.update({ where: { id: existing.id }, data: { op, value } });
    } else {
      await this.prisma.radReply.create({ data: { username, attribute, op, value } });
    }
  }

  private async deleteReply(username: string, attribute: string): Promise<void> {
    await this.prisma.radReply.deleteMany({ where: { username, attribute } }); // idempotent
  }

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value?.trim() || null;
  }
}
