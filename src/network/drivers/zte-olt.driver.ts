import {
  DriverError,
  DriverResult,
  OltCredentials,
  OltDriver,
  OnuDiscoveryResult,
  OnuOpticalPower,
} from './network-driver.interface';
import { OltSnmpClient } from './olt-snmp';
import { CliSession, SshShellSession } from './olt-shell';

/* ------------------------------------------------------------------ */
/*  ZTE ZXA10 (C320 / C300) MIB roots                                  */
/*  Under ZTE enterprise 1.3.6.1.4.1.3902.1082, zxAnPonOnt* tables.     */
/*  Exact sub-identifiers vary between C320 V1.x/V2.x firmware; the    */
/*  column offsets below follow the zxAnPonOnt table family and should */
/*  be calibrated against `snmpwalk` output per deployment.            */
/* ------------------------------------------------------------------ */
const ZTE_ENTERPRISE = '1.3.6.1.4.1.3902.1082';
const OID_ZTE_ONT_TABLE = `${ZTE_ENTERPRISE}.500.20.2.2.2.1`; // zxAnPonOntTable
const OID_ZTE_ONT_SN_COL = `${OID_ZTE_ONT_TABLE}.3`; // zxAnPonOntSn — OCTET STRING
const OID_ZTE_ONT_STATE_COL = `${OID_ZTE_ONT_TABLE}.7`; // zxAnPonOntState: 1=online,2=offline,3=los
const OID_ZTE_ONT_RX_COL = `${OID_ZTE_ONT_TABLE}.11`; // zxAnPonOntRxPower — 0.01 dBm
const OID_ZTE_ONT_TX_COL = `${OID_ZTE_ONT_TABLE}.12`; // zxAnPonOntTxPower — 0.01 dBm

/**
 * ZTE ONT SNMP index encoding used by this driver:
 *   index = (shelf << 24) | (slot << 16) | (pon << 8) | ontId
 * (Shelf is 1 on single-shelf C320/C300 chassis.)
 */
const ZTE_SHELF = 1;
function encodeOntIndex(slot: number, pon: number, ontId: number): number {
  return (ZTE_SHELF << 24) | (slot << 16) | (pon << 8) | ontId;
}

/** ZTE CLI prompt: `ZTE>`, `ZTE#`, `ZTE(config)#`, `ZTE(config-if)#`, ... */
const ZTE_PROMPT = /(^|\n)[\w.\-()]+(\([^()\n]*\))?[#>] ?$/;

/**
 * ZTE ZXA10 C320 / C300 OLT driver.
 *
 * - Telemetry/discovery : SNMP (zxAnPonOnt* tables) + `show` commands
 * - Provisioning        : interactive SSH shell (ZXA10 config views)
 *
 * PON port format: "slot/pon", e.g. "1/2" (also accepts "gpon_olt-1/2").
 * For ZTE, `lineProfile` carries the ONU hardware type (e.g. "ZTEG-F660")
 * and `serviceProfile` the service template name bound under pon-onu-mng.
 */
export class ZteOltDriver extends OltDriver {
  protected readonly hostKey: string;

  private readonly creds: OltCredentials;
  private readonly snmp: OltSnmpClient;
  private cli: CliSession | null = null;
  private cliOpen: Promise<CliSession> | null = null;

  constructor(creds: OltCredentials) {
    super();
    this.creds = { sshPort: 22, ...creds };
    this.hostKey = `olt:${creds.mgmtIp}`;
    this.snmp = new OltSnmpClient(creds.mgmtIp, creds.snmpCommunity, creds.snmpVersion);
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async connect(): Promise<void> {
    await this.snmp.get(['1.3.6.1.2.1.1.1.0']); // sysDescr reachability check
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
      this.cliOpen = SshShellSession.open({
        host: this.creds.mgmtIp,
        port: this.creds.sshPort ?? 22,
        username: this.creds.sshUsername,
        password: this.creds.sshPassword,
        prompt: ZTE_PROMPT,
        pager: /--More--/,
        onClose: () => {
          this.cli = null;
          this.cliOpen = null;
        },
      }).then((s) => {
        this.cli = s;
        return s;
      });
      this.cliOpen.catch(() => {
        this.cliOpen = null;
      });
    }
    return this.cliOpen;
  }

  private static parsePon(ponPort: string): { slot: number; pon: number } {
    const m = ponPort.replace(/^gpon_olt-/i, '').match(/^(\d+)\/(\d+)$/);
    if (!m) throw new DriverError(`Invalid ZTE PON port "${ponPort}" (expected slot/pon, e.g. 1/2)`, { ponPort });
    return { slot: Number(m[1]), pon: Number(m[2]) };
  }

  private static validSn(sn: string): boolean {
    return /^[0-9A-Za-z]{12}$/.test(sn) || /^[0-9A-Fa-f]{16}$/.test(sn);
  }

  private onuRef(slot: number, pon: number, ontId: number): string {
    return `gpon_onu-${slot}/${pon}:${ontId}`;
  }

  private oltRef(slot: number, pon: number): string {
    return `gpon_olt-${slot}/${pon}`;
  }

  /** Run fn inside `configure terminal` ... `end`. */
  private async inConfig<T>(fn: () => Promise<T>): Promise<T> {
    const cli = await this.getCli();
    await cli.exec('configure terminal');
    try {
      return await fn();
    } finally {
      await cli.exec('end');
    }
  }

  private static assertOk(output: string, what: string, ctx: Record<string, unknown>): void {
    if (/% (Invalid|Incomplete|Ambiguous)|Error:/i.test(output)) {
      throw new DriverError(`ZTE ${what} failed: ${output.split('\n')[0]}`, ctx);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Discovery                                                        */
  /* ---------------------------------------------------------------- */

  async discoverUnconfiguredOnus(ponPort?: string): Promise<OnuDiscoveryResult[]> {
    const cli = await this.getCli();
    const results: OnuDiscoveryResult[] = [];
    const ports = ponPort ? [ponPort] : await this.listPonPorts(cli);

    for (const p of ports) {
      const { slot, pon } = ZteOltDriver.parsePon(p);
      const raw = await cli.exec(`show pon onu uncfg ${this.oltRef(slot, pon)}`);
      // Typical rows: "gpon_onu-1/2:3   ZTEGC1A2B3C4D   unconfigured"
      for (const m of raw.matchAll(/gpon_onu-(\d+)\/(\d+):(\d+)\s+([0-9A-Za-z]{12,16})/g)) {
        const sn = m[4].toUpperCase();
        if (!ZteOltDriver.validSn(sn)) continue;
        results.push({ sn, ponPort: `${m[1]}/${m[2]}`, ontId: Number(m[3]) });
      }
      // Fallback: bare SN tokens when the table prints without the onu ref.
      if (results.length === 0) {
        for (const m of raw.matchAll(/\b((?:[0-9A-Fa-f]{16})|(?:[A-Z]{4}[0-9A-Z]{8}))\b/g)) {
          const sn = m[1].toUpperCase();
          if (results.some((r) => r.sn === sn)) continue;
          results.push({ sn, ponPort: p });
        }
      }
    }

    // SNMP enrichment: walk the ONT table; entries whose state column marks
    // them unconfigured are merged (deduplicated by SN).
    try {
      const [snVbs, stateVbs] = await Promise.all([
        this.snmp.walk(OID_ZTE_ONT_SN_COL),
        this.snmp.walk(OID_ZTE_ONT_STATE_COL),
      ]);
      const stateByIndex = new Map<string, number>();
      for (const vb of stateVbs) stateByIndex.set(OltSnmpClient.indexOf(vb, OID_ZTE_ONT_STATE_COL), OltSnmpClient.toInt(vb));
      for (const vb of snVbs) {
        const index = OltSnmpClient.indexOf(vb, OID_ZTE_ONT_SN_COL);
        if (stateByIndex.get(index) !== 0) continue; // 0 = unconfigured in zxAnPonOntState
        const sn = OltSnmpClient.toString(vb).toUpperCase();
        if (!ZteOltDriver.validSn(sn) || results.some((r) => r.sn === sn)) continue;
        const idx = Number.parseInt(index, 10);
        const slot = (idx >> 16) & 0xff;
        const pon = (idx >> 8) & 0xff;
        const p = `${slot}/${pon}`;
        if (ponPort && p !== ponPort) continue;
        results.push({ sn, ponPort: p, ontId: idx & 0xff });
      }
    } catch {
      /* best-effort enrichment */
    }
    return results;
  }

  private async listPonPorts(cli: CliSession): Promise<string[]> {
    const raw = await cli.exec('show pon onu uncfg');
    const ports = new Set<string>();
    for (const m of raw.matchAll(/gpon_olt-(\d+\/\d+)/g)) ports.add(m[1]);
    if (ports.size === 0) {
      // Fallback: enumerate from the card inventory.
      const cards = await cli.exec('show card');
      for (const m of cards.matchAll(/gpon_olt-(\d+)\/(\d+)/g)) ports.add(`${m[1]}/${m[2]}`);
    }
    return [...ports];
  }

  /* ---------------------------------------------------------------- */
  /*  Provisioning                                                     */
  /* ---------------------------------------------------------------- */

  private async usedOntIds(slot: number, pon: number): Promise<Set<number>> {
    const cli = await this.getCli();
    const raw = await cli.exec(`show gpon onu state ${this.oltRef(slot, pon)}`);
    const used = new Set<number>();
    for (const m of raw.matchAll(new RegExp(`gpon_onu-${slot}/${pon}:(\\d+)`, 'g'))) used.add(Number(m[1]));
    return used;
  }

  private async nextFreeOntId(slot: number, pon: number): Promise<number> {
    const used = await this.usedOntIds(slot, pon);
    for (let id = 1; id <= 128; id++) {
      if (!used.has(id)) return id;
    }
    throw new DriverError(`No free ONT ID on ${this.oltRef(slot, pon)}`, { host: this.creds.mgmtIp });
  }

  async registerOnu(params: {
    ponPort: string;
    ontId?: number;
    sn: string;
    lineProfile: string;
    serviceProfile: string;
  }): Promise<DriverResult & { ontId?: number }> {
    const { slot, pon } = ZteOltDriver.parsePon(params.ponPort);
    const sn = params.sn.toUpperCase();
    if (!ZteOltDriver.validSn(sn)) throw new DriverError(`Invalid ZTE ONT SN "${params.sn}"`, { ponPort: params.ponPort });
    return this.serializeWrites(async () => {
      const ontId = params.ontId ?? (await this.nextFreeOntId(slot, pon));
      return this.registerOnuInner(slot, pon, ontId, sn, params.lineProfile, params.serviceProfile);
    });
  }

  /** Unserialized core of registerOnu (called directly by replaceOnu to avoid mutex re-entry). */
  private async registerOnuInner(
    slot: number,
    pon: number,
    ontId: number,
    sn: string,
    lineProfile: string,
    serviceProfile: string,
  ): Promise<DriverResult & { ontId: number }> {
    const onuType = /-/.test(lineProfile) ? lineProfile : 'ZTEG-F660';
    await this.inConfig(async () => {
      const cli = await this.getCli();
      const existing = await cli.exec(`show gpon onu detail-info ${this.onuRef(slot, pon, ontId)}`);
      if (/SN\s*:/i.test(existing)) {
        return; // idempotent
      }
      const out = await cli.exec(`onu add ${this.oltRef(slot, pon)} ${ontId} sn ${sn}`);
      ZteOltDriver.assertOk(out, 'onu add', { host: this.creds.mgmtIp, ontId });
      // Bind hardware type + service template under pon-onu-mng.
      await cli.exec(`pon-onu-mng ${this.onuRef(slot, pon, ontId)}`);
      const typeOut = await cli.exec(`onu ${ontId} type ${onuType}`);
      if (/% Invalid/i.test(typeOut)) {
        await cli.exec(`exit`);
        throw new DriverError(`Unknown ZTE ONU type "${onuType}": ${typeOut}`, { host: this.creds.mgmtIp });
      }
      if (serviceProfile) {
        await cli.exec(`service ${serviceProfile} gemport 1`);
      }
      await cli.exec(`exit`);
    });
    return { success: true, message: `ONU ${sn} registered as ${this.onuRef(slot, pon, ontId)}`, ontId };
  }

  async deregisterOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    return this.serializeWrites(() => this.deregisterOnuInner(slot, pon, ontId));
  }

  /** Unserialized core of deregisterOnu. */
  private async deregisterOnuInner(slot: number, pon: number, ontId: number): Promise<DriverResult> {
    await this.inConfig(async () => {
      const cli = await this.getCli();
      await cli.exec(`interface ${this.oltRef(slot, pon)}`);
      const out = await cli.exec(`no onu ${ontId}`);
      await cli.exec(`exit`);
      if (/% Invalid/i.test(out) && !/not exist/i.test(out)) {
        ZteOltDriver.assertOk(out, 'onu delete', { host: this.creds.mgmtIp, ontId });
      }
    });
    return { success: true, message: `ONU ${this.onuRef(slot, pon, ontId)} deregistered` };
  }

  async setOnuServiceProfile(ponPort: string, ontId: number, profile: string): Promise<DriverResult> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    return this.serializeWrites(async () => {
      await this.inConfig(async () => {
        const cli = await this.getCli();
        await cli.exec(`pon-onu-mng ${this.onuRef(slot, pon, ontId)}`);
        const out = await cli.exec(`service ${profile} gemport 1`);
        await cli.exec(`exit`);
        ZteOltDriver.assertOk(out, 'service profile bind', { host: this.creds.mgmtIp, ponPort, ontId, profile });
      });
      return { success: true, message: `ONU ${this.onuRef(slot, pon, ontId)} service profile set to ${profile}` };
    });
  }

  async setOnuVlan(ponPort: string, ontId: number, vlanId: number, nativeVlan?: number): Promise<DriverResult> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    if (vlanId < 1 || vlanId > 4094) throw new DriverError(`Invalid VLAN ID ${vlanId}`, { ponPort });
    return this.serializeWrites(() => this.setOnuVlanInner(slot, pon, ontId, vlanId, nativeVlan));
  }

  /** Unserialized core of setOnuVlan. */
  private async setOnuVlanInner(
    slot: number,
    pon: number,
    ontId: number,
    vlanId: number,
    nativeVlan?: number,
  ): Promise<DriverResult> {
    const cli = await this.getCli();
    // OLT side: service-port binding (idempotent check first).
    await this.inConfig(async () => {
      const existing = await cli.exec(`show service-port ${this.oltRef(slot, pon)} ont ${ontId}`);
      if (!new RegExp(`vlan\\s+${vlanId}`, 'i').test(existing)) {
        const out = await cli.exec(`service-port ${vlanId} ${this.oltRef(slot, pon)} ont ${ontId}`);
        ZteOltDriver.assertOk(out, 'service-port create', { host: this.creds.mgmtIp, ontId, vlanId });
      }
      // ONU side: tag/untag the LAN port.
      await cli.exec(`pon-onu-mng ${this.onuRef(slot, pon, ontId)}`);
      const nvlan = nativeVlan ?? vlanId;
      const vOut = await cli.exec(`vlan port eth_0/1 mode tag vlan ${vlanId}`);
      ZteOltDriver.assertOk(vOut, 'onu vlan tag', { host: this.creds.mgmtIp, ontId });
      if (nativeVlan !== undefined && nativeVlan !== vlanId) {
        await cli.exec(`vlan port eth_0/2 mode untag vlan ${nvlan}`);
      }
      await cli.exec(`exit`);
    });
    return { success: true, message: `ONU ${this.onuRef(slot, pon, ontId)} VLAN set to ${vlanId}` };
  }

  async setOnuSpeedCap(ponPort: string, ontId: number, downMbps: number, upMbps: number): Promise<DriverResult> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    const upKbps = Math.max(64, Math.round(upMbps * 1024));
    const downKbps = Math.max(64, Math.round(downMbps * 1024));
    return this.serializeWrites(async () => {
      await this.inConfig(async () => {
        const cli = await this.getCli();
        await cli.exec(`pon-onu-mng ${this.onuRef(slot, pon, ontId)}`);
        const out = await cli.exec(`traffic-limit upstream pir ${upKbps} downstream pir ${downKbps}`);
        await cli.exec(`exit`);
        ZteOltDriver.assertOk(out, 'traffic-limit', { host: this.creds.mgmtIp, ponPort, ontId });
      });
      return { success: true, message: `ONU ${this.onuRef(slot, pon, ontId)} capped at ${downMbps}/${upMbps} Mbps (down/up)` };
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Telemetry                                                        */
  /* ---------------------------------------------------------------- */

  async getOnuOpticalPower(ponPort: string, ontId: number): Promise<OnuOpticalPower> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    const index = encodeOntIndex(slot, pon, ontId);
    try {
      const vbs = await this.snmp.get([`${OID_ZTE_ONT_RX_COL}.${index}`, `${OID_ZTE_ONT_TX_COL}.${index}`]);
      if (vbs.length === 2 && !vbs.some((vb) => OltSnmpClient.isError(vb))) {
        return { rxDbm: OltSnmpClient.toInt(vbs[0]) / 100, txDbm: OltSnmpClient.toInt(vbs[1]) / 100 };
      }
    } catch {
      /* fall through to CLI */
    }
    const cli = await this.getCli();
    const raw = await cli.exec(`show pon power attenuation ${this.onuRef(slot, pon, ontId)}`);
    const rx = raw.match(/Rx[^:]*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    const tx = raw.match(/Tx[^:]*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    if (rx === undefined || tx === undefined) {
      throw new DriverError('Optical power unavailable via SNMP and CLI', { host: this.creds.mgmtIp, ponPort, ontId });
    }
    return { rxDbm: Number(rx), txDbm: Number(tx) };
  }

  async getOnuStatus(ponPort: string, ontId: number): Promise<'online' | 'offline' | 'los'> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    const index = encodeOntIndex(slot, pon, ontId);
    try {
      const vbs = await this.snmp.get([`${OID_ZTE_ONT_STATE_COL}.${index}`]);
      if (vbs.length > 0 && !OltSnmpClient.isError(vbs[0])) {
        const state = OltSnmpClient.toInt(vbs[0]);
        if (state === 1) return 'online';
        if (state === 3) return 'los';
        if (state === 2) return 'offline';
      }
    } catch {
      /* fall through to CLI */
    }
    const cli = await this.getCli();
    const raw = await cli.exec(`show gpon onu state ${this.oltRef(slot, pon)}`);
    const line = raw.split('\n').find((l) => l.includes(`:${ontId}`) || l.includes(` ${ontId} `));
    if (line) {
      if (/\bonline\b/i.test(line)) return 'online';
      if (/\blos\b/i.test(line)) return 'los';
    }
    return 'offline';
  }

  async rebootOnu(ponPort: string, ontId: number): Promise<DriverResult> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    return this.serializeWrites(async () => {
      await this.inConfig(async () => {
        const cli = await this.getCli();
        await cli.exec(`pon-onu-mng ${this.onuRef(slot, pon, ontId)}`);
        const out = await cli.exec(`reboot`);
        await cli.exec(`exit`);
        ZteOltDriver.assertOk(out, 'onu reboot', { host: this.creds.mgmtIp, ponPort, ontId });
      });
      return { success: true, message: `ONU ${this.onuRef(slot, pon, ontId)} reboot initiated` };
    });
  }

  async replaceOnu(ponPort: string, oldOntId: number, newSn: string): Promise<DriverResult> {
    const { slot, pon } = ZteOltDriver.parsePon(ponPort);
    const sn = newSn.toUpperCase();
    if (!ZteOltDriver.validSn(sn)) throw new DriverError(`Invalid ZTE ONT SN "${newSn}"`, { ponPort });
    return this.serializeWrites(async () => {
      // 1) Snapshot current configuration.
      const cli = await this.getCli();
      const detail = await cli.exec(`show gpon onu detail-info ${this.onuRef(slot, pon, oldOntId)}`);
      if (!/SN\s*:/i.test(detail)) {
        throw new DriverError(`ONU ${this.onuRef(slot, pon, oldOntId)} not found`, { host: this.creds.mgmtIp, ponPort });
      }
      const onuType = detail.match(/Type\s*:\s*(\S+)/i)?.[1] ?? 'ZTEG-F660';
      const service = detail.match(/Service\s*:\s*(\S+)/i)?.[1];
      const vlan = detail.match(/VLAN\s*:\s*(\d+)/i)?.[1];
      // 2) Remove + re-add with the new SN, preserving type/service/VLAN.
      //    Inner (unserialized) variants are used: we already hold the mutex.
      await this.deregisterOnuInner(slot, pon, oldOntId);
      await this.registerOnuInner(slot, pon, oldOntId, sn, onuType, service ?? '');
      if (vlan) await this.setOnuVlanInner(slot, pon, oldOntId, Number(vlan));
      return { success: true, message: `ONU swapped: ${this.onuRef(slot, pon, oldOntId)} now uses SN ${sn} (config preserved)` };
    });
  }
}
