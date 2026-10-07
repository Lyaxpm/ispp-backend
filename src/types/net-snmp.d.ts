/**
 * Deklarasi tipe minimal untuk `net-snmp` (tidak ada @types resmi).
 * Mencakup permukaan API yang dipakai driver OLT: createSession, get,
 * getBulk (dengan feed callback ala walk), isVarbindError.
 */
declare module 'net-snmp' {
  export type Version = 0 | 1;
  export const Version1: Version;
  export const Version2c: Version;

  export interface VarBind {
    oid: string;
    type: number;
    value: string | number | Buffer | null;
  }

  export interface SessionOptions {
    port?: number;
    retries?: number;
    timeout?: number;
    transport?: string;
    trapPort?: number;
    version?: Version;
    [key: string]: unknown;
  }

  export type GetCallback = (
    err: Error | null,
    varbinds: VarBind[],
  ) => void;
  export type FeedCallback = (varbinds: VarBind[]) => boolean | void;
  export type DoneCallback = (err: Error | null) => void;

  export interface Session {
    get(oids: string[], callback: GetCallback): void;
    getBulk(
      oids: string[],
      nonRepeaters: number,
      maxRepetitions: number,
      feedCallback: FeedCallback,
      doneCallback: DoneCallback,
    ): void;
    close(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export function createSession(
    target: string,
    community: string,
    options?: SessionOptions,
  ): Session;

  export function isVarbindError(varbind: VarBind): boolean;

  const _default: {
    createSession: typeof createSession;
    isVarbindError: typeof isVarbindError;
    Version1: Version;
    Version2c: Version;
  };
  export default _default;
}
