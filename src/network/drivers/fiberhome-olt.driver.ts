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
/*  Fiberhome AN5516-04 / AN5516-06                                    */
/*                                                                     */
/*  Transport: Telnet (port 23) is the primary management path used    */
/*  in the field for AN5516; SSH is attempted as a fallback when        */
/*  Telnet is refused. The same command templates work on both.        */
/*                                                                     */
/*  SNMP fallback note: Fiberhome (enterprise 1.3.6.1.4.1.5875) does   */
/*  not expose a stable, firmware-independent ONT DDM MIB on AN5516,   */
/*  so optical telemetry and state are read via CLI (`show ont        */
/*  optical`, `show ont info`). If a deployment calibrates the vendor  */
/*  MIB, wire it through OltSnmpClient the same way the Huawei/ZTE     */
/*  drivers do and prefer it in getOnuOpticalPower/getOnuStatus.       */
/*                                                                     */
/*  PON port format: "slot/pon", e.g. "0/1". A three-segment "f/s/p"   */
/*  value is tolerated by dropping the frame segment.                  */
/* ------------------------------------------------------------------ */

/** Fiberhome prompt: `OLT>`, `OLT#`, `OLT(config)#`, ... */
const FH_PROMPT = /(^|\n)[\w.\-()]+(\([^()\n]*\))?[#>] ?$/;

function normalizePon(ponPort: string): string {
  const parts = ponPort.replace(/^gpon[_-]?/i, '').split('/');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`; // drop frame
  if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) return ponPort;
  throw new DriverError(`Invalid Fiberhome PON port "${ponPort}" (expected slot/pon, e.g. 0/1)`, { ponPort });
}

export class FiberhomeOltDriver extends OltDriver {
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

  /** Telnet first (field standard), SSH fallback. */
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
        prompt: FH_PROMPT,
        disablePagingCommand: 'terminal length 0',
        onClose: clearCache,
      });
      await this.enterPrivileged(telnet);
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
        prompt: FH_PROMPT,
        pager: /--More--/,
        onClose: clearCache,
      });
      await this.enterPrivileged(ssh);
      return ssh;
    } catch (err) {
      throw new DriverError('Fiberhome CLI unreachable via Telnet and SSH', {
        host: mgmtIp,
        telnetCause: lastErr instanceof Error ? lastErr.message : String(lastErr),
        sshCause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async enterPrivileged(cli: CliSession): Promise<void> {
    await cli.exec('enable');
    await cli.exec('config');
  }

  private static validSn(sn: string): boolean {
    return /^[0-9A-Fa-f]{16}$/.test(sn);
  }

  private static assertOk(output: string, what: string, ctx: Record<string, unknown>): void {
    if (/Failure|Error:|Invalid|incomplete command/i.test(output)) {
      throw new DriverError(`Fiberhome ${what} failed: ${output.split('\n')[0]}`, ctx);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Discovery                                                        */
  /* ---------------------------------------------------------------- */

  async discoverUnconfiguredOnus(ponPort?: string): Promise<OnuDiscoveryResult[]> {
    const cli = await this.getCli();
    const raw = await cli.exec('show ont unbound');
    const results: OnuDiscoveryResult[] = [];
    // Rows look like: "  0/1   464942480001A2B3   FIBHOME"
    for (const m of raw.matchAll(/(\d+\/\d+)\s+([0-9A-Fa-f]{16})/g)) {
      const pon = m[1];
      const sn = m[2].toUpperCase();
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
    if (!FiberhomeOltDriver.validSn(sn)) {
      throw new DriverError(`Invalid Fiberhome ONT SN "${params.sn}" (expected 16 hex chars)`, { ponPort: params.ponPort });
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
    const existing = await cli.exec(`show ont info ${pon} ${ontId}`);
    if (/SN\s*:/i.test(existing)) {
      return { success: true, message: `ONT ${pon}/${ontId} already registered (idempotent)`, ontId };
    }
    const out = await cli.exec(`ont add ${pon} ${ontId} ${sn}`);
    FiberhomeOltDriver.assertOk(out, 'ont add', { host: this.creds.mgmtIp, ontId });
    return { success: true, message: `ONT ${sn} registered as ${pon}/${ontId}`, ontId };
  }

  private async nextFreeOntId(cli: CliSession, pon: string): Promise<number> {
    const raw = await cli.exec(`show ont info ${pon}`);
    const used = new Set<number>();
    for (const m of raw.matchAll(/ONT-ID\s*:\s*(\d+)|ont\s+\d+\s*:\s*(\d+)/gi)) {
      used.add(Number(m[1] ?? m[2]));
    }
    for (let id = 1; id <= 128; id++) {
      if (!used.has(id)) return id;
    }
    throw new DriverError(`No free ONT ID on PON ${pon}`, { host: this.creds.mgmtIp, pon });
  }

  async deregisterOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    return this.serializeWrites(async () => this.deregisterOnuInner(await this.getCli(), pon, ontId));
  }

  /** Unserialized core of deregisterOnu. */
  private async deregisterOnuInner(cli: CliSession, pon: string, ontId: number): Promise<DriverResult> {
    const out = await cli.exec(`ont delete ${pon} ${ontId}`);
    if (/Failure|Error:/i.test(out) && !/not exist|no such/i.test(out)) {
      FiberhomeOltDriver.assertOk(out, 'ont delete', { host: this.creds.mgmtIp, ontId });
    }
    return { success: true, message: `ONT ${pon}/${ontId} deregistered` };
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
    const out = await cli.exec(`ont service-profile ${pon} ${ontId} ${profile}`);
    FiberhomeOltDriver.assertOk(out, 'service-profile bind', { host: this.creds.mgmtIp, ontId, profile });
    return { success: true, message: `ONT ${pon}/${ontId} service profile set to ${profile}` };
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
    const out = await cli.exec(`ont port vlan ${pon} ${ontId} ${vlanId}`);
    FiberhomeOltDriver.assertOk(out, 'ont port vlan', { host: this.creds.mgmtIp, ontId, vlanId });
    if (nativeVlan !== undefined && nativeVlan !== vlanId) {
      const nvOut = await cli.exec(`ont port pvid ${pon} ${ontId} ${nativeVlan}`);
      FiberhomeOltDriver.assertOk(nvOut, 'ont port pvid', { host: this.creds.mgmtIp, ontId });
    }
    return { success: true, message: `ONT ${pon}/${ontId} VLAN set to ${vlanId}` };
  }

  async setOnuSpeedCap(ponPort: string, ontId: number, downMbps: number, upMbps: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    const upKbps = Math.max(64, Math.round(upMbps * 1024));
    const downKbps = Math.max(64, Math.round(downMbps * 1024));
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      // Find-or-create a traffic profile, then bind it to the ONT.
      const profileName = `CAP_${pon.replace('/', '_')}_${ontId}`;
      const list = await cli.exec('show traffic-profile');
      if (!list.includes(profileName)) {
        const cOut = await cli.exec(`traffic-profile add ${profileName} cir ${upKbps} pir ${downKbps}`);
        FiberhomeOltDriver.assertOk(cOut, 'traffic-profile add', { host: this.creds.mgmtIp, profileName });
      }
      const bOut = await cli.exec(`ont traffic-profile ${pon} ${ontId} ${profileName}`);
      FiberhomeOltDriver.assertOk(bOut, 'traffic-profile bind', { host: this.creds.mgmtIp, ponPort, ontId });
      return { success: true, message: `ONT ${pon}/${ontId} capped at ${downMbps}/${upMbps} Mbps (down/up)` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Telemetry (CLI; see SNMP fallback note in the file header)       */
  /* ---------------------------------------------------------------- */

  async getOnuOpticalPower(ponPort: string, ontId: number): Promise<OnuOpticalPower> {
    const pon = normalizePon(ponPort);
    const cli = await this.getCli();
    const raw = await cli.exec(`show ont optical ${pon} ${ontId}`);
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
    const raw = await cli.exec(`show ont info ${pon} ${ontId}`);
    if (/\bstate\s*:\s*online\b|\brun\s*:\s*up\b/i.test(raw)) return 'online';
    if (/\blos\b/i.test(raw)) return 'los';
    if (/not exist|no such/i.test(raw)) {
      throw new DriverError(`ONT ${pon}/${ontId} not found`, { host: this.creds.mgmtIp, ponPort, ontId });
    }
    return 'offline';
  }

  async rebootOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      const out = await cli.exec(`ont reboot ${pon} ${ontId}`);
      FiberhomeOltDriver.assertOk(out, 'ont reboot', { host: this.creds.mgmtIp, ponPort, ontId });
      return { success: true, message: `ONT ${pon}/${ontId} reboot initiated` };
    });
  }

  async replaceOnu(ponPort: string, oldOntId: number, newSn: string): Promise<DriverResult> {
    const pon = normalizePon(ponPort);
    const sn = newSn.toUpperCase();
    if (!FiberhomeOltDriver.validSn(sn)) throw new DriverError(`Invalid Fiberhome ONT SN "${newSn}"`, { ponPort });
    return this.serializeWrites(async () => {
      const cli = await this.getCli();
      // 1) Snapshot.
      const info = await cli.exec(`show ont info ${pon} ${oldOntId}`);
      if (!/SN\s*:/i.test(info)) {
        throw new DriverError(`ONT ${pon}/${oldOntId} not found`, { host: this.creds.mgmtIp, ponPort });
      }
      const vlan = info.match(/VLAN\s*:\s*(\d+)/i)?.[1];
      const profile = info.match(/service-profile\s*:\s*(\S+)/i)?.[1];
      // 2) Swap (inner, unserialized variants — we already hold the mutex).
      await this.deregisterOnuInner(cli, pon, oldOntId);
      const reg = await this.registerOnuInner(cli, pon, oldOntId, sn);
      if (!reg.success) throw new DriverError('Replacement ONT registration failed', { host: this.creds.mgmtIp, ponPort });
      // 3) Restore VLAN + profile.
      if (vlan) await this.setOnuVlanInner(cli, pon, oldOntId, Number(vlan));
      if (profile) await this.setOnuServiceProfileInner(cli, pon, oldOntId, profile);
      return { success: true, message: `ONT swapped: ${pon}/${oldOntId} now uses SN ${sn} (config preserved)` };
    });
  }
}
