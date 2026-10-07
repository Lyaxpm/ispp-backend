import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NodeStatus, OnuStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
// Kontrak: DriverFactory adalah provider modul network dengan method
// getOltDriver(oltId): Promise<OltDriver>.
import { DriverFactory } from '../../network/drivers/driver-factory';
import { OltDriver } from '../../network/drivers/network-driver.interface';
import { encrypt } from '../../common/utils/crypto.util';
import { CreateOltDto, UpdateOltDto } from './dto/create-olt.dto';
import { CreateOdcDto, CreateOdpDto } from './dto/create-odp.dto';
import { ProvisionOnuDto, ReplaceOnuDto } from './dto/provision-onu.dto';

/**
 * KONVENSI PENYIMPANAN KONFIGURASI ONU (didokumentasikan eksplisit):
 * Model Prisma Onu pada skema ini tidak memiliki kolom lineProfile /
 * serviceProfile / vlanId. Agar zero-touch swap tetap bisa "mempertahankan
 * konfigurasi", kolom `firmware` (String?) dipakai sebagai carrier JSON:
 *   {"lineProfile":"...","serviceProfile":"...","vlanId":10}
 * Bila skema diperluas dengan kolom dedicated, cukup ganti helper
 * readOnuConfig/writeOnuConfig di bawah — seluruh service tetap sama.
 *
 * CATATAN SKEMA:
 * - Olt.vendor: enum OltVendor; Olt.snmpVersion: Int (2|3).
 * - Onu.model & Onu.vendor: required -> diisi default bila DTO kosong.
 * - Onu.ontId: String (disimpan sebagai string, driver memakai number).
 * - Status memakai enum NodeStatus / OnuStatus dari @prisma/client.
 */

interface OnuConfig {
  lineProfile: string;
  serviceProfile: string;
  vlanId: number | null;
}

const ONU_CFG_DEFAULTS: OnuConfig = {
  lineProfile: 'DEFAULT_LINE',
  serviceProfile: 'DEFAULT_SERVICE',
  vlanId: null,
};

function readOnuConfig(firmware: string | null): OnuConfig {
  if (!firmware) return { ...ONU_CFG_DEFAULTS };
  try {
    const parsed = JSON.parse(firmware) as Partial<OnuConfig>;
    if (typeof parsed === 'object' && parsed !== null && 'lineProfile' in parsed) {
      return {
        lineProfile: parsed.lineProfile ?? ONU_CFG_DEFAULTS.lineProfile,
        serviceProfile: parsed.serviceProfile ?? ONU_CFG_DEFAULTS.serviceProfile,
        vlanId: parsed.vlanId ?? null,
      };
    }
  } catch {
    // firmware berisi string versi asli (data lama) — jangan rusak.
  }
  return { ...ONU_CFG_DEFAULTS };
}

function writeOnuConfig(cfg: OnuConfig): string {
  return JSON.stringify(cfg);
}

@Injectable()
export class OltService {
  private readonly logger = new Logger(OltService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly driverFactory: DriverFactory,
  ) {}

  private async audit(
    action: string,
    entity: string,
    entityId: string,
    diff?: Record<string, unknown>,
    actorId?: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          entity,
          entityId,
          diff: (diff ?? {}) as Prisma.InputJsonValue,
          actorId,
        },
      });
    } catch (err) {
      this.logger.warn(`Gagal menulis audit log: ${(err as Error).message}`);
    }
  }

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting
      .findUnique({ where: { key } })
      .catch(() => null);
    return row ? row.value : null;
  }

  /** Penomoran berurutan: PREFIX-<area>-### via Setting seq. */
  private async nextCode(prefix: string, areaCode: string): Promise<string> {
    const seqKey = `${prefix}_SEQ_${areaCode.toUpperCase()}`;
    const current = parseInt((await this.getSetting(seqKey)) ?? '0', 10) || 0;
    const next = current + 1;
    await this.prisma.setting
      .upsert({
        where: { key: seqKey },
        update: { value: String(next) },
        create: { key: seqKey, value: String(next) },
      })
      .catch((err) =>
        this.logger.warn(`Gagal menyimpan seq ${seqKey}: ${(err as Error).message}`),
      );
    return `${prefix}-${areaCode.toUpperCase()}-${String(next).padStart(3, '0')}`;
  }

  // ================================================================ OLT CRUD

  async createOlt(dto: CreateOltDto, actorId?: number) {
    const dupName = await this.prisma.olt.findUnique({ where: { name: dto.name } });
    if (dupName) throw new ConflictException(`Nama OLT "${dto.name}" sudah dipakai.`);
    const dupIp = await this.prisma.olt.findUnique({ where: { mgmtIp: dto.mgmtIp } });
    if (dupIp) throw new ConflictException(`Management IP ${dto.mgmtIp} sudah dipakai OLT lain.`);

    const { sshPassword, snmpVersion, vendor, ...rest } = dto;

    const olt = await this.prisma.olt.create({
      data: {
        ...rest,
        vendor,
        snmpVersion: snmpVersion ?? 2,
        status: dto.status ?? NodeStatus.ACTIVE,
        sshPasswordEncrypted: sshPassword ? encrypt(sshPassword) : null,
      },
    });

    // Auto-generate PON ports: slotCount x ponPerSlot, nama "slot/pon".
    const ponPorts = [];
    for (let slot = 0; slot < dto.slotCount; slot++) {
      for (let pon = 0; pon < dto.ponPerSlot; pon++) {
        ponPorts.push({
          oltId: olt.id,
          slotNo: slot,
          ponNo: pon,
          name: `${slot}/${pon}`,
          status: NodeStatus.ACTIVE,
        });
      }
    }
    await this.prisma.ponPort.createMany({ data: ponPorts });
    this.logger.log(`OLT ${olt.name} dibuat dengan ${ponPorts.length} PON port.`);
    await this.audit('OLT_CREATE', 'Olt', String(olt.id), { name: dto.name }, actorId);
    return { ...olt, ponPortCount: ponPorts.length };
  }

  listOlts(params: { search?: string; skip?: number; take?: number }) {
    return this.prisma.olt.findMany({
      where: params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { mgmtIp: { contains: params.search } },
            ],
          }
        : undefined,
      orderBy: { name: 'asc' },
      skip: params.skip,
      take: params.take ?? 50,
    });
  }

  async getOlt(id: number) {
    const olt = await this.prisma.olt.findUnique({
      where: { id },
      include: { ponPorts: { orderBy: [{ slotNo: 'asc' }, { ponNo: 'asc' }] } },
    });
    if (!olt) throw new NotFoundException(`OLT id=${id} tidak ditemukan.`);
    return olt;
  }

  async updateOlt(id: number, dto: UpdateOltDto, actorId?: number) {
    await this.getOlt(id);
    const { sshPassword, ...rest } = dto;
    const olt = await this.prisma.olt.update({
      where: { id },
      data: {
        ...rest,
        ...(sshPassword !== undefined
          ? { sshPasswordEncrypted: sshPassword ? encrypt(sshPassword) : null }
          : {}),
      },
    });
    await this.audit('OLT_UPDATE', 'Olt', String(id), rest, actorId);
    return olt;
  }

  async deleteOlt(id: number, actorId?: number) {
    await this.getOlt(id);
    const onuCount = await this.prisma.onu.count({ where: { oltId: id } });
    if (onuCount > 0) {
      throw new ConflictException(
        `OLT tidak bisa dihapus: masih ada ${onuCount} ONU terdaftar.`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.ponPort.deleteMany({ where: { oltId: id } }),
      this.prisma.olt.delete({ where: { id } }),
    ]);
    await this.audit('OLT_DELETE', 'Olt', String(id), undefined, actorId);
    return { deleted: true, id };
  }

  // ================================================================ ODC CRUD

  async createOdc(dto: CreateOdcDto, actorId?: number) {
    if (dto.ponPortId) {
      const pon = await this.prisma.ponPort.findUnique({ where: { id: dto.ponPortId } });
      if (!pon) throw new NotFoundException(`PON Port id=${dto.ponPortId} tidak ditemukan.`);
    }
    const code = dto.code ?? (await this.nextCode('ODC', dto.areaCode ?? 'ID'));
    const exists = await this.prisma.odc.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Kode ODC ${code} sudah dipakai.`);
    // areaCode hanya untuk penomoran, bukan kolom skema.
    const data = { ...dto, code, status: dto.status ?? NodeStatus.ACTIVE };
    delete (data as { areaCode?: string }).areaCode;
    const odc = await this.prisma.odc.create({ data });
    await this.audit('ODC_CREATE', 'Odc', String(odc.id), { code }, actorId);
    return odc;
  }

  listOdcs(params: { search?: string; skip?: number; take?: number }) {
    return this.prisma.odc.findMany({
      where: params.search
        ? {
            OR: [
              { code: { contains: params.search, mode: 'insensitive' } },
              { name: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      include: {
        ponPort: { select: { name: true, olt: { select: { name: true } } } },
      },
      orderBy: { code: 'asc' },
      skip: params.skip,
      take: params.take ?? 50,
    });
  }

  async updateOdc(id: number, dto: Partial<CreateOdcDto>, actorId?: number) {
    const odc = await this.prisma.odc.findUnique({ where: { id } });
    if (!odc) throw new NotFoundException(`ODC id=${id} tidak ditemukan.`);
    const { areaCode, code, ...rest } = dto;
    void areaCode;
    const data = {
      ...rest,
      ...(code && code !== odc.code ? { code } : {}),
    };
    if (code && code !== odc.code) {
      const dup = await this.prisma.odc.findUnique({ where: { code } });
      if (dup) throw new ConflictException(`Kode ODC ${code} sudah dipakai.`);
    }
    const updated = await this.prisma.odc.update({ where: { id }, data });
    await this.audit('ODC_UPDATE', 'Odc', String(id), rest, actorId);
    return updated;
  }

  // ================================================================ ODP CRUD

  async createOdp(dto: CreateOdpDto, actorId?: number) {
    if (!dto.odcId && !dto.ponPortId) {
      throw new BadRequestException('ODP harus terhubung ke odcId atau ponPortId.');
    }
    if (dto.odcId) {
      const odc = await this.prisma.odc.findUnique({ where: { id: dto.odcId } });
      if (!odc) throw new NotFoundException(`ODC id=${dto.odcId} tidak ditemukan.`);
    }
    if (dto.ponPortId) {
      const pon = await this.prisma.ponPort.findUnique({ where: { id: dto.ponPortId } });
      if (!pon) throw new NotFoundException(`PON Port id=${dto.ponPortId} tidak ditemukan.`);
    }
    const code = dto.code ?? (await this.nextCode('ODP', dto.areaCode ?? 'ID'));
    const exists = await this.prisma.odp.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Kode ODP ${code} sudah dipakai.`);

    const { areaCode, ...rest } = dto;
    void areaCode; // hanya untuk penomoran, bukan kolom skema
    const odp = await this.prisma.$transaction(async (tx) => {
      const created = await tx.odp.create({
        data: {
          ...rest,
          code,
          status: dto.status ?? NodeStatus.ACTIVE,
          usedPorts: 0,
        },
      });
      const ports = Array.from({ length: dto.capacity }, (_, i) => ({
        odpId: created.id,
        portNo: i + 1,
        status: 'FREE' as const,
      }));
      await tx.odpPort.createMany({ data: ports });
      return created;
    });

    await this.audit(
      'ODP_CREATE',
      'Odp',
      String(odp.id),
      { code, capacity: dto.capacity },
      actorId,
    );
    return { ...odp, portCount: dto.capacity };
  }

  listOdps(params: {
    status?: string;
    search?: string;
    skip?: number;
    take?: number;
  }) {
    return this.prisma.odp.findMany({
      where: {
        ...(params.status ? { status: params.status as NodeStatus } : {}),
        ...(params.search
          ? {
              OR: [
                { code: { contains: params.search, mode: 'insensitive' } },
                { name: { contains: params.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        odc: { select: { code: true, name: true } },
        ponPort: { select: { name: true, olt: { select: { name: true } } } },
      },
      orderBy: { code: 'asc' },
      skip: params.skip,
      take: params.take ?? 50,
    });
  }

  async updateOdp(id: number, dto: Partial<CreateOdpDto>, actorId?: number) {
    const odp = await this.prisma.odp.findUnique({
      where: { id },
      select: { id: true, code: true, capacity: true, usedPorts: true },
    });
    if (!odp) throw new NotFoundException(`ODP id=${id} tidak ditemukan.`);
    const { areaCode, code, capacity, ...rest } = dto;
    void areaCode; // hanya untuk penomoran, bukan kolom skema
    const data = {
      ...rest,
      ...(code && code !== odp.code ? { code } : {}),
    };
    if (code && code !== odp.code) {
      const dup = await this.prisma.odp.findUnique({ where: { code } });
      if (dup) throw new ConflictException(`Kode ODP ${code} sudah dipakai.`);
    }

    if (capacity !== undefined && capacity !== odp.capacity) {
      if (capacity < odp.usedPorts) {
        throw new ConflictException(
          `Kapasitas baru (${capacity}) lebih kecil dari port terpakai (${odp.usedPorts}).`,
        );
      }
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.odpPort.count({ where: { odpId: id } });
        if (capacity > existing) {
          const maxPort = await tx.odpPort.aggregate({
            where: { odpId: id },
            _max: { portNo: true },
          });
          const start = (maxPort._max.portNo ?? 0) + 1;
          const add = Array.from({ length: capacity - existing }, (_, i) => ({
            odpId: id,
            portNo: start + i,
            status: 'FREE' as const,
          }));
          await tx.odpPort.createMany({ data: add });
        } else if (capacity < existing) {
          const freePorts = await tx.odpPort.findMany({
            where: { odpId: id, status: 'FREE' },
            orderBy: { portNo: 'desc' },
            take: existing - capacity,
            select: { id: true },
          });
          if (freePorts.length < existing - capacity) {
            throw new ConflictException(
              'Tidak cukup port FREE untuk dikurangi; ada port USED yang menghalangi.',
            );
          }
          await tx.odpPort.deleteMany({
            where: { id: { in: freePorts.map((p) => p.id) } },
          });
        }
        await tx.odp.update({ where: { id }, data: { ...data, capacity } });
      });
      await this.audit('ODP_UPDATE', 'Odp', String(id), { capacity }, actorId);
      return this.prisma.odp.findUnique({ where: { id } });
    }

    const updated = await this.prisma.odp.update({ where: { id }, data });
    await this.audit('ODP_UPDATE', 'Odp', String(id), rest, actorId);
    return updated;
  }

  async deleteOdp(id: number, actorId?: number) {
    const odp = await this.prisma.odp.findUnique({
      where: { id },
      select: { id: true, code: true, usedPorts: true },
    });
    if (!odp) throw new NotFoundException(`ODP id=${id} tidak ditemukan.`);
    if (odp.usedPorts > 0) {
      throw new ConflictException(
        `ODP ${odp.code} tidak bisa dihapus: ${odp.usedPorts} port masih terpakai.`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.odpPort.deleteMany({ where: { odpId: id } }),
      this.prisma.odp.delete({ where: { id } }),
    ]);
    await this.audit('ODP_DELETE', 'Odp', String(id), { code: odp.code }, actorId);
    return { deleted: true, id };
  }

  // ================================================================ ONU ops

  /** Ambil speed cap: DTO > paket pelanggan (Package.downloadMbps/uploadMbps) > Setting default. */
  private async resolveSpeedCap(
    customerId: number,
    dto: { upMbps?: number; downMbps?: number },
  ): Promise<{ upMbps: number; downMbps: number }> {
    if (dto.upMbps && dto.downMbps) return { upMbps: dto.upMbps, downMbps: dto.downMbps };
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { package: { select: { uploadMbps: true, downloadMbps: true } } },
    });
    const up =
      dto.upMbps ??
      customer?.package?.uploadMbps ??
      parseInt((await this.getSetting('DEFAULT_ONU_UP_MBPS')) ?? '10', 10);
    const down =
      dto.downMbps ??
      customer?.package?.downloadMbps ??
      parseInt((await this.getSetting('DEFAULT_ONU_DOWN_MBPS')) ?? '50', 10);
    return { upMbps: up, downMbps: down };
  }

  /**
   * Provisioning ONU baru untuk pelanggan: registrasi di OLT via driver,
   * set VLAN + speed cap, lalu simpan baris Onu dan tautkan ke Customer.
   */
  async provisionOnu(customerId: number, dto: ProvisionOnuDto, actorId?: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, customerNo: true, onuId: true },
    });
    if (!customer) throw new NotFoundException(`Pelanggan id=${customerId} tidak ditemukan.`);
    if (customer.onuId) {
      throw new ConflictException(
        `Pelanggan ${customer.customerNo} sudah punya ONU (id=${customer.onuId}). Gunakan replace untuk swap.`,
      );
    }
    const dup = await this.prisma.onu.findUnique({
      where: { sn: dto.sn },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException(`SN ${dto.sn} sudah terdaftar sebagai ONU id=${dup.id}.`);
    }
    const ponPort = await this.prisma.ponPort.findFirst({
      where: { oltId: dto.oltId, name: dto.ponPortName },
      include: { olt: { select: { id: true, name: true, vendor: true, status: true } } },
    });
    if (!ponPort) {
      throw new NotFoundException(
        `PON Port "${dto.ponPortName}" tidak ditemukan di OLT id=${dto.oltId}.`,
      );
    }

    const lineProfile =
      dto.lineProfile ?? (await this.getSetting('OLT_DEFAULT_LINE_PROFILE')) ?? 'DEFAULT_LINE';
    const serviceProfile =
      dto.serviceProfile ??
      (await this.getSetting('OLT_DEFAULT_SERVICE_PROFILE')) ??
      'DEFAULT_SERVICE';
    const vlanId =
      dto.vlanId ??
      (parseInt((await this.getSetting('DEFAULT_ONU_VLAN')) ?? '', 10) || null);
    const { upMbps, downMbps } = await this.resolveSpeedCap(customerId, dto);

    const driver: OltDriver = await this.driverFactory.getOltDriver(dto.oltId);

    // 1) Registrasi di OLT (driver mengalokasikan ontId bila tidak disebut).
    let ontIdNum: number;
    try {
      const registered = (await driver.registerOnu({
        ponPort: ponPort.name,
        sn: dto.sn,
        lineProfile,
        serviceProfile,
      })) as unknown as { ontId: number | string };
      ontIdNum = Number(registered?.ontId);
      if (!Number.isInteger(ontIdNum) || ontIdNum < 0) {
        throw new Error('Driver tidak mengembalikan ontId yang valid.');
      }
    } catch (err) {
      throw new ConflictException(
        `Registrasi ONU ${dto.sn} di OLT gagal: ${(err as Error).message}`,
      );
    }

    // 2) VLAN + speed cap. Kegagalan di sini -> rollback registrasi agar
    //    tidak ada ONU yatim di OLT.
    try {
      if (vlanId) await driver.setOnuVlan(ponPort.name, ontIdNum, vlanId);
      await driver.setOnuSpeedCap(ponPort.name, ontIdNum, upMbps, downMbps);
    } catch (err) {
      this.logger.error(`Set VLAN/speed gagal, rollback registrasi: ${(err as Error).message}`);
      await driver.deregisterOnu(ponPort.name, ontIdNum).catch(() => undefined);
      throw new ConflictException(
        `Provisioning VLAN/speed ONU ${dto.sn} gagal: ${(err as Error).message}`,
      );
    }

    // 3) Persistensi. Onu.model & vendor required di skema -> default aman.
    const cfg: OnuConfig = { lineProfile, serviceProfile, vlanId };
    const onu = await this.prisma.$transaction(async (tx) => {
      const created = await tx.onu.create({
        data: {
          sn: dto.sn,
          mac: null,
          model: dto.model ?? 'UNKNOWN',
          vendor: dto.vendor ?? String(ponPort.olt?.vendor ?? 'UNKNOWN'),
          firmware: writeOnuConfig(cfg), // konvensi JSON, lihat header file
          oltId: dto.oltId,
          ponPortId: ponPort.id,
          ontId: String(ontIdNum),
          rxPower: null,
          txPower: null,
          status: OnuStatus.ONLINE,
          lastSeen: new Date(),
          customerId,
        },
      });
      await tx.customer.update({
        where: { id: customerId },
        data: { onuId: created.id },
      });
      return created;
    });

    await this.audit(
      'ONU_PROVISION',
      'Onu',
      String(onu.id),
      { sn: dto.sn, ponPort: ponPort.name, ontId: ontIdNum, vlanId, upMbps, downMbps },
      actorId,
    );
    return onu;
  }

  /**
   * Zero-touch ONU swap: ONU lama di-deregister, ONU baru diregistrasi pada
   * PON port + ontId yang SAMA dengan profile/VLAN/speed yang SAMA, sehingga
   * konfigurasi pelanggan dipertahankan tanpa sentuhan manual.
   */
  async replaceOnuZeroTouch(customerId: number, dto: ReplaceOnuDto, actorId?: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, customerNo: true, onuId: true },
    });
    if (!customer?.onuId) {
      throw new NotFoundException(`Pelanggan id=${customerId} belum punya ONU untuk di-swap.`);
    }
    const oldOnu = await this.prisma.onu.findUnique({
      where: { id: customer.onuId },
      include: { ponPort: { select: { name: true } } },
    });
    if (!oldOnu) throw new NotFoundException(`ONU id=${customer.onuId} tidak ditemukan.`);
    const dup = await this.prisma.onu.findUnique({
      where: { sn: dto.newSn },
      select: { id: true },
    });
    if (dup) throw new ConflictException(`SN ${dto.newSn} sudah terdaftar (ONU id=${dup.id}).`);

    const oldCfg = readOnuConfig(oldOnu.firmware);
    const lineProfile = dto.lineProfile ?? oldCfg.lineProfile;
    const serviceProfile = dto.serviceProfile ?? oldCfg.serviceProfile;
    const vlanId = dto.vlanId ?? oldCfg.vlanId;
    const { upMbps, downMbps } = await this.resolveSpeedCap(customerId, {});
    const ponName = oldOnu.ponPort?.name;
    const ontIdNum = Number(oldOnu.ontId);
    if (!ponName || !Number.isInteger(ontIdNum)) {
      throw new ConflictException('ONU lama tidak punya PON port / ontId yang valid.');
    }
    if (oldOnu.oltId == null) {
      throw new ConflictException('ONU lama tidak terhubung ke OLT manapun.');
    }
    const driver: OltDriver = await this.driverFactory.getOltDriver(oldOnu.oltId);

    // 1) Deregister ONU lama.
    try {
      await driver.deregisterOnu(ponName, ontIdNum);
    } catch (err) {
      throw new ConflictException(
        `Deregister ONU lama gagal: ${(err as Error).message}. Swap dibatalkan agar layanan tidak putus.`,
      );
    }

    // 2) Registrasi ONU baru di ontId yang sama.
    try {
      await driver.registerOnu({
        ponPort: ponName,
        ontId: ontIdNum,
        sn: dto.newSn,
        lineProfile,
        serviceProfile,
      });
      if (vlanId) await driver.setOnuVlan(ponName, ontIdNum, vlanId);
      await driver.setOnuSpeedCap(ponName, ontIdNum, upMbps, downMbps);
    } catch (err) {
      this.logger.error(
        `Swap ONU gagal di tengah jalan: ${(err as Error).message}. ` +
          `ONT ${ontIdNum} di ${ponName} mungkin perlu diregistrasi manual.`,
      );
      throw new ConflictException(
        `Swap gagal setelah deregister: ${(err as Error).message}. ` +
          `Lakukan registrasi manual SN ${dto.newSn} di ${ponName}/${ontIdNum}.`,
      );
    }

    const newCfg: OnuConfig = { lineProfile, serviceProfile, vlanId };
    const updated = await this.prisma.onu.update({
      where: { id: oldOnu.id },
      data: {
        sn: dto.newSn,
        mac: null, // akan terisi saat polling berikutnya
        firmware: writeOnuConfig(newCfg),
        status: OnuStatus.ONLINE,
        lastSeen: new Date(),
      },
    });
    await this.audit(
      'ONU_REPLACE_ZEROTOUCH',
      'Onu',
      String(oldOnu.id),
      {
        oldSn: oldOnu.sn,
        newSn: dto.newSn,
        ponPort: ponName,
        ontId: ontIdNum,
        preserved: newCfg,
      },
      actorId,
    );
    return updated;
  }

  async rebootOnu(onuId: number, actorId?: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      include: { ponPort: { select: { name: true } } },
    });
    if (!onu) throw new NotFoundException(`ONU id=${onuId} tidak ditemukan.`);
    const ponName = onu.ponPort?.name;
    const ontIdNum = Number(onu.ontId);
    if (!ponName || !Number.isInteger(ontIdNum) || onu.oltId == null) {
      throw new ConflictException('ONU tidak punya PON port / ontId / OLT yang valid.');
    }
    const driver: OltDriver = await this.driverFactory.getOltDriver(onu.oltId);
    await driver.rebootOnu(ponName, ontIdNum);
    await this.audit('ONU_REBOOT', 'Onu', String(onuId), { sn: onu.sn }, actorId);
    return { rebooted: true, onuId, sn: onu.sn };
  }

  /** Baca daya optik via driver lalu simpan ke rxPower/txPower/lastSeen. */
  async readOpticalPower(onuId: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      include: { ponPort: { select: { name: true } } },
    });
    if (!onu) throw new NotFoundException(`ONU id=${onuId} tidak ditemukan.`);
    const ponName = onu.ponPort?.name;
    const ontIdNum = Number(onu.ontId);
    if (!ponName || !Number.isInteger(ontIdNum) || onu.oltId == null) {
      throw new ConflictException('ONU tidak punya PON port / ontId / OLT yang valid.');
    }
    const driver: OltDriver = await this.driverFactory.getOltDriver(onu.oltId);
    const power = await driver.getOnuOpticalPower(ponName, ontIdNum);
    const degraded = power.rxDbm != null && power.rxDbm < -27;
    const status = degraded ? OnuStatus.DEGRADED : OnuStatus.ONLINE;
    await this.prisma.onu.update({
      where: { id: onuId },
      data: { rxPower: power.rxDbm, txPower: power.txDbm, lastSeen: new Date(), status },
    });
    return { onuId, sn: onu.sn, rxDbm: power.rxDbm, txDbm: power.txDbm, status };
  }

  async discoverUnconfigured(oltId: number, actorId?: number) {
    const olt = await this.getOlt(oltId);
    const driver: OltDriver = await this.driverFactory.getOltDriver(oltId);
    const found = await driver.discoverUnconfiguredOnus();
    await this.audit(
      'OLT_DISCOVER',
      'Olt',
      String(oltId),
      { found: Array.isArray(found) ? found.length : 0 },
      actorId,
    );
    return { olt: olt.name, unconfigured: found };
  }

  async onuStatus(onuId: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id: onuId },
      include: { ponPort: { select: { name: true } } },
    });
    if (!onu) throw new NotFoundException(`ONU id=${onuId} tidak ditemukan.`);
    const ponName = onu.ponPort?.name;
    const ontIdNum = Number(onu.ontId);
    let status: 'online' | 'offline' | 'los' = 'offline';
    if (ponName && Number.isInteger(ontIdNum) && onu.oltId != null) {
      const driver: OltDriver = await this.driverFactory.getOltDriver(onu.oltId);
      status = await driver.getOnuStatus(ponName, ontIdNum);
    }
    const mapped =
      status === 'online' ? OnuStatus.ONLINE : status === 'los' ? OnuStatus.LOS : OnuStatus.OFFLINE;
    await this.prisma.onu.update({
      where: { id: onuId },
      data: { status: mapped, lastSeen: new Date() },
    });
    return { onuId, sn: onu.sn, status };
  }

  listOnus(params: {
    oltId?: number;
    status?: string;
    search?: string;
    skip?: number;
    take?: number;
  }) {
    return this.prisma.onu.findMany({
      where: {
        ...(params.oltId ? { oltId: params.oltId } : {}),
        ...(params.status ? { status: params.status as OnuStatus } : {}),
        ...(params.search
          ? {
              OR: [
                { sn: { contains: params.search, mode: 'insensitive' } },
                { mac: { contains: params.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        olt: { select: { name: true } },
        ponPort: { select: { name: true } },
        customer: { select: { customerNo: true, name: true } },
      },
      orderBy: { lastSeen: 'desc' },
      skip: params.skip,
      take: params.take ?? 50,
    });
  }

  async deleteOnu(id: number, actorId?: number) {
    const onu = await this.prisma.onu.findUnique({
      where: { id },
      include: { ponPort: { select: { name: true } } },
    });
    if (!onu) throw new NotFoundException(`ONU id=${id} tidak ditemukan.`);
    const ponName = onu.ponPort?.name;
    const ontIdNum = Number(onu.ontId);
    if (ponName && Number.isInteger(ontIdNum) && onu.oltId != null) {
      const driver: OltDriver = await this.driverFactory.getOltDriver(onu.oltId);
      await driver
        .deregisterOnu(ponName, ontIdNum)
        .catch((err: unknown) =>
          this.logger.warn(`Deregister OLT gagal saat hapus ONU: ${(err as Error).message}`),
        );
    }
    await this.prisma.$transaction([
      this.prisma.customer.updateMany({ where: { onuId: id }, data: { onuId: null } }),
      this.prisma.onu.delete({ where: { id } }),
    ]);
    await this.audit('ONU_DELETE', 'Onu', String(id), { sn: onu.sn }, actorId);
    return { deleted: true, id };
  }
}
