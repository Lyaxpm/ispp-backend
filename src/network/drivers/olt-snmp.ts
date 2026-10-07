import * as snmp from 'net-snmp';
import { DriverError } from './network-driver.interface';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

/**
 * Thin, honest SNMP client for OLT telemetry built on `net-snmp`.
 *
 * - Version mapping: '1' -> Version1, '2'/'2c' -> Version2c.
 *   SNMPv3 is deliberately unsupported (no auth material in OltCredentials).
 * - `get`  : point queries (optical DDM, run-state, ...)
 * - `walk` : subtree walks via repeated getBulk (discovery tables)
 *
 * Sessions are short-lived (one per call): OLT polling is infrequent and
 * this avoids stale UDP session state.
 */
export class OltSnmpClient {
  constructor(
    private readonly host: string,
    private readonly community: string,
    private readonly version: string | number,
  ) {}

  private versionEnum(): snmp.Version {
    const v = String(this.version).toLowerCase();
    if (v === '1') return snmp.Version1;
    if (v === '2' || v === '2c') return snmp.Version2c;
    throw new DriverError(`SNMPv3 is not supported by OltSnmpClient (got "${v}")`, { host: this.host });
  }

  private createSession(): snmp.Session {
    return snmp.createSession(this.host, this.community, {
      version: this.versionEnum(),
      timeout: DEFAULT_TIMEOUT_MS,
      retries: DEFAULT_RETRIES,
      transport: 'udp4',
    });
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DriverError(`SNMP ${what} timed out after ${ms}ms`, { host: this.host })),
        ms,
      );
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async get(oids: string[]): Promise<snmp.VarBind[]> {
    const session = this.createSession();
    try {
      return await this.withTimeout(
        new Promise<snmp.VarBind[]>((resolve, reject) => {
          session.get(oids, (err, varbinds) => {
            if (err) {
              return reject(
                new DriverError('SNMP GET failed', { host: this.host, oids, cause: err.message }),
              );
            }
            resolve(varbinds ?? []);
          });
        }),
        DEFAULT_TIMEOUT_MS + 4000,
        'GET',
      );
    } finally {
      session.close();
    }
  }

  /**
   * Subtree walk using repeated getBulk requests. Stops when the returned
   * OIDs leave the requested subtree or repeat.
   */
  async walk(rootOid: string, maxRepetitions = 25): Promise<snmp.VarBind[]> {
    const session = this.createSession();
    try {
      const results: snmp.VarBind[] = [];
      const prefix = `${rootOid}.`;
      let nextOid = rootOid;
      for (let i = 0; i < 400; i++) {
        const batch = await this.withTimeout(
          new Promise<snmp.VarBind[]>((resolve, reject) => {
            const collected: snmp.VarBind[] = [];
            session.getBulk(
              [nextOid],
              0,
              maxRepetitions,
              (feedVbs) => {
                for (const vb of feedVbs) {
                  if (snmp.isVarbindError(vb)) continue;
                  if (!vb.oid.startsWith(prefix)) return false;
                  collected.push(vb);
                }
                return true;
              },
              (err) => {
                if (err) {
                  return reject(
                    new DriverError('SNMP getBulk walk failed', {
                      host: this.host,
                      rootOid,
                      cause: err.message,
                    }),
                  );
                }
                resolve(collected);
              },
            );
          }),
          DEFAULT_TIMEOUT_MS + 4000,
          'WALK',
        );
        if (batch.length === 0) break;
        results.push(...batch);
        const last = batch[batch.length - 1].oid;
        if (last === nextOid || !last.startsWith(prefix)) break;
        nextOid = last;
      }
      return results;
    } finally {
      session.close();
    }
  }

  /** Varbind value -> printable string (handles OCTET STRING buffers). */
  static toString(vb: snmp.VarBind): string {
    const v = vb.value;
    if (Buffer.isBuffer(v)) {
      const ascii = v.toString('ascii');
      // eslint-disable-next-line no-control-regex
      return /^[\x20-\x7E]+$/.test(ascii) ? ascii.trim() : v.toString('hex').toUpperCase();
    }
    return String(v);
  }

  /** Varbind value -> integer (handles 4-byte big-endian buffers). */
  static toInt(vb: snmp.VarBind): number {
    const v = vb.value;
    if (typeof v === 'number') return v;
    if (Buffer.isBuffer(v) && v.length >= 4) return v.readInt32BE(0);
    if (Buffer.isBuffer(v)) return Number.parseInt(v.toString('hex'), 16) || 0;
    return Number.parseInt(String(v), 10) || 0;
  }

  /** Table index portion of a varbind OID, given the column root OID. */
  static indexOf(vb: snmp.VarBind, columnOid: string): string {
    return vb.oid.slice(columnOid.length + 1);
  }

  static isError(vb: snmp.VarBind): boolean {
    return snmp.isVarbindError(vb);
  }
}
