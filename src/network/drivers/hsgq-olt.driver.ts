import {
  DriverError,
  DriverResult,
  OltCredentials,
  OltDriver,
  OnuDiscoveryResult,
  OnuOpticalPower,
} from './network-driver.interface';
import { CliSession, SshShellSession, TelnetCliSession } from './olt-shell';

/* ------------------------------------------------------------------ */
/*  HSGQ EPON / GPON OLTs (e.g. HSGQ-G008, HSGQ-GPON series)            */
/*                                                                     */
/*  Transport: Telnet (port 23) primary, SSH fallback — same pattern   */
/*  as the Fiberhome driver. Telemetry is CLI-driven; there is no      */
/*  stable public DDM MIB for HSGQ, so SNMP is not used here.          */
/*                                                                     */
/*  PON port format: "slot/pon", e.g. "0/1".                           */
/*  Serial number: 16 hex chars for GPON, or 12 hex chars (MAC) for    */
/*  EPON ONUs — both are accepted by `onu register`.                  */
/* ------------------------------------------------------------------ */

/** HSGQ prompt: `HSGQ>`, `HSGQ#`, `HSGQ(config)#`, ... */
const HSGQ_PROMPT = /(^|\n)[\w.\-()]+(\([^()\n]*\))?[#>] ?$/;

function normalizePon(ponPort: string): string {
  const parts = ponPort.replace(/^(gpon|epon)[_-]?/i, '').split('/');
  const nums = parts.length === 3 ? parts.slice(1) : parts;
  if (nums.length === 2 && nums.every((p) => /^\d+$/.test(p))) return nums.join('/');
  throw new DriverError(`Invalid HSGQ PON port "${ponPort}" (expected slot/pon, e.g. 0/1)`, { ponPort });
}

export class HsgqOltDriver extends OltDriver {
  protected readonly hostKey: string;

  private readonly creds: OltCredentials;
  private cli: CliSession | null = null;
  private cliOpen: Promise<CliSession> | null = null;

  constructor(creds: OltCredentials) {
    super();
    this.creds = { sshPort: 22, ...creds };
    this.hostKey = `olt:${creds.mgmtIp}`;
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async connect(): Promise<void> {
    await this.getCli();
  }

  async disconnect(): Promise<void> {
    this.cliOpen = null;
    if (this.cli) {
      await this.cli.close();
      this.cli = null;
    }
  }

  private async getCli(): Promise<CliSession> {
    if (this.cli) return this.cli;
    if (!this.cliOpen) {
      this.cliOpen = this.openCli().then((s) => {
        this.cli = s;
        return s;
      });
      this.cliOpen.catch(() => {
        this.cliOpen = null;
      });
    }
    return this.cliOpen;
  }

  private async openCli(): Promise<CliSession> {
    const { mgmtIp, sshUsername, sshPassword } = this.creds;
    const clearCache = (): void => {
      this.cli = null;
      this.cliOpen = null;
    };
    let lastErr: unknown;
    try {
      const telnet = await TelnetCliSession.open({
        host: mgmtIp,
        port: 23,
        username: sshUsername,
        password: sshPassword,
        prompt: HSGQ_PROMPT,
        disablePagingCommand: 'terminal length 0',
        onClose: clearCache,
      });
      await this.enterConfig(telnet);
      return telnet;
    } catch (err) {
      lastErr = err;
    }
    try {
      const ssh = await SshShellSession.open({
        host: mgmtIp,
        port: this.creds.sshPort ?? 22,
        username: sshUsername,
        password: sshPassword,
        prompt: HSGQ_PROMPT,
        pager: /--More--/,
        onClose: clearCache,
      });
      await this.enterConfig(ssh);
      return ssh;
    } catch (err) {
      throw new DriverError('HSGQ CLI unreachable via Telnet and SSH', {
        host: mgmtIp,
        telnetCause: lastErr instanceof Error ? lastErr.message : String(lastErr),
        sshCause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async enterConfig(cli: CliSession): Promise<void> {
    await cli.exec('enable');
    await cli.exec('config');
  }

  private static validSn(sn: string): boolean {
    return /^[0-9A-Fa-f]{16}$/.test(sn) || /^[0-9A-Fa-f]{12}$/.test(sn);
  }

  private static assertOk(output: string, what: string, ctx: Record<string, unknown>): void {
    if (/Failure|Error:|Invalid|% /i.test(output)) {
      throw new DriverError(`HSGQ ${what} failed: ${output.split('\n')[0]}`, ctx);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Discovery                                                        */
  /* ---------------------------------------------------------------- */

  async discoverUnconfiguredOnus(ponPort?: string): Promise<OnuDiscoveryResult[]> {
    const cli = await this.getCli();
    const raw = await cli.exec('show onu unregistered');
    const results: OnuDiscoveryResult[] = [];
    // Rows look like: "  0/1   001122AABBCC      EPON" or "  0/2   48575443A1B2C3D4  GPON"
    for (const m of raw.matchAll(/(\d+\/\d+)\s+([0-9A-Fa-f]{12}(?:[0-9A-Fa-f]{4})?)/g)) {
      const pon = m[1];
      const sn = m[2].toUpperCase();
      if (!HsgqOltDriver.validSn(sn)) continue;
      if (ponPort && normalizePon(ponPort) !== pon) continue;
      if (!results.some((r) => r.sn === sn)) results.push({ sn, ponPort: pon });
    }
    return results;
  }

  /* ---------------------------------------------------------------- */
  /*  Provisioning                                                     */
  /* ---------------------------------------------------------------- */

  async registerOnu(params: {
    ponPort: string;
    ontId?: number;
    sn: string;
    lineProfile: string;
    serviceProfile: string;
  }): Promise<DriverResult & { ontId?: number }> {
    const pon = normalizePon(params.ponPort);
    const sn = params.sn.toUpperCase();
    if (!HsgqOltDriver.validSn(sn)) {
      throw new DriverError(`Invalid HSGQ ONU identifier "${params.sn}" (expected 12-hex MAC or 16-hex SN)`, { ponPort: params.ponPort });
    }
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      const ontId = params.ontId ?? (await this.nextFreeOntId(cli, pon));
      return this.registerOnuInner(cli, pon, ontId, sn);
    });
  }

  /** Unserialized core of registerOnu. */
  private async registerOnuInner(
    cli: CliSession,
    pon: string,
    ontId: number,
    sn: string,
  ): Promise<DriverResult & { ontId: number }> {
    const existing = await cli.exec(`show onu info ${pon} ${ontId}`);
    if (/(SN|MAC)\s*:/i.test(existing)) {
      return { success: true, message: `ONU ${pon}/${ontId} already registered (idempotent)`, ontId };
    }
    const out = await cli.exec(`onu register ${pon} ${ontId} ${sn}`);
    HsgqOltDriver.assertOk(out, 'onu register', { host: this.creds.mgmtIp, ontId });
    return { success: true, message: `ONU ${sn} registered as ${pon}/${ontId}`, ontId };
  }

  private async nextFreeOntId(cli: CliSession, pon: string): Promise<number> {
    const raw = await cli.exec(`show onu info ${pon}`);
    const used = new Set<number>();
    for (const m of raw.matchAll(/ONU[\s-]*ID\s*:\s*(\d+)/gi)) used.add(Number(m[1]));
    for (let id = 1; id <= 128; id++) {
      if (!used.has(id)) return id;
    }
    throw new DriverError(`No free ONU ID on PON ${pon}`, { host: this.creds.mgmtIp, pon });
  }

  async deregisterOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    return this.serializeWrites(async () => this.deregisterOnuInner(await this.getCli(), pon, ontId));
  }

  /** Unserialized core of deregisterOnu. */
  private async deregisterOnuInner(cli: CliSession, pon: string, ontId: number): Promise<DriverResult> {
    const out = await cli.exec(`onu deregister ${pon} ${ontId}`);
    if (/Failure|Error:/i.test(out) && !/not exist|no such/i.test(out)) {
      HsgqOltDriver.assertOk(out, 'onu deregister', { host: this.creds.mgmtIp, ontId });
    }
    return { success: true, message: `ONU ${pon}/${ontId} deregistered` };
  }

  async setOnuServiceProfile(ponPort: string, ontId: number, profile: string): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    return this.serializeWrites(async () => this.setOnuServiceProfileInner(await this.getCli(), pon, ontId, profile));
  }

  /** Unserialized core of setOnuServiceProfile. */
  private async setOnuServiceProfileInner(
    cli: CliSession,
    pon: string,
    ontId: number,
    profile: string,
  ): Promise<DriverResult> {
    const out = await cli.exec(`onu service-profile ${pon} ${ontId} ${profile}`);
    HsgqOltDriver.assertOk(out, 'service-profile bind', { host: this.creds.mgmtIp, ontId, profile });
    return { success: true, message: `ONU ${pon}/${ontId} service profile set to ${profile}` };
  }

  async setOnuVlan(ponPort: string, ontId: number, vlanId: number, nativeVlan?: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    if (vlanId < 1 || vlanId > 4094) throw new DriverError(`Invalid VLAN ID ${vlanId}`, { ponPort });
    return this.serializeWrites(async () => this.setOnuVlanInner(await this.getCli(), pon, ontId, vlanId, nativeVlan));
  }

  /** Unserialized core of setOnuVlan. */
  private async setOnuVlanInner(
    cli: CliSession,
    pon: string,
    ontId: number,
    vlanId: number,
    nativeVlan?: number,
  ): Promise<DriverResult> {
    const out = await cli.exec(`onu vlan ${pon} ${ontId} ${vlanId}`);
    HsgqOltDriver.assertOk(out, 'onu vlan', { host: this.creds.mgmtIp, ontId, vlanId });
    if (nativeVlan !== undefined && nativeVlan !== vlanId) {
      const nvOut = await cli.exec(`onu pvid ${pon} ${ontId} ${nativeVlan}`);
      HsgqOltDriver.assertOk(nvOut, 'onu pvid', { host: this.creds.mgmtIp, ontId });
    }
    return { success: true, message: `ONU ${pon}/${ontId} VLAN set to ${vlanId}` };
  }

  async setOnuSpeedCap(ponPort: string, ontId: number, downMbps: number, upMbps: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    const upKbps = Math.max(64, Math.round(upMbps * 1024));
    const downKbps = Math.max(64, Math.round(downMbps * 1024));
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      const out = await cli.exec(`onu speed-limit ${pon} ${ontId} ${upKbps} ${downKbps}`);
      HsgqOltDriver.assertOk(out, 'speed-limit', { host: this.creds.mgmtIp, ontId });
      return { success: true, message: `ONU ${pon}/${ontId} capped at ${downMbps}/${upMbps} Mbps (down/up)` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Telemetry (CLI)                                                  */
  /* ---------------------------------------------------------------- */

  async getOnuOpticalPower(ponPort: string, ontId: number): Promise<OnuOpticalPower> {
    const pon = normalizePon(ponPort);
    const cli = await this.getCli();
    const raw = await cli.exec(`show onu optical-info ${pon} ${ontId}`);
    const rx = raw.match(/Rx[^:]*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    const tx = raw.match(/Tx[^:]*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    if (rx === undefined || tx === undefined) {
      throw new DriverError('Optical power unavailable via CLI', { host: this.creds.mgmtIp, ponPort, ontId, raw: raw.slice(0, 300) });
    }
    return { rxDbm: Number(rx), txDbm: Number(tx) };
  }

  async getOnuStatus(ponPort: string, ontId: number): Promise<'online' | 'offline' | 'los'> {
    const pon = normalizePon(ponPort);
    const cli = await this.getCli();
    const raw = await cli.exec(`show onu status ${pon} ${ontId}`);
    if (/\bonline\b/i.test(raw)) return 'online';
    if (/\blos\b/i.test(raw)) return 'los';
    if (/not exist|no such/i.test(raw)) {
      throw new DriverError(`ONU ${pon}/${ontId} not found`, { host: this.creds.mgmtIp, ponPort, ontId });
    }
    return 'offline';
  }

  async rebootOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      const out = await cli.exec(`onu reboot ${pon} ${ontId}`);
      HsgqOltDriver.assertOk(out, 'onu reboot', { host: this.creds.mgmtIp, ontId });
      return { success: true, message: `ONU ${pon}/${ontId} reboot initiated` };
    });
  }

  async replaceOnu(ponPort: string, oldOntId: number, newSn: string): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    const sn = newSn.toUpperCase();
    if (!HsgqOltDriver.validSn(sn)) throw new DriverError(`Invalid HSGQ ONU identifier "${newSn}"`, { ponPort });
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      // 1) Snapshot.
      const info = await cli.exec(`show onu info ${pon} ${oldOntId}`);
      if (!/(SN|MAC)\s*:/i.test(info)) {
        throw new DriverError(`ONU ${pon}/${oldOntId} not found`, { host: this.creds.mgmtIp, ponPort });
      }
      const vlan = info.match(/VLAN\s*:\s*(\d+)/i)?.[1];
      const profile = info.match(/service-profile\s*:\s*(\S+)/i)?.[1];
      // 2) Swap (inner, unserialized variants — we already hold the mutex).
      await this.deregisterOnuInner(cli, pon, oldOntId);
      const reg = await this.registerOnuInner(cli, pon, oldOntId, sn);
      if (!reg.success) throw new DriverError('Replacement ONU registration failed', { host: this.creds.mgmtIp, ponPort });
      // 3) Restore VLAN + profile.
      if (vlan) await this.setOnuVlanInner(cli, pon, oldOntId, Number(vlan));
      if (profile) await this.setOnuServiceProfileInner(cli, pon, oldOntId, profile);
      return { success: true, message: `ONU swapped: ${pon}/${oldOntId} now uses ${sn} (config preserved)` };
    });
  }
}
