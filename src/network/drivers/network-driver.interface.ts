/**
 * Shared driver contracts for the ISP Network Automation Layer.
 *
 * Two families of drivers:
 *  - RouterDriver : MikroTik / BNG class devices managed through an API
 *  - OltDriver    : FTTH OLTs (Huawei / ZTE / Fiberhome / HSGQ) managed
 *                   through SNMP + SSH/Telnet CLI provisioning
 *
 * Every write against a physical device MUST be serialized through the
 * per-host promise-chain mutex (`serializeWrites`) so concurrent requests
 * for the same device can never interleave CLI/API commands.
 */

/* ------------------------------------------------------------------ */
/*  Shared value types                                                 */
/* ------------------------------------------------------------------ */

export interface PppoeSecret {
  username: string;
  password: string;
  profile: string;
  service?: string;
  callerId?: string;
  comment?: string;
}

export interface AddressListEntry {
  list: string;
  address: string;
  comment?: string;
  /** RouterOS timeout format, e.g. "1h", "30m", "0" = never */
  timeout?: string;
}

export interface NatRedirectRule {
  chain: 'dstnat' | 'srcnat';
  srcAddressList: string;
  protocol: 'tcp' | 'udp' | 'all';
  dstPort: string;
  toAddresses: string;
  toPorts: string;
  comment: string;
}

export interface SimpleQueue {
  name: string;
  target: string;
  /** RouterOS limit format, e.g. "1M/10M" (upload/download) */
  maxLimit: string;
  limitAt?: string;
  burstLimit?: string;
  burstTime?: string;
  comment?: string;
}

export interface ActiveSession {
  username: string;
  address: string;
  uptime: string;
  callerId: string;
}

export interface OnuDiscoveryResult {
  sn: string;
  mac?: string;
  ponPort: string;
  ontId?: number;
  rssi?: number;
}

export interface OnuOpticalPower {
  /** Received power in dBm */
  rxDbm: number;
  /** Transmitted power in dBm */
  txDbm: number;
}

export interface DriverResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface RouterCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  useTls: boolean;
}

export interface OltCredentials {
  mgmtIp: string;
  snmpCommunity: string;
  /** 1 | '2c' | 3 (string forms accepted from DB) */
  snmpVersion: string | number;
  sshUsername: string;
  sshPassword: string;
  sshPort?: number;
}

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

/** Structured error thrown by every driver on device communication failure. */
export class DriverError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DriverError';
    // Maintain a clean stack trace in V8
    if (Error.captureStackTrace) Error.captureStackTrace(this, DriverError);
  }
}

/* ------------------------------------------------------------------ */
/*  Per-host write mutex                                               */
/* ------------------------------------------------------------------ */

const hostWriteChains = new Map<string, Promise<unknown>>();

/**
 * Shared per-host promise-chain mutex implementation.
 * Extracted as a standalone helper so both driver families can use it
 * without duplicating state.
 */
export function serializeHostWrites<T>(hostKey: string, fn: () => Promise<T>): Promise<T> {
  const previous: Promise<unknown> = hostWriteChains.get(hostKey) ?? Promise.resolve();
  // Never let a rejected write break the chain for subsequent writes.
  const current: Promise<T> = previous
    .catch(() => undefined)
    .then(() => fn());
  hostWriteChains.set(hostKey, current.catch(() => undefined));
  return current;
}

/* ------------------------------------------------------------------ */
/*  RouterDriver (MikroTik / BNG class)                               */
/* ------------------------------------------------------------------ */

export abstract class RouterDriver {
  /** Unique key for the per-host write mutex (normally the device host). */
  protected abstract readonly hostKey: string;

  /** Serialize a write through the per-host mutex. */
  protected serializeWrites<T>(fn: () => Promise<T>): Promise<T> {
    return serializeHostWrites(this.hostKey, fn);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract upsertPppoeSecret(secret: PppoeSecret): Promise<DriverResult>;
  abstract removePppoeSecret(username: string): Promise<DriverResult>;
  abstract setPppoeProfile(username: string, profile: string): Promise<DriverResult>;

  abstract addAddressList(entry: AddressListEntry): Promise<DriverResult>;
  abstract removeAddressList(list: string, address: string): Promise<DriverResult>;

  abstract upsertNatRedirect(rule: NatRedirectRule & { comment: string }): Promise<DriverResult>;
  abstract removeNatRedirect(comment: string): Promise<DriverResult>;

  abstract kickPppoeSession(username: string): Promise<DriverResult>;
  abstract getActiveSessions(): Promise<ActiveSession[]>;

  abstract upsertSimpleQueue(queue: SimpleQueue): Promise<DriverResult>;
  abstract removeSimpleQueue(name: string): Promise<DriverResult>;

  abstract ping(host: string, count?: number): Promise<{ sent: number; received: number; avgMs: number }>;
  abstract getSystemResource(): Promise<{
    cpuLoad: number;
    freeMemory: number;
    uptime: string;
    version: string;
  }>;
}

/* ------------------------------------------------------------------ */
/*  OltDriver (FTTH OLT family)                                        */
/* ------------------------------------------------------------------ */

export abstract class OltDriver {
  /** Unique key for the per-host write mutex (normally the management IP). */
  protected abstract readonly hostKey: string;

  /** Serialize a write through the per-host mutex. */
  protected serializeWrites<T>(fn: () => Promise<T>): Promise<T> {
    return serializeHostWrites(this.hostKey, fn);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  /** Discover ONUs that are physically attached but not yet provisioned. */
  abstract discoverUnconfiguredOnus(ponPort?: string): Promise<OnuDiscoveryResult[]>;

  abstract registerOnu(params: {
    ponPort: string;
    ontId?: number;
    sn: string;
    lineProfile: string;
    serviceProfile: string;
  }): Promise<DriverResult & { ontId?: number }>;

  abstract deregisterOnu(ponPort: string, ontId: number): Promise<DriverResult>;

  abstract setOnuServiceProfile(ponPort: string, ontId: number, profile: string): Promise<DriverResult>;

  abstract setOnuVlan(
    ponPort: string,
    ontId: number,
    vlanId: number,
    nativeVlan?: number,
  ): Promise<DriverResult>;

  abstract setOnuSpeedCap(
    ponPort: string,
    ontId: number,
    downMbps: number,
    upMbps: number,
  ): Promise<DriverResult>;

  abstract getOnuOpticalPower(ponPort: string, ontId: number): Promise<OnuOpticalPower>;

  abstract getOnuStatus(ponPort: string, ontId: number): Promise<'online' | 'offline' | 'los'>;

  abstract rebootOnu(ponPort: string, ontId: number): Promise<DriverResult>;

  /**
   * Zero-touch ONT swap: replace the ONU at (ponPort, oldOntId) with a new
   * unit identified by serial number while preserving its configuration.
   */
  abstract replaceOnu(ponPort: string, oldOntId: number, newSn: string): Promise<DriverResult>;
}
