import * as snmp from 'net-snmp';
import { Client as SshClient, ClientChannel } from 'ssh2';
import {
  DriverError,
  DriverResult,
  OltCredentials,
  OltDriver,
  OnuDiscoveryResult,
  OnuOpticalPower,
} from './network-driver.interface';

/* ------------------------------------------------------------------ */
/*  Huawei MA5600T / MA5800 MIB roots                                  */
/* ------------------------------------------------------------------ */

/** hwGponDeviceOntSnTable — index is the ONT ifIndex */
const OID_ONT_SN_TABLE = '1.3.6.1.4.1.2011.6.128.1.1.2.43.1';
const OID_ONT_SN_COL = `${OID_ONT_SN_TABLE}.3`; // OCTET STRING, 16-byte SN
const OID_ONT_CONTROL_COL = `${OID_ONT_SN_TABLE}.9`; // INTEGER: 1=active/configured, 2=auto-find/unconfirmed

/** hwGponDeviceOntOpticalDdmTable — values in 0.01 dBm units */
const OID_ONT_DDM_TABLE = '1.3.6.1.4.1.2011.6.128.1.1.2.51.1';
const OID_ONT_DDM_TX_COL = `${OID_ONT_DDM_TABLE}.6`;
const OID_ONT_DDM_RX_COL = `${OID_ONT_DDM_TABLE}.7`;

/** hwGponDeviceOntRunStateTable — INTEGER: 1=online, 2=offline */
const OID_ONT_RUN_STATE_COL = '1.3.6.1.4.1.2011.6.128.1.1.2.62.1.22';

const SNMP_TIMEOUT_MS = 5000;
const SNMP_RETRIES = 2;
const SSH_READY_TIMEOUT_MS = 20000;
const SSH_CMD_TIMEOUT_MS = 60000;

/**
 * Huawei ONT ifIndex allocation (MA56xx/MA58xx):
 *   ifIndex = 0x10000000 | (frame << 20) | (slot << 16) | (port << 8) | ontId
 * This matches Huawei's published interface-index scheme for GPON ONTs.
 */
function encodeOntIfIndex(frame: number, slot: number, port: number, ontId: number): number {
  return 0x10000000 | (frame << 20) | (slot << 16) | (port << 8) | ontId;
}

function decodeOntIfIndex(ifIndex: number): { frame: number; slot: number; port: number; ontId: number } {
  return {
    frame: (ifIndex >> 20) & 0xf,
    slot: (ifIndex >> 16) & 0xf,
    port: (ifIndex >> 8) & 0xff,
    ontId: ifIndex & 0xff,
  };
}

/**
 * Huawei MA5600T / MA5800 OLT driver.
 *
 * - Discovery & telemetry : SNMP (net-snmp, getBulk walks)
 * - Provisioning          : interactive SSH shell (ssh2), because VRP
 *                           config-mode commands require a stateful CLI
 *                           session (enable -> config -> interface gpon).
 */
export class HuaweiOltDriver extends OltDriver {
  protected readonly hostKey: string;

  private readonly creds: OltCredentials;
  private ssh: SshClient | null = null;
  private sshReady: Promise<void> | null = null;
  private shellPromise: Promise<ClientChannel> | null = null;
  private shellQueue: Promise<unknown> = Promise.resolve();
  private cliView: 'user' | 'config' | 'gpon' = 'user';
  private gponViewTarget = '';

  constructor(creds: OltCredentials) {
    super();
    this.creds = { sshPort: 22, ...creds };
    this.hostKey = `olt:${creds.mgmtIp}`;
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async connect(): Promise<void> {
    // Validate SNMP reachability (sysDescr) and establish the SSH shell.
    await this.snmpGet(['1.3.6.1.2.1.1.1.0']);
    await this.getShell();
  }

  async disconnect(): Promise<void> {
    this.shellPromise = null;
    this.sshReady = null;
    if (this.ssh) {
      try {
        this.ssh.end();
      } catch {
        /* best effort */
      }
      this.ssh = null;
    }
    this.cliView = 'user';
  }

  /* ---------------------------------------------------------------- */
  /*  SNMP layer (net-snmp)                                            */
  /* ---------------------------------------------------------------- */

  private snmpVersion(): snmp.Version {
    const v = String(this.creds.snmpVersion).toLowerCase();
    if (v === '1') return snmp.Version1;
    if (v === '2' || v === '2c') return snmp.Version2c;
    throw new DriverError(`SNMPv3 is not implemented for Huawei driver (got version "${v}")`, {
      host: this.creds.mgmtIp,
    });
  }

  private createSnmpSession(): snmp.Session {
    return snmp.createSession(this.creds.mgmtIp, this.creds.snmpCommunity, {
      version: this.snmpVersion(),
      timeout: SNMP_TIMEOUT_MS,
      retries: SNMP_RETRIES,
      transport: 'udp4',
    });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DriverError(`SNMP ${what} timed out`, { host: this.creds.mgmtIp })), ms);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private async snmpGet(oids: string[]): Promise<snmp.VarBind[]> {
    const session = this.createSnmpSession();
    try {
      return await this.withTimeout(
        new Promise<snmp.VarBind[]>((resolve, reject) => {
          session.get(oids, (err, varbinds) => {
            if (err) return reject(new DriverError('SNMP GET failed', { host: this.creds.mgmtIp, oids, cause: err.message }));
            resolve(varbinds ?? []);
          });
        }),
        SNMP_TIMEOUT_MS + 4000,
        'GET',
      );
    } finally {
      session.close();
    }
  }

  /** Subtree walk implemented with repeated getBulk calls. */
  private async snmpWalk(rootOid: string): Promise<snmp.VarBind[]> {
    const session = this.createSnmpSession();
    try {
      const results: snmp.VarBind[] = [];
      let nextOid = rootOid;
      for (let i = 0; i < 400; i++) {
        const batch = await this.withTimeout(
          new Promise<snmp.VarBind[]>((resolve, reject) => {
            const collected: snmp.VarBind[] = [];
            session.getBulk(
              [nextOid],
              0,
              25,
              (feedVbs) => {
                for (const vb of feedVbs) {
                  if (snmp.isVarbindError(vb)) continue;
                  if (!vb.oid.startsWith(`${rootOid}.`)) return false; // left the subtree
                  collected.push(vb);
                }
                return true;
              },
              (err) => {
                if (err) return reject(new DriverError('SNMP getBulk walk failed', { host: this.creds.mgmtIp, rootOid, cause: err.message }));
                resolve(collected);
              },
            );
          }),
          SNMP_TIMEOUT_MS + 4000,
          'WALK',
        );
        if (batch.length === 0) break;
        results.push(...batch);
        const last = batch[batch.length - 1].oid;
        if (last === nextOid || !last.startsWith(`${rootOid}.`)) break;
        nextOid = last;
      }
      return results;
    } finally {
      session.close();
    }
  }

  private static varbindToString(vb: snmp.VarBind): string {
    const v = vb.value;
    if (Buffer.isBuffer(v)) {
      const ascii = v.toString('ascii');
      // Huawei returns the 16-char SN as ASCII hex; fall back to hex dump.
      // eslint-disable-next-line no-control-regex
      return /^[\x20-\x7E]+$/.test(ascii) ? ascii.trim() : v.toString('hex').toUpperCase();
    }
    return String(v);
  }

  private static varbindToInt(vb: snmp.VarBind): number {
    const v = vb.value;
    if (typeof v === 'number') return v;
    if (Buffer.isBuffer(v)) return v.readInt32BE(0);
    return Number.parseInt(String(v), 10) || 0;
  }

  /* ---------------------------------------------------------------- */
  /*  SSH layer (ssh2 interactive shell)                               */
  /* ---------------------------------------------------------------- */

  private async sshConnect(): Promise<void> {
    if (this.sshReady) return this.sshReady;
    this.sshReady = new Promise<void>((resolve, reject) => {
      const client = new SshClient();
      const timer = setTimeout(() => {
        client.end();
        reject(new DriverError('SSH connection timed out', { host: this.creds.mgmtIp }));
      }, SSH_READY_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      client
        .on('ready', () => {
          clearTimeout(timer);
          this.ssh = client;
          resolve();
        })
        .on('error', (err) => {
          clearTimeout(timer);
          this.sshReady = null;
          reject(new DriverError('SSH connection failed', { host: this.creds.mgmtIp, cause: err.message }));
        })
        .connect({
          host: this.creds.mgmtIp,
          port: this.creds.sshPort ?? 22,
          username: this.creds.sshUsername,
          password: this.creds.sshPassword,
          keepaliveInterval: 15000,
          readyTimeout: SSH_READY_TIMEOUT_MS,
        });
    });
    return this.sshReady;
  }

  private async getShell(): Promise<ClientChannel> {
    if (!this.shellPromise) {
      this.shellPromise = (async () => {
        await this.sshConnect();
        const client = this.ssh;
        if (!client) throw new DriverError('SSH client not connected', { host: this.creds.mgmtIp });
        return new Promise<ClientChannel>((resolve, reject) => {
          client.shell({ term: 'vt100', cols: 200, rows: 60 }, (err, stream) => {
            if (err || !stream) {
              this.shellPromise = null;
              return reject(new DriverError('Failed to open SSH shell', { host: this.creds.mgmtIp, cause: err?.message }));
            }
            stream.on('close', () => {
              this.shellPromise = null;
              this.cliView = 'user';
            });
            // Drain the login banner / initial prompt.
            let banner = '';
            const onBanner = (data: Buffer): void => {
              banner += data.toString();
              if (/(<[^<>\n]+>|\[[^\[\]\n]+\])\s*$/.test(banner)) {
                stream.off('data', onBanner);
                resolve(stream);
              }
            };
            stream.on('data', onBanner);
            setTimeout(() => {
              stream.off('data', onBanner);
              resolve(stream); // resolve anyway; shellExec re-syncs on prompt
            }, 5000).unref?.();
          });
        });
      })();
    }
    return this.shellPromise;
  }

  /** Queued interactive-shell command execution with prompt synchronization. */
  private async shellExec(command: string, timeoutMs = SSH_CMD_TIMEOUT_MS): Promise<string> {
    const run = this.shellQueue
      .catch(() => undefined)
      .then(() => this.shellExecOnce(command, timeoutMs));
    this.shellQueue = run.catch(() => undefined);
    return run;
  }

  private async shellExecOnce(command: string, timeoutMs: number): Promise<string> {
    const stream = await this.getShell();
    const host = this.creds.mgmtIp;
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      const PROMPT = /(^|\n)(<[^<>\n]+>|\[[^\[\]\n]+\])\s*$/;
      const cleanup = (): void => {
        clearTimeout(timer);
        stream.off('data', onData);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DriverError('SSH command timed out waiting for prompt', { host, command }));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      const onData = (data: Buffer): void => {
        buffer += data.toString();
        // Handle VRP pager.
        if (/---- More ----/.test(buffer)) {
          buffer = buffer.replace(/---- More ----[^\n]*\n?/g, '');
          stream.write(' ');
          return;
        }
        if (PROMPT.test(buffer)) {
          cleanup();
          const lines = buffer.replace(/\r/g, '').split('\n');
          // Drop the echoed command line and the trailing prompt line.
          let start = 0;
          if (lines[0] !== undefined && lines[0].trim() === command.trim()) start = 1;
          let end = lines.length;
          while (end > start && PROMPT.test(lines[end - 1])) end -= 1;
          resolve(lines.slice(start, end).join('\n').trim());
        }
      };
      stream.on('data', onData);
      stream.write(`${command}\n`);
    });
  }

  /* CLI view state machine: user -> config -> interface gpon F/S */
  private async ensureUserView(): Promise<void> {
    if (this.cliView === 'gpon') {
      await this.shellExec('quit');
      this.cliView = 'config';
    }
    if (this.cliView === 'config') {
      await this.shellExec('quit');
      this.cliView = 'user';
    }
  }

  private async ensureConfigView(): Promise<void> {
    await this.ensureUserView();
    await this.shellExec('enable');
    await this.shellExec('config');
    this.cliView = 'config';
  }

  private async ensureGponView(frame: number, slot: number): Promise<void> {
    const target = `${frame}/${slot}`;
    if (this.cliView === 'gpon' && this.gponViewTarget === target) return;
    await this.ensureConfigView();
    await this.shellExec(`interface gpon ${target}`);
    this.cliView = 'gpon';
    this.gponViewTarget = target;
  }

  private static parsePon(ponPort: string): { frame: number; slot: number; port: number } {
    const m = ponPort.replace(/^gpon[_-]?/i, '').match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!m) throw new DriverError(`Invalid Huawei PON port format "${ponPort}" (expected F/S/P, e.g. 0/1/2)`, { ponPort });
    return { frame: Number(m[1]), slot: Number(m[2]), port: Number(m[3]) };
  }

  /* ---------------------------------------------------------------- */
  /*  Discovery                                                        */
  /* ---------------------------------------------------------------- */

  async discoverUnconfiguredOnus(ponPort?: string): Promise<OnuDiscoveryResult[]> {
    const bySn = new Map<string, OnuDiscoveryResult>();

    // 1) Authoritative source: VRP auto-find table via SSH.
    try {
      const raw = await this.shellExec('display ont autofind all');
      for (const block of raw.split(/-{20,}/)) {
        const snMatch = block.match(/Ont SN\s*:\s*([0-9A-Fa-f]{16})/);
        if (!snMatch) continue;
        const sn = snMatch[1].toUpperCase();
        const portMatch = block.match(/(?:F\/S\/P|GPON Port)\s*:\s*(\d+\/\d+\/\d+)/);
        const port = portMatch ? portMatch[1] : ponPort ?? '';
        if (ponPort && port && port !== ponPort) continue;
        bySn.set(sn, { sn, ponPort: port });
      }
    } catch (err) {
      throw new DriverError('Huawei auto-find discovery failed', {
        host: this.creds.mgmtIp,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // 2) SNMP getBulk walk of the ONT SN + control tables; entries flagged
    //    as auto-find/unconfirmed (control == 2) are merged in.
    try {
      const [snVbs, ctrlVbs] = await Promise.all([
        this.snmpWalk(OID_ONT_SN_COL),
        this.snmpWalk(OID_ONT_CONTROL_COL),
      ]);
      const ctrlByIndex = new Map<string, number>();
      for (const vb of ctrlVbs) {
        const index = vb.oid.slice(OID_ONT_CONTROL_COL.length + 1);
        ctrlByIndex.set(index, HuaweiOltDriver.varbindToInt(vb));
      }
      for (const vb of snVbs) {
        const index = vb.oid.slice(OID_ONT_SN_COL.length + 1);
        if (ctrlByIndex.get(index) !== 2) continue; // only unconfirmed
        const sn = HuaweiOltDriver.varbindToString(vb).toUpperCase();
        if (!/^[0-9A-F]{16}$/.test(sn)) continue;
        const loc = decodeOntIfIndex(Number.parseInt(index, 10));
        const port = `${loc.frame}/${loc.slot}/${loc.port}`;
        if (ponPort && port !== ponPort) continue;
        if (!bySn.has(sn)) bySn.set(sn, { sn, ponPort: port, ontId: loc.ontId });
      }
    } catch {
      // SNMP enrichment is best-effort; SSH auto-find already succeeded.
    }

    return [...bySn.values()];
  }

  /* ---------------------------------------------------------------- */
  /*  Provisioning                                                     */
  /* ---------------------------------------------------------------- */

  private async usedOntIds(port: number): Promise<Set<number>> {
    // Called from inside `interface gpon F/S`, so the port alone suffices.
    const raw = await this.shellExec(`display ont info ${port} all`);
    const used = new Set<number>();
    for (const m of raw.matchAll(/ONT ID\s*:\s*(\d+)/g)) used.add(Number(m[1]));
    return used;
  }

  private async nextFreeOntId(port: number): Promise<number> {
    const used = await this.usedOntIds(port);
    for (let id = 0; id < 128; id++) {
      if (!used.has(id)) return id;
    }
    throw new DriverError(`No free ONT ID on GPON port ${port}`, { host: this.creds.mgmtIp });
  }

  async registerOnu(params: {
    ponPort: string;
    ontId?: number;
    sn: string;
    lineProfile: string;
    serviceProfile: string;
  }): Promise<DriverResult & { ontId?: number }> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(params.ponPort);
    const sn = params.sn.toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(sn)) {
      throw new DriverError(`Invalid ONT serial number "${params.sn}" (expected 16 hex chars)`, { ponPort: params.ponPort });
    }
    return this.serializeWrites(async () => {
      await this.ensureGponView(frame, slot);
      const ontId = params.ontId ?? (await this.nextFreeOntId(port));
      const existing = await this.shellExec(`display ont info ${port} ${ontId}`);
      if (/ONT ID\s*:/.test(existing)) {
        await this.ensureUserView();
        return { success: true, message: `ONT ${port}/${ontId} already registered (idempotent)`, ontId };
      }
      const out = await this.shellExec(
        `ont add ${port} ${ontId} sn-auth ${sn} omci ont-lineprofile-id ${params.lineProfile} ont-srvprofile-id ${params.serviceProfile}`,
      );
      if (/Failure|Error|Invalid/i.test(out)) {
        throw new DriverError(`Huawei ont add failed: ${out}`, { host: this.creds.mgmtIp, ponPort: params.ponPort, ontId });
      }
      // Confirm auto-find entry if the OLT had already discovered the SN.
      await this.shellExec(`ont confirm ${port} ontid ${ontId}`);
      await this.ensureUserView();
      return { success: true, message: `ONT ${sn} registered as ${frame}/${slot}/${port}/${ontId}`, ontId };
    });
  }

  async deregisterOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    return this.serializeWrites(async () => {
      // Remove service-ports first (config view), then the ONT itself.
      await this.ensureConfigView();
      const spRaw = await this.shellExec(`display service-port port gpon ${frame}/${slot}/${port} ont ${ontId}`);
      for (const m of spRaw.matchAll(/^\s*(\d+)\s+\d+\s+(?:vlan|gpon)/gim)) {
        await this.shellExec(`undo service-port ${m[1]}`);
      }
      await this.ensureGponView(frame, slot);
      const out = await this.shellExec(`ont delete ${port} ${ontId}`);
      await this.ensureUserView();
      if (/Failure|Error/i.test(out) && !/not exist|does not exist/i.test(out)) {
        throw new DriverError(`Huawei ont delete failed: ${out}`, { host: this.creds.mgmtIp, ponPort, ontId });
      }
      return { success: true, message: `ONT ${frame}/${slot}/${port}/${ontId} deregistered` };
    });
  }

  async setOnuServiceProfile(ponPort: string, ontId: number, profile: string): Promise<DriverResult> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    return this.serializeWrites(async () => {
      await this.ensureGponView(frame, slot);
      const out = await this.shellExec(`ont modify ${port} ${ontId} ont-srvprofile-id ${profile}`);
      if (/Failure|Error|Invalid/i.test(out)) {
        // Fallback for older VRP: delete + re-add preserving other attributes.
        const info = await this.shellExec(`display ont info ${port} ${ontId}`);
        const sn = info.match(/SN\s*:\s*([0-9A-Fa-f]{16})/)?.[1];
        const lp = info.match(/line profile[^:]*:\s*(\S+)/i)?.[1] ?? info.match(/Line profile ID\s*:\s*(\d+)/i)?.[1];
        const vlan = info.match(/native-vlan[^\d]*(\d+)/i)?.[1] ?? info.match(/Default VLAN[^:]*:\s*(\d+)/i)?.[1];
        if (!sn || !lp) {
          throw new DriverError(`Huawei ont modify failed and ONT attributes could not be recovered: ${out}`, { host: this.creds.mgmtIp, ponPort, ontId });
        }
        await this.shellExec(`ont delete ${port} ${ontId}`);
        const addOut = await this.shellExec(
          `ont add ${port} ${ontId} sn-auth ${sn.toUpperCase()} omci ont-lineprofile-id ${lp} ont-srvprofile-id ${profile}`,
        );
        if (/Failure|Error|Invalid/i.test(addOut)) {
          throw new DriverError(`Huawei ONT re-add with new service profile failed: ${addOut}`, { host: this.creds.mgmtIp, ponPort, ontId });
        }
        if (vlan) await this.shellExec(`ont port native-vlan ${port} ${ontId} eth 1 vlan ${vlan}`);
      }
      await this.ensureUserView();
      return { success: true, message: `ONT ${frame}/${slot}/${port}/${ontId} service profile set to ${profile}` };
    });
  }

  async setOnuVlan(ponPort: string, ontId: number, vlanId: number, nativeVlan?: number): Promise<DriverResult> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    if (vlanId < 1 || vlanId > 4094) throw new DriverError(`Invalid VLAN ID ${vlanId}`, { ponPort });
    return this.serializeWrites(async () => {
      await this.ensureGponView(frame, slot);
      const nvlan = nativeVlan ?? vlanId;
      const vlanOut = await this.shellExec(`ont port native-vlan ${port} ${ontId} eth 1 vlan ${nvlan}`);
      if (/Failure|Error|Invalid/i.test(vlanOut)) {
        throw new DriverError(`Huawei native-vlan failed: ${vlanOut}`, { host: this.creds.mgmtIp, ponPort, ontId });
      }
      await this.ensureConfigView();
      const spRaw = await this.shellExec(`display service-port port gpon ${frame}/${slot}/${port} ont ${ontId}`);
      const hasVlan = new RegExp(`vlan\\s+${vlanId}\\b`, 'i').test(spRaw);
      if (!hasVlan) {
        const spOut = await this.shellExec(
          `service-port vlan ${vlanId} gpon ${frame}/${slot}/${port} ont ${ontId} gemport 1 multi-service user-vlan ${vlanId}`,
        );
        if (/Failure|Error|Invalid/i.test(spOut)) {
          throw new DriverError(`Huawei service-port creation failed: ${spOut}`, { host: this.creds.mgmtIp, ponPort, ontId, vlanId });
        }
      }
      await this.ensureUserView();
      return { success: true, message: `ONT ${frame}/${slot}/${port}/${ontId} VLAN set to ${vlanId} (native ${nvlan})` };
    });
  }

  async setOnuSpeedCap(ponPort: string, ontId: number, downMbps: number, upMbps: number): Promise<DriverResult> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    const upKbps = Math.max(64, Math.round(upMbps * 1024));
    const downKbps = Math.max(64, Math.round(downMbps * 1024));
    return this.serializeWrites(async () => {
      await this.ensureConfigView();
      const upName = `CAP_U_${frame}_${slot}_${port}_${ontId}`;
      const downName = `CAP_D_${frame}_${slot}_${port}_${ontId}`;
      const upIdx = await this.ensureTrafficTable(upName, upKbps, upKbps);
      const downIdx = await this.ensureTrafficTable(downName, downKbps, downKbps);
      const spRaw = await this.shellExec(`display service-port port gpon ${frame}/${slot}/${port} ont ${ontId}`);
      const indexes = [...spRaw.matchAll(/^\s*(\d+)\s+/gm)].map((m) => m[1]);
      if (indexes.length === 0) {
        throw new DriverError('No service-port found for ONT; create VLAN/service-port first', { host: this.creds.mgmtIp, ponPort, ontId });
      }
      for (const idx of indexes) {
        const out = await this.shellExec(
          `service-port ${idx} inbound traffic-table index ${upIdx} outbound traffic-table index ${downIdx}`,
        );
        if (/Failure|Error|Invalid/i.test(out)) {
          throw new DriverError(`Binding traffic table to service-port ${idx} failed: ${out}`, { host: this.creds.mgmtIp });
        }
      }
      await this.ensureUserView();
      return { success: true, message: `ONT ${frame}/${slot}/${port}/${ontId} capped at ${downMbps}/${upMbps} Mbps (down/up)` };
    });
  }

  /** Find-or-create an IP traffic table; returns its index. cir/pir in kbit/s. */
  private async ensureTrafficTable(name: string, cirKbps: number, pirKbps: number): Promise<number> {
    const raw = await this.shellExec('display traffic table ip from-index 0');
    let maxIdx = 0;
    for (const m of raw.matchAll(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)/gm)) {
      const idx = Number(m[1]);
      if (idx > maxIdx) maxIdx = idx;
      if (m[2] === name && Number(m[3]) === cirKbps && Number(m[4]) === pirKbps) return idx;
    }
    const idx = maxIdx + 1;
    const out = await this.shellExec(`traffic table ip index ${idx} name ${name} cir ${cirKbps} pir ${pirKbps}`);
    if (/Failure|Error|Invalid/i.test(out)) {
      throw new DriverError(`Traffic table creation failed: ${out}`, { host: this.creds.mgmtIp, name });
    }
    return idx;
  }

  /* ---------------------------------------------------------------- */
  /*  Telemetry                                                        */
  /* ---------------------------------------------------------------- */

  async getOnuOpticalPower(ponPort: string, ontId: number): Promise<OnuOpticalPower> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    const ifIndex = encodeOntIfIndex(frame, slot, port, ontId);
    // Primary: SNMP DDM table (values in 0.01 dBm).
    try {
      const vbs = await this.snmpGet([`${OID_ONT_DDM_RX_COL}.${ifIndex}`, `${OID_ONT_DDM_TX_COL}.${ifIndex}`]);
      if (vbs.length === 2 && !vbs.some((vb) => snmp.isVarbindError(vb))) {
        return {
          rxDbm: HuaweiOltDriver.varbindToInt(vbs[0]) / 100,
          txDbm: HuaweiOltDriver.varbindToInt(vbs[1]) / 100,
        };
      }
    } catch {
      /* fall through to CLI */
    }
    // Fallback: VRP CLI optical info.
    const raw = await this.shellExec(`display ont optical-info ${port} ${ontId}`);
    const rx = raw.match(/Rx[^:]*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    const tx = raw.match(/Tx[^:]*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    if (rx === undefined || tx === undefined) {
      throw new DriverError('Optical power unavailable via SNMP and CLI', { host: this.creds.mgmtIp, ponPort, ontId });
    }
    return { rxDbm: Number(rx), txDbm: Number(tx) };
  }

  async getOnuStatus(ponPort: string, ontId: number): Promise<'online' | 'offline' | 'los'> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    const ifIndex = encodeOntIfIndex(frame, slot, port, ontId);
    try {
      const vbs = await this.snmpGet([`${OID_ONT_RUN_STATE_COL}.${ifIndex}`]);
      const state = vbs.length > 0 && !snmp.isVarbindError(vbs[0]) ? HuaweiOltDriver.varbindToInt(vbs[0]) : 0;
      if (state === 1) return 'online';
    } catch {
      /* fall through to CLI */
    }
    const raw = await this.shellExec(`display ont info ${port} ${ontId}`);
    if (/Run state\s*:\s*online/i.test(raw)) return 'online';
    const downCause = raw.match(/Last down cause\s*:\s*([^\n]+)/i)?.[1] ?? '';
    if (/LOS/i.test(downCause)) return 'los';
    return 'offline';
  }

  async rebootOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    return this.serializeWrites(async () => {
      await this.ensureGponView(frame, slot);
      const out = await this.shellExec(`ont reboot ${port} ${ontId}`);
      await this.ensureUserView();
      if (/Failure|Error|Invalid/i.test(out)) {
        throw new DriverError(`Huawei ont reboot failed: ${out}`, { host: this.creds.mgmtIp, ponPort, ontId });
      }
      return { success: true, message: `ONT ${frame}/${slot}/${port}/${ontId} reboot initiated` };
    });
  }

  async replaceOnu(ponPort: string, oldOntId: number, newSn: string): Promise<DriverResult> {
    const { frame, slot, port } = HuaweiOltDriver.parsePon(ponPort);
    const sn = newSn.toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(sn)) throw new DriverError(`Invalid ONT serial number "${newSn}"`, { ponPort });
    return this.serializeWrites(async () => {
      await this.ensureGponView(frame, slot);
      // 1) Snapshot current configuration.
      const info = await this.shellExec(`display ont info ${port} ${oldOntId}`);
      if (!/ONT ID\s*:/.test(info)) {
        throw new DriverError(`ONT ${port}/${oldOntId} not found`, { host: this.creds.mgmtIp, ponPort });
      }
      const lineProfile = info.match(/Line profile (?:ID|name)\s*:\s*(\S+)/i)?.[1];
      const srvProfile = info.match(/Service profile (?:ID|name)\s*:\s*(\S+)/i)?.[1];
      const nativeVlan = info.match(/(?:native-vlan|Default VLAN)[^:\n]*:\s*(\d+)/i)?.[1];
      const desc = info.match(/Description\s*:\s*([^\n]+)/i)?.[1]?.trim();
      if (!lineProfile || !srvProfile) {
        throw new DriverError('Could not recover ONT profiles; aborting swap to avoid config loss', { host: this.creds.mgmtIp, ponPort, ontId: oldOntId });
      }
      // 2) Remove old ONT (service-ports cleaned in config view first).
      await this.ensureConfigView();
      const spRaw = await this.shellExec(`display service-port port gpon ${frame}/${slot}/${port} ont ${oldOntId}`);
      const spIndexes = [...spRaw.matchAll(/^\s*(\d+)\s+/gm)].map((m) => m[1]);
      const spVlans = [...spRaw.matchAll(/vlan\s+(\d+)/gi)].map((m) => Number(m[1]));
      for (const idx of spIndexes) await this.shellExec(`undo service-port ${idx}`);
      await this.ensureGponView(frame, slot);
      await this.shellExec(`ont delete ${port} ${oldOntId}`);
      // 3) Add replacement with identical profiles.
      const addOut = await this.shellExec(
        `ont add ${port} ${oldOntId} sn-auth ${sn} omci ont-lineprofile-id ${lineProfile} ont-srvprofile-id ${srvProfile}` +
          (desc ? ` desc "${desc.replace(/"/g, '')}"` : ''),
      );
      if (/Failure|Error|Invalid/i.test(addOut)) {
        throw new DriverError(`Replacement ONT add failed (old ONT already removed): ${addOut}`, { host: this.creds.mgmtIp, ponPort, ontId: oldOntId });
      }
      if (nativeVlan) await this.shellExec(`ont port native-vlan ${port} ${oldOntId} eth 1 vlan ${nativeVlan}`);
      // 4) Recreate service-ports.
      await this.ensureConfigView();
      for (const vlan of [...new Set(spVlans)]) {
        await this.shellExec(
          `service-port vlan ${vlan} gpon ${frame}/${slot}/${port} ont ${oldOntId} gemport 1 multi-service user-vlan ${vlan}`,
        );
      }
      await this.ensureUserView();
      return { success: true, message: `ONT swapped: ${frame}/${slot}/${port}/${oldOntId} now uses SN ${sn} (config preserved)` };
    });
  }
}
