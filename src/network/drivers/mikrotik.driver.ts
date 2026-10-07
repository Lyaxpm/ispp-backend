import { RouterOSAPI } from 'node-routeros';
import {
  ActiveSession,
  AddressListEntry,
  DriverError,
  DriverResult,
  NatRedirectRule,
  PppoeSecret,
  RouterCredentials,
  RouterDriver,
  SimpleQueue,
} from './network-driver.interface';

type RosRow = Record<string, string>;

const MAX_RECONNECT_ATTEMPTS = 5;
const API_TIMEOUT_SEC = 10;

/**
 * MikroTik RouterOS API driver built on `node-routeros`.
 *
 * Every mutating command goes through the per-host write mutex inherited
 * from RouterDriver, so concurrent callers for the same NAS can never
 * interleave API sentences.
 */
export class MikrotikDriver extends RouterDriver {
  protected readonly hostKey: string;

  private readonly creds: RouterCredentials;
  private api: RouterOSAPI | null = null;
  private connected = false;
  private manualClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(creds: RouterCredentials) {
    super();
    this.creds = { ...creds };
    this.hostKey = `router:${creds.host}:${creds.port}`;
  }

  /* ---------------------------------------------------------------- */
  /*  Connection management                                            */
  /* ---------------------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.connected && this.api) return;
    this.manualClose = false;
    await this.doConnect();
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.api) {
      try {
        this.api.close();
      } catch {
        /* best effort */
      }
      this.api = null;
    }
    this.connected = false;
  }

  private async doConnect(): Promise<void> {
    const { host, port, username, password, useTls } = this.creds;
    const api = new RouterOSAPI({
      host,
      port,
      user: username,
      password,
      timeout: API_TIMEOUT_SEC,
      keepalive: true,
      ...(useTls ? { tls: {} } : {}),
    });

    api.on('error', (err: Error) => void this.onConnectionIssue('error', err));
    api.on('close', () => void this.onConnectionIssue('close'));

    try {
      await api.connect();
    } catch (err) {
      this.connected = false;
      throw new DriverError('Failed to connect to MikroTik RouterOS API', {
        host,
        port,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    this.api = api;
    this.connected = true;
    this.reconnectAttempts = 0;
  }

  private async onConnectionIssue(kind: 'error' | 'close', err?: Error): Promise<void> {
    this.connected = false;
    if (this.manualClose) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // Exhausted: drop the stale handle; next explicit write will reconnect.
      this.api = null;
      return;
    }
    this.reconnectAttempts += 1;
    const backoffMs = 2 ** this.reconnectAttempts * 1000;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose || this.connected) return;
      this.doConnect().catch(() => {
        // doConnect threw a DriverError already; schedule the next attempt.
        void this.onConnectionIssue(kind, err);
      });
    }, backoffMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  private async ensureConnected(): Promise<RouterOSAPI> {
    if (!this.connected || !this.api) {
      await this.doConnect();
    }
    if (!this.api) {
      throw new DriverError('MikroTik API handle unavailable after reconnect', {
        host: this.creds.host,
      });
    }
    return this.api;
  }

  /** Low-level write wrapper: normalizes rows and converts failures to DriverError. */
  private async rosWrite(path: string, params: string[] = []): Promise<RosRow[]> {
    const api = await this.ensureConnected();
    try {
      const raw = (await api.write(path, params)) as unknown;
      const rows = Array.isArray(raw) ? (raw as RosRow[]) : [];
      // A successful write also proves the link is alive: reset backoff.
      this.reconnectAttempts = 0;
      return rows;
    } catch (err) {
      this.connected = false;
      throw new DriverError(`RouterOS API write failed: ${path}`, {
        host: this.creds.host,
        command: path,
        params,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  PPPoE secrets                                                    */
  /* ---------------------------------------------------------------- */

  async upsertPppoeSecret(secret: PppoeSecret): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ppp/secret/print', [`?name=${secret.username}`]);
      const params: string[] = [
        `=name=${secret.username}`,
        `=password=${secret.password}`,
        `=profile=${secret.profile}`,
      ];
      if (secret.service) params.push(`=service=${secret.service}`);
      if (secret.callerId) params.push(`=caller-id=${secret.callerId}`);
      if (secret.comment) params.push(`=comment=${secret.comment}`);

      if (existing.length > 0) {
        const id = existing[0]['.id'];
        await this.rosWrite('/ppp/secret/set', ['=.id=' + id, ...params]);
        return { success: true, message: `PPPoE secret ${secret.username} updated`, data: { id } };
      }
      const added = await this.rosWrite('/ppp/secret/add', params);
      return {
        success: true,
        message: `PPPoE secret ${secret.username} created`,
        data: { id: added[0]?.['ret'] ?? added[0]?.['.id'] },
      };
    });
  }

  async removePppoeSecret(username: string): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ppp/secret/print', [`?name=${username}`]);
      if (existing.length === 0) {
        return { success: true, message: `PPPoE secret ${username} not present (idempotent)` };
      }
      await this.rosWrite('/ppp/secret/remove', [`=.id=${existing[0]['.id']}`]);
      return { success: true, message: `PPPoE secret ${username} removed` };
    });
  }

  async setPppoeProfile(username: string, profile: string): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ppp/secret/print', [`?name=${username}`]);
      if (existing.length === 0) {
        throw new DriverError(`PPPoE secret ${username} not found`, {
          host: this.creds.host,
          username,
        });
      }
      await this.rosWrite('/ppp/secret/set', [`=.id=${existing[0]['.id']}`, `=profile=${profile}`]);
      return { success: true, message: `PPPoE secret ${username} moved to profile ${profile}` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Address lists (isolation / enforcement)                          */
  /* ---------------------------------------------------------------- */

  async addAddressList(entry: AddressListEntry): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ip/firewall/address-list/print', [
        `?list=${entry.list}`,
        `?address=${entry.address}`,
      ]);
      if (existing.length > 0) {
        return {
          success: true,
          message: `Address ${entry.address} already in list ${entry.list} (idempotent)`,
        };
      }
      const params = [`=list=${entry.list}`, `=address=${entry.address}`];
      if (entry.comment) params.push(`=comment=${entry.comment}`);
      if (entry.timeout) params.push(`=timeout=${entry.timeout}`);
      await this.rosWrite('/ip/firewall/address-list/add', params);
      return { success: true, message: `Address ${entry.address} added to list ${entry.list}` };
    });
  }

  async removeAddressList(list: string, address: string): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ip/firewall/address-list/print', [
        `?list=${list}`,
        `?address=${address}`,
      ]);
      if (existing.length === 0) {
        return { success: true, message: `Address ${address} not in list ${list} (idempotent)` };
      }
      // Remove every matching row (duplicates can exist after manual edits).
      for (const row of existing) {
        await this.rosWrite('/ip/firewall/address-list/remove', [`=.id=${row['.id']}`]);
      }
      return { success: true, message: `Address ${address} removed from list ${list}` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  NAT redirect (payment portal captive redirect)                   */
  /* ---------------------------------------------------------------- */

  async upsertNatRedirect(rule: NatRedirectRule & { comment: string }): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ip/firewall/nat/print', [`?comment=${rule.comment}`]);
      const params: string[] = [
        `=chain=${rule.chain}`,
        `=src-address-list=${rule.srcAddressList}`,
        `=action=dst-nat`,
        `=to-addresses=${rule.toAddresses}`,
        `=to-ports=${rule.toPorts}`,
        `=comment=${rule.comment}`,
      ];
      if (rule.protocol !== 'all') {
        params.push(`=protocol=${rule.protocol}`, `=dst-port=${rule.dstPort}`);
      }
      if (existing.length > 0) {
        await this.rosWrite('/ip/firewall/nat/set', ['=.id=' + existing[0]['.id'], ...params]);
        return { success: true, message: `NAT redirect rule "${rule.comment}" updated` };
      }
      await this.rosWrite('/ip/firewall/nat/add', params);
      return { success: true, message: `NAT redirect rule "${rule.comment}" created` };
    });
  }

  async removeNatRedirect(comment: string): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/ip/firewall/nat/print', [`?comment=${comment}`]);
      if (existing.length === 0) {
        return { success: true, message: `NAT rule "${comment}" not present (idempotent)` };
      }
      for (const row of existing) {
        await this.rosWrite('/ip/firewall/nat/remove', [`=.id=${row['.id']}`]);
      }
      return { success: true, message: `NAT rule "${comment}" removed` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Active sessions                                                  */
  /* ---------------------------------------------------------------- */

  async kickPppoeSession(username: string): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const sessions = await this.rosWrite('/ppp/active/print', [`?name=${username}`]);
      if (sessions.length === 0) {
        return { success: true, message: `No active PPPoE session for ${username} (idempotent)` };
      }
      for (const row of sessions) {
        await this.rosWrite('/ppp/active/remove', [`=.id=${row['.id']}`]);
      }
      return {
        success: true,
        message: `Kicked ${sessions.length} active session(s) for ${username}`,
        data: { kicked: sessions.length },
      };
    });
  }

  async getActiveSessions(): Promise<ActiveSession[]> {
    const rows = await this.rosWrite('/ppp/active/print');
    return rows.map((row) => ({
      username: row['name'] ?? '',
      address: row['address'] ?? '',
      uptime: row['uptime'] ?? '',
      callerId: row['caller-id'] ?? '',
    }));
  }

  /* ---------------------------------------------------------------- */
  /*  Simple queues (bandwidth / throttle)                             */
  /* ---------------------------------------------------------------- */

  async upsertSimpleQueue(queue: SimpleQueue): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/queue/simple/print', [`?name=${queue.name}`]);
      const params: string[] = [`=name=${queue.name}`, `=target=${queue.target}`, `=max-limit=${queue.maxLimit}`];
      if (queue.limitAt) params.push(`=limit-at=${queue.limitAt}`);
      if (queue.burstLimit) params.push(`=burst-limit=${queue.burstLimit}`);
      if (queue.burstTime) params.push(`=burst-time=${queue.burstTime}`);
      if (queue.comment) params.push(`=comment=${queue.comment}`);

      if (existing.length > 0) {
        await this.rosWrite('/queue/simple/set', ['=.id=' + existing[0]['.id'], ...params]);
        return { success: true, message: `Simple queue ${queue.name} updated` };
      }
      await this.rosWrite('/queue/simple/add', params);
      return { success: true, message: `Simple queue ${queue.name} created` };
    });
  }

  async removeSimpleQueue(name: string): Promise<DriverResult> {
    return this.serializeWrites(async () => {
      const existing = await this.rosWrite('/queue/simple/print', [`?name=${name}`]);
      if (existing.length === 0) {
        return { success: true, message: `Simple queue ${name} not present (idempotent)` };
      }
      for (const row of existing) {
        await this.rosWrite('/queue/simple/remove', [`=.id=${row['.id']}`]);
      }
      return { success: true, message: `Simple queue ${name} removed` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  async ping(host: string, count = 4): Promise<{ sent: number; received: number; avgMs: number }> {
    const rows = await this.rosWrite('/ping', [`=address=${host}`, `=count=${count}`]);
    const summary = rows[rows.length - 1] ?? {};
    const sent = Number.parseInt(summary['sent'] ?? String(count), 10) || 0;
    const received = Number.parseInt(summary['received'] ?? '0', 10) || 0;
    const avgRaw = (summary['avg-rtt'] ?? '0ms').replace(/[^0-9.]/g, '');
    const avgMs = Number.parseFloat(avgRaw) || 0;
    return { sent, received, avgMs };
  }

  async getSystemResource(): Promise<{
    cpuLoad: number;
    freeMemory: number;
    uptime: string;
    version: string;
  }> {
    const rows = await this.rosWrite('/system/resource/print');
    const row = rows[0] ?? {};
    return {
      cpuLoad: Number.parseInt(row['cpu-load'] ?? '0', 10) || 0,
      freeMemory: Number.parseInt(row['free-memory'] ?? '0', 10) || 0,
      uptime: row['uptime'] ?? '',
      version: row['version'] ?? '',
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Build a RouterOS rate-limit string from package speeds.
   *
   * Format: `rx/tx burst-rx/burst-tx burst-threshold-rx/burst-threshold-tx burst-time priority`
   * where rx = customer upload, tx = customer download (router perspective).
   *
   * Example: buildRateLimit(20, 10) -> "10M/20M 15M/30M 8M/16M 8/8"
   */
  static buildRateLimit(downMbps: number, upMbps: number, burstFactor = 1.5): string {
    const fmt = (kbps: number): string => {
      if (kbps >= 1000) {
        const m = kbps / 1000;
        return `${Number(m.toFixed(2))}M`;
      }
      return `${Math.max(1, Math.round(kbps))}k`;
    };
    const upK = upMbps * 1000;
    const downK = downMbps * 1000;
    const rxTx = `${fmt(upK)}/${fmt(downK)}`;
    const burst = `${fmt(upK * burstFactor)}/${fmt(downK * burstFactor)}`;
    const threshold = `${fmt(upK * 0.8)}/${fmt(downK * 0.8)}`;
    return `${rxTx} ${burst} ${threshold} 8/8`;
  }
}
