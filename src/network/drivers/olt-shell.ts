import { Client as SshClient, ClientChannel } from 'ssh2';
import { Telnet } from 'telnet-client';
import { DriverError } from './network-driver.interface';

/**
 * Minimal command-session abstraction shared by the OLT drivers.
 * Both transports below give the driver a stateful CLI session where
 * `exec()` runs one command and resolves with its full output once the
 * device prompt returns. All commands are queued: concurrent callers can
 * never interleave bytes on the same session.
 */
export interface CliSession {
  exec(command: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

export interface SshShellOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Regex matching the device prompt at end-of-output, e.g. /(<[^>]+>|\[[^\]]+\])\s*$/ */
  prompt: RegExp;
  /** Pager marker, e.g. /---- More ----/ */
  pager?: RegExp;
  readyTimeoutMs?: number;
  /** Called when the underlying stream closes (drop, timeout, manual close). */
  onClose?: () => void;
}

/**
 * Interactive SSH shell (ssh2) with prompt synchronization.
 * Required for vendors (Huawei VRP, ZTE ZXA10) whose provisioning commands
 * only exist inside config-mode CLI views — plain exec channels cannot
 * navigate `enable -> config -> interface ...`.
 */
export class SshShellSession implements CliSession {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pendingReject: Array<(err: Error) => void> = [];

  private constructor(
    private readonly stream: ClientChannel,
    private readonly prompt: RegExp,
    private readonly pager: RegExp,
    private readonly host: string,
    onClose: () => void,
  ) {
    stream.on('close', () => {
      // Fail fast: never leave callers hanging on a dead session.
      for (const reject of this.pendingReject.splice(0)) {
        reject(new DriverError('CLI session closed unexpectedly', { host }));
      }
      onClose();
    });
    stream.on('error', () => {
      /* 'close' follows; handled above */
    });
  }

  static async open(opts: SshShellOptions): Promise<SshShellSession> {
    const readyTimeoutMs = opts.readyTimeoutMs ?? 20000;
    const client = new SshClient();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end();
        reject(new DriverError('SSH connection timed out', { host: opts.host }));
      }, readyTimeoutMs);
      if (timer.unref) timer.unref();
      client
        .on('ready', () => {
          clearTimeout(timer);
          resolve();
        })
        .on('error', (err) => {
          clearTimeout(timer);
          reject(new DriverError('SSH connection failed', { host: opts.host, cause: err.message }));
        })
        .connect({
          host: opts.host,
          port: opts.port,
          username: opts.username,
          password: opts.password,
          keepaliveInterval: 15000,
          readyTimeout: readyTimeoutMs,
        });
    });

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: 'vt100', cols: 200, rows: 60 }, (err, ch) => {
        if (err || !ch) return reject(new DriverError('Failed to open SSH shell', { host: opts.host, cause: err?.message }));
        resolve(ch);
      });
    });

    // Drain the login banner until the first prompt appears.
    await new Promise<void>((resolve) => {
      let banner = '';
      const done = (): void => {
        stream.off('data', onBanner);
        resolve();
      };
      const onBanner = (data: Buffer): void => {
        banner += data.toString();
        if (opts.prompt.test(banner)) done();
      };
      stream.on('data', onBanner);
      const t = setTimeout(done, 5000);
      if (t.unref) t.unref();
    });

    let session: SshShellSession;
    session = new SshShellSession(
      stream,
      opts.prompt,
      opts.pager ?? /---- More ----/,
      opts.host,
      () => {
        client.end();
        opts.onClose?.();
      },
    );
    return session;
  }

  exec(command: string, timeoutMs = 60000): Promise<string> {
    const run = this.queue.catch(() => undefined).then(() => this.execOnce(command, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private execOnce(command: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingReject.push(reject);
      const settle = (fn: () => void): void => {
        const i = this.pendingReject.indexOf(reject);
        if (i >= 0) this.pendingReject.splice(i, 1);
        fn();
      };
      let buffer = '';
      const cleanup = (): void => {
        clearTimeout(timer);
        this.stream.off('data', onData);
      };
      const timer = setTimeout(() => {
        cleanup();
        settle(() => reject(new DriverError('CLI command timed out waiting for prompt', { host: this.host, command })));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      const onData = (data: Buffer): void => {
        buffer += data.toString();
        if (this.pager.test(buffer)) {
          buffer = buffer.replace(this.pager, '');
          this.stream.write(' ');
          return;
        }
        if (this.prompt.test(buffer)) {
          cleanup();
          const output = SshShellSession.stripEchoAndPrompt(buffer, command, this.prompt);
          settle(() => resolve(output));
        }
      };
      this.stream.on('data', onData);
      this.stream.write(`${command}\n`);
    });
  }

  private static stripEchoAndPrompt(buffer: string, command: string, prompt: RegExp): string {
    const lines = buffer.replace(/\r/g, '').split('\n');
    let start = 0;
    if (lines[0] !== undefined && lines[0].trim() === command.trim()) start = 1;
    let end = lines.length;
    while (end > start && prompt.test(lines[end - 1])) end -= 1;
    return lines.slice(start, end).join('\n').trim();
  }

  async close(): Promise<void> {
    try {
      this.stream.close();
    } catch {
      /* best effort */
    }
  }
}

export interface TelnetSessionOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  prompt: RegExp;
  loginPrompt?: RegExp | string;
  passwordPrompt?: RegExp | string;
  /** Command sent right after login to disable output paging. */
  disablePagingCommand?: string;
  /** Called when the underlying connection closes. */
  onClose?: () => void;
}

/**
 * Telnet CLI session via `telnet-client`.
 * Used for vendors that are managed over Telnet in the field
 * (Fiberhome AN5516, HSGQ EPON/GPON). The connection is persistent and
 * stateful, so config-mode navigation works the same as over SSH.
 */
export class TelnetCliSession implements CliSession {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly conn: Telnet,
    private readonly prompt: RegExp,
    private readonly host: string,
  ) {}

  static async open(opts: TelnetSessionOptions): Promise<TelnetCliSession> {
    const conn = new Telnet();
    try {
      await conn.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        shellPrompt: opts.prompt,
        loginPrompt: opts.loginPrompt ?? /[Uu]sername:/,
        passwordPrompt: opts.passwordPrompt ?? /[Pp]assword:/,
        failedLoginMatch: /Login incorrect|Authentication failed|login failed/i,
        timeout: 15000,
        execTimeout: 60000,
        negotiationMandatory: false,
      } as Record<string, unknown> as Parameters<Telnet['connect']>[0]);
    } catch (err) {
      throw new DriverError('Telnet connection/login failed', {
        host: opts.host,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    const session = new TelnetCliSession(conn, opts.prompt, opts.host);
    if (opts.onClose) {
      conn.on('close', () => opts.onClose?.());
    }
    if (opts.disablePagingCommand) {
      try {
        await session.exec(opts.disablePagingCommand, 15000);
      } catch {
        /* paging disable is best-effort */
      }
    }
    return session;
  }

  exec(command: string, timeoutMs = 60000): Promise<string> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.execOnce(command, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execOnce(command: string, timeoutMs: number): Promise<string> {
    try {
      const res = await this.conn.exec(command, { shellPrompt: this.prompt, timeout: timeoutMs });
      const text = typeof res === 'string' ? res : String(res);
      // telnet-client echoes the command; strip the first line when it matches.
      const lines = text.replace(/\r/g, '').split('\n');
      if (lines[0] !== undefined && lines[0].trim() === command.trim()) lines.shift();
      // Strip trailing prompt line.
      while (lines.length > 0 && this.prompt.test(lines[lines.length - 1])) lines.pop();
      return lines.join('\n').trim();
    } catch (err) {
      throw new DriverError('Telnet command failed', {
        host: this.host,
        command,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async close(): Promise<void> {
    try {
      await this.conn.end();
    } catch {
      /* best effort */
    }
  }
}
