/**
 * Deklarasi tipe minimal untuk `telnet-client` (tidak ada @types resmi yang
 * valid di npm untuk v2.x). Dipakai oleh OLT shell session (olt-shell.ts).
 */
declare module 'telnet-client' {
  export interface TelnetConnectOptions {
    host: string;
    port?: number;
    shellPrompt?: string | RegExp;
    timeout?: number;
    username?: string;
    password?: string;
    loginPrompt?: string | RegExp;
    passwordPrompt?: string | RegExp;
    failedLoginMatch?: string | RegExp;
    initialLFCR?: boolean;
    [key: string]: unknown;
  }

  export class Telnet {
    connect(options: TelnetConnectOptions): Promise<void>;
    exec(
      command: string,
      options?: Record<string, unknown>,
    ): Promise<string>;
    send(data: string, options?: Record<string, unknown>): Promise<string>;
    shell(): Promise<unknown>;
    end(): Promise<void>;
    destroy(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export default Telnet;
}
