import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';

/**
 * Adapter GenieACS (TR-069 ACS) via REST API.
 *
 * Konfigurasi (env):
 *   GENIEACS_URL  - mis. http://acs.internal:7557
 *   GENIEACS_USER / GENIEACS_PASS - basic auth (opsional)
 *
 * deviceId: biasanya serial number ONU (kolom Onu.sn), yang juga dipakai
 * sebagai _id device di GenieACS. Bila deployment memakai format
 * "OUI-SN-..." sesuaikan di sisi pemanggil.
 *
 * Path parameter memakai model TR-098 (InternetGatewayDevice.*). Untuk CPE
 * TR-181 (Device.*), GenieACS umumnya tetap menerima path TR-098 via
 * alias — bila tidak, sesuaikan konstanta path di bawah.
 */

const REQUEST_TIMEOUT_MS = 15000;
const FIRMWARE_PUSH_CONCURRENCY = 5;

// TR-098 paths
const P_WIFI_SSID = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID';
const P_WIFI_KEY = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase';
const P_PPPOE_USER = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username';
const P_PPPOE_PASS = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password';

export interface GenieAcsDevice {
  _id: string;
  _lastInform?: string;
  [key: string]: unknown;
}

export interface OpticalStats {
  rxDbm: number | null;
  txDbm: number | null;
}

export interface FirmwarePushResult {
  deviceId: string;
  ok: boolean;
  taskId?: string;
  error?: string;
}

type ParamValue = string | number | boolean;

@Injectable()
export class GenieAcsService {
  private readonly logger = new Logger(GenieAcsService.name);
  private readonly http: AxiosInstance;
  private readonly enabled: boolean;

  constructor() {
    const baseURL = (process.env.GENIEACS_URL ?? '').replace(/\/+$/, '');
    this.enabled = baseURL.length > 0;
    this.http = axios.create({
      baseURL: baseURL || 'http://127.0.0.1:7557',
      timeout: REQUEST_TIMEOUT_MS,
      auth:
        process.env.GENIEACS_USER && process.env.GENIEACS_PASS
          ? { username: process.env.GENIEACS_USER, password: process.env.GENIEACS_PASS }
          : undefined,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!this.enabled) {
      this.logger.warn('GENIEACS_URL belum diset — semua panggilan TR-069 akan gagal dengan jelas.');
    }
  }

  private ensureEnabled(): void {
    if (!this.enabled) {
      throw new HttpException(
        'Integrasi GenieACS belum dikonfigurasi (GENIEACS_URL kosong).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private toHttpException(err: unknown, context: string): HttpException {
    const ax = err as AxiosError<{ message?: string }>;
    if (ax.response) {
      const status = ax.response.status;
      const msg =
        (ax.response.data as { message?: string } | undefined)?.message ??
        ax.message;
      this.logger.error(`${context}: HTTP ${status} — ${msg}`);
      return new HttpException(
        `GenieACS ${context} gagal (HTTP ${status}): ${msg}`,
        status >= 500 ? HttpStatus.BAD_GATEWAY : status,
      );
    }
    if (ax.code === 'ECONNABORTED' || ax.message?.includes('timeout')) {
      this.logger.error(`${context}: timeout ${REQUEST_TIMEOUT_MS}ms`);
      return new HttpException(
        `GenieACS ${context} timeout (${REQUEST_TIMEOUT_MS}ms).`,
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    this.logger.error(`${context}: ${ax.message}`);
    return new HttpException(
      `GenieACS ${context} gagal: ${ax.message}`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  private inferXsdType(value: ParamValue): string {
    if (typeof value === 'boolean') return 'xsd:boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'xsd:int' : 'xsd:double';
    return 'xsd:string';
  }

  // ------------------------------------------------------------- devices

  /** Ambil device GenieACS berdasarkan _id. */
  async getDevice(deviceId: string): Promise<GenieAcsDevice | null> {
    this.ensureEnabled();
    try {
      const res = await this.http.get<GenieAcsDevice[]>(
        `/devices/?query=${encodeURIComponent(JSON.stringify({ _id: deviceId }))}`,
      );
      const device = Array.isArray(res.data) ? res.data[0] : null;
      return device ?? null;
    } catch (err) {
      throw this.toHttpException(err, `getDevice(${deviceId})`);
    }
  }

  /** Antrekan task GenieACS (device harus online / menunggu inform berikutnya). */
  private async createTask(
    deviceId: string,
    task: Record<string, unknown>,
  ): Promise<string> {
    this.ensureEnabled();
    try {
      const res = await this.http.post<{ _id: string }>(
        `/devices/${encodeURIComponent(deviceId)}/tasks`,
        task,
      );
      const taskId = (res.data as { _id?: string })?._id ?? '';
      this.logger.log(`Task GenieACS dibuat: ${task.name} -> ${deviceId} (task ${taskId})`);
      return taskId;
    } catch (err) {
      throw this.toHttpException(err, `createTask(${(task as { name?: string }).name})`);
    }
  }

  /**
   * Set beberapa parameter sekaligus.
   * params: { "InternetGatewayDevice....SSID": "MyWifi" }
   */
  async setParameterValues(
    deviceId: string,
    params: Record<string, ParamValue>,
  ): Promise<{ taskId: string; count: number }> {
    const entries = Object.entries(params);
    if (entries.length === 0) {
      throw new HttpException('params tidak boleh kosong.', HttpStatus.BAD_REQUEST);
    }
    const parameterValues = entries.map(([path, value]) => [
      path,
      value,
      this.inferXsdType(value),
    ]);
    const taskId = await this.createTask(deviceId, {
      name: 'setParameterValues',
      parameterValues,
    });
    return { taskId, count: entries.length };
  }

  async reboot(deviceId: string): Promise<{ taskId: string }> {
    const taskId = await this.createTask(deviceId, { name: 'reboot' });
    return { taskId };
  }

  async factoryReset(deviceId: string): Promise<{ taskId: string }> {
    const taskId = await this.createTask(deviceId, { name: 'factoryReset' });
    return { taskId };
  }

  // ------------------------------------------------------------- WiFi & WAN

  /** Set SSID + password WiFi 2.4G utama (WLANConfiguration.1). */
  async setWifiSsid(
    deviceId: string,
    ssid: string,
    password: string,
  ): Promise<{ taskId: string }> {
    const { taskId } = await this.setParameterValues(deviceId, {
      [P_WIFI_SSID]: ssid,
      [P_WIFI_KEY]: password,
    });
    return { taskId };
  }

  /** Set kredensial PPPoE pada WAN connection pertama. */
  async setPppoeWan(
    deviceId: string,
    username: string,
    password: string,
  ): Promise<{ taskId: string }> {
    const { taskId } = await this.setParameterValues(deviceId, {
      [P_PPPOE_USER]: username,
      [P_PPPOE_PASS]: password,
    });
    return { taskId };
  }

  // ------------------------------------------------------------- firmware

  /**
   * Push firmware massal via task 'download'.
   * CATATAN: firmwareUrl harus merujuk ke file yang sudah terdaftar di
   * GenieACS (menu Files / via API /files) — GenieACS tidak mengunduh dari
   * URL eksternal sembarangan.
   */
  async pushFirmware(
    deviceIds: string[],
    firmwareUrl: string,
  ): Promise<FirmwarePushResult[]> {
    this.ensureEnabled();
    const results: FirmwarePushResult[] = [];
    for (let i = 0; i < deviceIds.length; i += FIRMWARE_PUSH_CONCURRENCY) {
      const chunk = deviceIds.slice(i, i + FIRMWARE_PUSH_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(async (deviceId) => {
          const taskId = await this.createTask(deviceId, {
            name: 'download',
            fileType: '1 Firmware Upgrade Image',
            file: firmwareUrl,
          });
          return { deviceId, taskId };
        }),
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        const deviceId = chunk[j];
        if (s.status === 'fulfilled') {
          results.push({ deviceId, ok: true, taskId: s.value.taskId });
        } else {
          results.push({
            deviceId,
            ok: false,
            error: (s.reason as Error)?.message ?? 'unknown error',
          });
        }
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    this.logger.log(`Firmware push: ${okCount}/${deviceIds.length} task dibuat.`);
    return results;
  }

  // ------------------------------------------------------------- optical

  /**
   * Baca statistik optik dari device GenieACS.
   * Menavigasi struktur GenieACS dengan aman (nilai terbungkus {_value}).
   */
  async getOpticalStats(deviceId: string): Promise<OpticalStats | null> {
    const device = await this.getDevice(deviceId);
    if (!device) return null;

    const unwrap = (node: unknown): unknown => {
      if (node && typeof node === 'object' && '_value' in (node as object)) {
        return (node as { _value: unknown })._value;
      }
      return node;
    };

    // Cari node WANPONInterfaceConfig di bawah WANDevice.* manapun.
    const findPonConfig = (obj: unknown, depth = 0): Record<string, unknown> | null => {
      if (!obj || typeof obj !== 'object' || depth > 6) return null;
      const rec = obj as Record<string, unknown>;
      for (const [key, val] of Object.entries(rec)) {
        if (/^WANPONInterfaceConfig(\.|$)/.test(key) && val && typeof val === 'object') {
          return val as Record<string, unknown>;
        }
        const child = key === '_value' ? null : findPonConfig(val, depth + 1);
        if (child) return child;
      }
      return null;
    };

    const igd = (device as Record<string, unknown>)['InternetGatewayDevice'];
    const dev181 = (device as Record<string, unknown>)['Device'];
    const ponCfg = findPonConfig(igd) ?? findPonConfig(dev181);
    if (!ponCfg) {
      this.logger.warn(`getOpticalStats(${deviceId}): WANPONInterfaceConfig tidak ditemukan.`);
      return null;
    }

    const toDbm = (v: unknown): number | null => {
      const raw = unwrap(v);
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };

    const rxDbm =
      toDbm(ponCfg['RXPower']) ??
      toDbm(ponCfg['RxPower']) ??
      toDbm(ponCfg['X_BROADCOM_COM_RxPower']);
    const txDbm =
      toDbm(ponCfg['TXPower']) ??
      toDbm(ponCfg['TxPower']) ??
      toDbm(ponCfg['X_BROADCOM_COM_TxPower']);
    if (rxDbm == null && txDbm == null) return null;
    return { rxDbm, txDbm };
  }
}
