import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTIFICATION_PORT, NotificationPort } from '../../modules/notifications/ports/notification.port';
import { DriverFactory } from '../drivers/driver-factory';
import { MikrotikDriver } from '../drivers/mikrotik.driver';
import { DriverError } from '../drivers/network-driver.interface';

const ISOLATED_LIST = 'ISOLATED';
const ISOLATED_REDIRECT_COMMENT = 'ISOLATED_REDIRECT';

interface CustomerWithNas {
  id: number;
  customerNo: string;
  name: string;
  phone: string;
  status: string;
  serviceType: string;
  nasRouterId: number | null;
  onuId: number | null;
  nasRouter: { id: number; name: string; host: string } | null;
}

/**
 * NetworkOrchestratorService — high-level network operations consumed by
 * the billing automation layer (isolation workers, payment webhooks).
 *
 * Every operation is idempotent, writes an AuditLog row, notifies the
 * customer over WhatsApp where appropriate, and throws HttpException
 * with an Indonesian message on failure.
 */
@Injectable()
export class NetworkOrchestratorService {
  private readonly logger = new Logger(NetworkOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: DriverFactory,
    @Inject(NOTIFICATION_PORT) @Optional() private readonly notifications?: NotificationPort,
  ) {}

  /* ---------------------------------------------------------------- */
  /*  Isolation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Isolate a customer: address-list + payment-portal redirect + session
   * kick + RADIUS enforcement flag. Idempotent.
   */
  async isolateCustomer(customerId: number, reason: string): Promise<{ success: boolean; message: string }> {
    const action = 'CUSTOMER_ISOLATE';
    try {
      const customer = await this.loadCustomer(customerId);
      if (customer.status === 'ISOLATED') {
        return { success: true, message: `Pelanggan ${customer.customerNo} sudah dalam status isolir` };
      }
      const driver = await this.requireRouterDriver(customer);
      const username = customer.customerNo;
      const ip = await this.resolveCustomerIp(customer);

      // 1) Address-list (per-IP when known).
      if (ip) {
        await driver.addAddressList({
          list: ISOLATED_LIST,
          address: ip,
          comment: `CUS-${username} ${reason}`.slice(0, 200),
        });
      } else {
        this.logger.warn(`Isolasi ${username}: IP tidak diketahui, lewati address-list (andalkan RADIUS + kick)`);
      }

      // 2) RADIUS enforcement: isolated users get the ISOLATED list on next login.
      await this.upsertRadReply(username, 'Mikrotik-Address-List', ':=', ISOLATED_LIST);

      // 3) Payment-portal redirect rule (global, idempotent upsert).
      const portalIp = await this.getSetting('PAYMENT_PORTAL_IP');
      if (!portalIp) {
        throw new HttpException(
          'Isolasi gagal: Setting PAYMENT_PORTAL_IP belum dikonfigurasi',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      await driver.upsertNatRedirect({
        chain: 'dstnat',
        srcAddressList: ISOLATED_LIST,
        protocol: 'tcp',
        dstPort: '80,443',
        toAddresses: portalIp,
        toPorts: '8080',
        comment: ISOLATED_REDIRECT_COMMENT,
      });

      // 4) Drop the active session so the new state applies immediately.
      await driver.kickPppoeSession(username);

      // 5) Persist + audit + notify.
      await this.prisma.customer.update({ where: { id: customerId }, data: { status: 'ISOLATED' } });
      await this.audit(action, 'Customer', customerId, `Pelanggan ${username} diisolir: ${reason}`);
      await this.notifyWhatsapp(
        customer.phone,
        `Yth. ${customer.name}, layanan internet Anda (ID: ${username}) telah diisolir: ${reason}. Segera lakukan pembayaran untuk aktivasi kembali otomatis.`,
      );
      this.logger.log(`Isolated customer ${username}: ${reason}`);
      return { success: true, message: `Pelanggan ${username} berhasil diisolir` };
    } catch (err) {
      return this.fail(action, customerId, err);
    }
  }

  /** Reverse of isolateCustomer. Idempotent. */
  async unisolateCustomer(customerId: number): Promise<{ success: boolean; message: string }> {
    const action = 'CUSTOMER_UNISOLATE';
    try {
      const customer = await this.loadCustomer(customerId);
      if (customer.status === 'ACTIVE') {
        return { success: true, message: `Pelanggan ${customer.customerNo} sudah aktif` };
      }
      const driver = await this.requireRouterDriver(customer);
      const username = customer.customerNo;
      const ip = await this.resolveCustomerIp(customer);

      if (ip) {
        await driver.removeAddressList(ISOLATED_LIST, ip);
      }
      await this.deleteRadReply(username, 'Mikrotik-Address-List');
      // Force re-auth so the session comes back without isolation attributes.
      await driver.kickPppoeSession(username);

      await this.prisma.customer.update({ where: { id: customerId }, data: { status: 'ACTIVE' } });
      await this.audit(action, 'Customer', customerId, `Isolasi pelanggan ${username} dicabut (pembayaran lunas)`);
      await this.notifyWhatsapp(
        customer.phone,
        `Yth. ${customer.name}, pembayaran Anda telah kami terima. Layanan internet (ID: ${username}) sudah aktif kembali. Terima kasih.`,
      );
      this.logger.log(`Un-isolated customer ${username}`);
      return { success: true, message: `Pelanggan ${username} berhasil diaktivasi kembali` };
    } catch (err) {
      return this.fail(action, customerId, err);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Shaping                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Manual throttle: MikroTik simple queue + RADIUS rate-limit.
   * Status stays ACTIVE.
   */
  async throttleCustomer(
    customerId: number,
    downKbps: number,
    upKbps: number,
    note?: string,
  ): Promise<{ success: boolean; message: string }> {
    const action = 'CUSTOMER_THROTTLE';
    try {
      const customer = await this.loadCustomer(customerId);
      const driver = await this.requireRouterDriver(customer);
      const username = customer.customerNo;
      const ip = await this.resolveCustomerIp(customer);
      if (!ip) {
        throw new HttpException(
          `Throttle gagal: IP pelanggan ${username} tidak diketahui`,
          HttpStatus.BAD_REQUEST,
        );
      }
      await driver.upsertSimpleQueue({
        name: `THROTTLE-${username}`,
        target: ip,
        maxLimit: `${upKbps}k/${downKbps}k`,
        comment: `Throttle manual ${username}${note ? ` - ${note}` : ''}`.slice(0, 200),
      });
      await this.upsertRadReply(
        username,
        'Mikrotik-Rate-Limit',
        '=',
        MikrotikDriver.buildRateLimit(downKbps / 1000, upKbps / 1000),
      );
      await this.audit(
        action,
        'Customer',
        customerId,
        `Pelanggan ${username} di-throttle ke ${downKbps}/${upKbps} kbps (down/up)${note ? `: ${note}` : ''}`,
      );
      return { success: true, message: `Pelanggan ${username} di-throttle ke ${downKbps} kbps` };
    } catch (err) {
      return this.fail(action, customerId, err);
    }
  }

  /**
   * Apply the package speed profile:
   * - PPPoE profile from package.mikrotikProfile (PPPoE customers)
   * - Simple queue, unless the package is RADIUS-managed
   *   (package.radiusRateLimit set) — then any queue is removed
   * - RadReply Mikrotik-Rate-Limit is always synced
   * - Session kick so the new shaping applies immediately
   */
  async applySpeedProfile(customerId: number): Promise<{ success: boolean; message: string }> {
    const action = 'CUSTOMER_APPLY_PROFILE';
    try {
      const customer = await this.loadCustomer(customerId);
      const sub = await this.getActiveSubscription(customerId);
      if (!sub) {
        throw new HttpException(
          `Pelanggan ${customer.customerNo} tidak memiliki langganan aktif`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const pkg = sub.package;
      const driver = await this.requireRouterDriver(customer);
      const username = customer.customerNo;
      const queueName = `CUS-${username}`;

      if (pkg.mikrotikProfile && customer.serviceType === 'PPPOE') {
        await driver.setPppoeProfile(username, pkg.mikrotikProfile);
      }

      if (pkg.radiusRateLimit && pkg.radiusRateLimit.trim() !== '') {
        // RADIUS-only shaping: drop any router-side queue to avoid double shaping.
        await driver.removeSimpleQueue(queueName);
        await driver.removeSimpleQueue(`THROTTLE-${username}`);
        await this.upsertRadReply(username, 'Mikrotik-Rate-Limit', '=', pkg.radiusRateLimit.trim());
      } else {
        const ip = await this.resolveCustomerIp(customer);
        if (ip) {
          await driver.upsertSimpleQueue({
            name: queueName,
            target: ip,
            maxLimit: `${pkg.uploadMbps}M/${pkg.downloadMbps}M`,
            comment: `Paket ${pkg.name} - ${username}`.slice(0, 200),
          });
        }
        await this.upsertRadReply(
          username,
          'Mikrotik-Rate-Limit',
          '=',
          MikrotikDriver.buildRateLimit(pkg.downloadMbps, pkg.uploadMbps),
        );
      }

      await driver.kickPppoeSession(username);
      await this.audit(action, 'Customer', customerId, `Profil kecepatan diterapkan untuk ${username} (paket ${pkg.name})`);
      return { success: true, message: `Profil kecepatan paket ${pkg.name} diterapkan untuk ${username}` };
    } catch (err) {
      return this.fail(action, customerId, err);
    }
  }

  /** Drop the customer's active session(s) immediately. */
  async kickCustomerSession(customerId: number): Promise<{ success: boolean; message: string }> {
    const action = 'CUSTOMER_KICK';
    try {
      const customer = await this.loadCustomer(customerId);
      const driver = await this.requireRouterDriver(customer);
      const result = await driver.kickPppoeSession(customer.customerNo);
      await this.audit(action, 'Customer', customerId, `Sesi pelanggan ${customer.customerNo} diputus manual`);
      return { success: true, message: result.message ?? `Sesi ${customer.customerNo} diputus` };
    } catch (err) {
      return this.fail(action, customerId, err);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private async loadCustomer(customerId: number): Promise<CustomerWithNas> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { nasRouter: true },
    });
    if (!customer) throw new HttpException(`Pelanggan #${customerId} tidak ditemukan`, HttpStatus.NOT_FOUND);
    return customer as unknown as CustomerWithNas;
  }

  private async requireRouterDriver(customer: CustomerWithNas) {
    if (!customer.nasRouterId) {
      throw new HttpException(
        `Pelanggan ${customer.customerNo} belum terhubung ke NAS router`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.factory.getRouterDriver(customer.nasRouterId);
  }

  /**
   * Customer IP resolution order:
   * RadReply Framed-IP-Address -> IpAllocation -> StaticLease.
   */
  private async resolveCustomerIp(customer: CustomerWithNas): Promise<string | null> {
    const reply = await this.prisma.radReply.findFirst({
      where: { username: customer.customerNo, attribute: 'Framed-IP-Address' },
    });
    if (reply?.value?.trim()) return reply.value.trim();
    const alloc = await this.prisma.ipAllocation.findFirst({ where: { customerId: customer.id } });
    if (alloc?.ipAddress?.trim()) return alloc.ipAddress.trim();
    const lease = await this.prisma.staticLease.findFirst({ where: { customerId: customer.id } });
    return lease?.ipAddress?.trim() || null;
  }

  private async getActiveSubscription(customerId: number) {
    return this.prisma.subscription.findFirst({
      where: { customerId, status: 'ACTIVE' },
      include: { package: true },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * RadReply has no unique constraint in the schema, so the upsert is
   * implemented as findFirst -> update/create.
   */
  private async upsertRadReply(username: string, attribute: string, op: string, value: string): Promise<void> {
    const existing = await this.prisma.radReply.findFirst({ where: { username, attribute } });
    if (existing) {
      await this.prisma.radReply.update({ where: { id: existing.id }, data: { op, value } });
    } else {
      await this.prisma.radReply.create({ data: { username, attribute, op, value } });
    }
  }

  private async deleteRadReply(username: string, attribute: string): Promise<void> {
    await this.prisma.radReply.deleteMany({ where: { username, attribute } }); // idempotent
  }

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value?.trim() || null;
  }

  private async audit(action: string, entity: string, entityId: number, description: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          entity,
          entityId: String(entityId),
          diff: { description },
          customerId: entity === 'Customer' ? entityId : undefined,
        },
      });
    } catch (err) {
      // Audit must never break the network operation itself.
      this.logger.warn(`Gagal menulis audit log ${action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Best-effort WhatsApp notification; skipped silently when the port is absent. */
  private async notifyWhatsapp(to: string | null | undefined, message: string): Promise<void> {
    if (!to || !this.notifications) {
      if (!this.notifications) this.logger.warn('NotificationPort tidak terdaftar; notifikasi WA dilewati');
      return;
    }
    try {
      await this.notifications.sendWhatsApp(to, message);
    } catch (err) {
      this.logger.warn(`Gagal mengirim WA ke ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fail(action: string, customerId: number, err: unknown): Promise<never> {
    const cause = err instanceof Error ? err.message : String(err);
    this.logger.error(`${action} gagal (customer #${customerId}): ${cause}`);
    await this.audit(action, 'Customer', customerId, `${action} GAGAL: ${cause}`);
    if (err instanceof HttpException) throw err; // includes NotFoundException
    const status = err instanceof DriverError ? HttpStatus.BAD_GATEWAY : HttpStatus.INTERNAL_SERVER_ERROR;
    throw new HttpException(`Operasi jaringan gagal: ${cause}`, status);
  }
}
