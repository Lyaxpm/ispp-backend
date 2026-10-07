import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { NasType, OltVendor } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/utils/crypto.util';
import { DriverError, OltDriver, RouterDriver } from './network-driver.interface';
import { MikrotikDriver } from './mikrotik.driver';
import { HuaweiOltDriver } from './huawei-olt.driver';
import { ZteOltDriver } from './zte-olt.driver';
import { FiberhomeOltDriver } from './fiberhome-olt.driver';
import { HsgqOltDriver } from './hsgq-olt.driver';

/**
 * DriverFactory — builds, caches and health-checks device drivers.
 *
 * - Cache keys: `router:{nasId}` / `olt:{oltId}`
 * - Drivers are created lazily: credentials are loaded from Prisma,
 *   passwords decrypted (AES-256-GCM via crypto.util), the driver
 *   connected, and a health probe run (RouterOS `/system/resource`,
 *   OLT `connect()` which performs an SNMP/CLI round-trip) before the
 *   driver is cached.
 * - On any health/connect failure the entry is evicted so the next call
 *   builds a fresh driver; callers can also force eviction via
 *   `releaseDriver(key)`.
 */
@Injectable()
export class DriverFactory implements OnModuleDestroy {
  private readonly logger = new Logger(DriverFactory.name);
  private readonly drivers = new Map<string, RouterDriver | OltDriver>();

  constructor(private readonly prisma: PrismaService) {}

  /* ---------------------------------------------------------------- */
  /*  Router drivers                                                   */
  /* ---------------------------------------------------------------- */

  async getRouterDriver(nasId: number): Promise<RouterDriver> {
    const key = `router:${nasId}`;
    const cached = this.drivers.get(key);
    if (cached instanceof RouterDriver) {
      try {
        await cached.getSystemResource(); // health probe
        return cached;
      } catch (err) {
        this.logger.warn(`Health check gagal untuk ${key}, driver di-evict: ${this.errMsg(err)}`);
        await this.evict(key);
      }
    } else if (cached) {
      await this.evict(key);
    }

    const nas = await this.prisma.nasRouter.findUnique({ where: { id: nasId } });
    if (!nas || !nas.isActive) {
      throw new NotFoundException(`NAS router #${nasId} tidak ditemukan atau sedang nonaktif`);
    }
    if (nas.type !== NasType.MIKROTIK) {
      throw new NotFoundException(`Tipe NAS "${nas.type}" belum didukung oleh network driver`);
    }

    const driver = new MikrotikDriver({
      host: nas.host,
      port: nas.apiPort,
      username: nas.username,
      password: nas.passwordEncrypted ? decrypt(nas.passwordEncrypted) : '',
      useTls: nas.useTls,
    });

    try {
      await driver.connect();
      await driver.getSystemResource(); // health probe before caching
    } catch (err) {
      await driver.disconnect().catch(() => undefined);
      this.logger.error(`Gagal konek ke NAS ${nas.name} (${nas.host}): ${this.errMsg(err)}`);
      throw err instanceof DriverError
        ? err
        : new DriverError(`Koneksi ke NAS ${nas.name} gagal`, { host: nas.host, cause: this.errMsg(err) });
    }

    this.drivers.set(key, driver);
    this.logger.log(`Router driver cached: ${key} (${nas.name})`);
    return driver;
  }

  /* ---------------------------------------------------------------- */
  /*  OLT drivers                                                      */
  /* ---------------------------------------------------------------- */

  async getOltDriver(oltId: number): Promise<OltDriver> {
    const key = `olt:${oltId}`;
    const cached = this.drivers.get(key);
    if (cached instanceof OltDriver) {
      try {
        await cached.connect(); // connect() performs an SNMP/CLI round-trip = health probe
        return cached;
      } catch (err) {
        this.logger.warn(`Health check gagal untuk ${key}, driver di-evict: ${this.errMsg(err)}`);
        await this.evict(key);
      }
    } else if (cached) {
      await this.evict(key);
    }

    const olt = await this.prisma.olt.findUnique({ where: { id: oltId } });
    if (!olt) {
      throw new NotFoundException(`OLT #${oltId} tidak ditemukan`);
    }
    if (olt.status !== 'ACTIVE') {
      this.logger.warn(`OLT ${olt.name} berstatus ${olt.status}; koneksi tetap dicoba`);
    }

    const creds = {
      mgmtIp: olt.mgmtIp,
      snmpCommunity: olt.snmpCommunity,
      snmpVersion: olt.snmpVersion,
      sshUsername: olt.sshUsername ?? '',
      sshPassword: olt.sshPasswordEncrypted ? decrypt(olt.sshPasswordEncrypted) : '',
      sshPort: 22,
    };

    let driver: OltDriver;
    switch (olt.vendor) {
      case OltVendor.HUAWEI:
        driver = new HuaweiOltDriver(creds);
        break;
      case OltVendor.ZTE:
        driver = new ZteOltDriver(creds);
        break;
      case OltVendor.FIBERHOME:
        driver = new FiberhomeOltDriver(creds);
        break;
      case OltVendor.HSGQ:
        driver = new HsgqOltDriver(creds);
        break;
      default:
        // e.g. CDATA / HIOSO: known to the schema, no driver yet.
        throw new NotFoundException(`Vendor OLT "${olt.vendor}" belum didukung oleh network driver`);
    }

    try {
      await driver.connect();
    } catch (err) {
      await driver.disconnect().catch(() => undefined);
      this.logger.error(`Gagal konek ke OLT ${olt.name} (${olt.mgmtIp}): ${this.errMsg(err)}`);
      throw err instanceof DriverError
        ? err
        : new DriverError(`Koneksi ke OLT ${olt.name} gagal`, { host: olt.mgmtIp, cause: this.errMsg(err) });
    }

    this.drivers.set(key, driver);
    this.logger.log(`OLT driver cached: ${key} (${olt.name}, ${olt.vendor})`);
    return driver;
  }

  /* ---------------------------------------------------------------- */
  /*  Cache management                                                 */
  /* ---------------------------------------------------------------- */

  /** Force-disconnect and drop a cached driver. Key format `router:{id}` / `olt:{id}`. */
  async releaseDriver(key: string): Promise<void> {
    await this.evict(key);
  }

  private async evict(key: string): Promise<void> {
    const driver = this.drivers.get(key);
    this.drivers.delete(key);
    if (driver) {
      try {
        await driver.disconnect();
      } catch {
        /* best effort */
      }
      this.logger.log(`Driver evicted: ${key}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const key of [...this.drivers.keys()]) {
      await this.evict(key);
    }
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
