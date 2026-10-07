import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as net from 'net';

/* RADIUS packet codes (RFC 5176) */
const CODE_DISCONNECT_REQUEST = 40;
const CODE_DISCONNECT_ACK = 41;
const CODE_DISCONNECT_NAK = 42;

/* RADIUS attribute types (RFC 2865) */
const ATTR_USER_NAME = 1;
const ATTR_NAS_IP_ADDRESS = 4;

const COA_PORT = 3799;
const RESPONSE_TIMEOUT_MS = 3000;
const MAX_ATTEMPTS = 3; // initial try + 2 retries

export interface CoaResult {
  acked: boolean;
  attempts: number;
}

/**
 * RadiusCoAService — sends RADIUS Change-of-Authorization / Disconnect
 * messages (RFC 5176) directly over UDP.
 *
 * The Disconnect-Request packet is built byte-by-byte (no RADIUS client
 * library) so the service has zero extra native dependencies:
 *
 *   Code=40, Identifier=random, Length, RequestAuthenticator=16 random bytes
 *   Attributes: User-Name(1), NAS-IP-Address(4)
 *
 * The NAS answers with Disconnect-ACK(41) or Disconnect-NAK(42); the
 * ResponseAuthenticator is verified as
 *   MD5(Code + Identifier + Length + RequestAuth + Attributes + secret).
 */
@Injectable()
export class RadiusCoAService {
  private readonly logger = new Logger(RadiusCoAService.name);

  /**
   * Ask the NAS to drop the session for `username` immediately.
   * Retries up to 2x on timeout. Returns { acked } — true only when a
   * verified Disconnect-ACK arrives.
   */
  async sendDisconnectRequest(nasIp: string, secret: string, username: string): Promise<CoaResult> {
    if (!net.isIPv4(nasIp)) {
      throw new Error(`RadiusCoAService hanya mendukung NAS IPv4 (dapat: "${nasIp}")`);
    }
    if (!secret) throw new Error('RadiusCoAService membutuhkan shared secret NAS');
    if (!username) throw new Error('RadiusCoAService membutuhkan username');

    const identifier = crypto.randomBytes(1)[0];
    const requestAuth = crypto.randomBytes(16);
    const packet = this.buildDisconnectRequest(identifier, requestAuth, nasIp, username);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const acked = await this.sendOnce(nasIp, packet, identifier, requestAuth, secret);
        if (acked) {
          this.logger.log(`CoA Disconnect-ACK untuk ${username} @ ${nasIp} (attempt ${attempt})`);
          return { acked: true, attempts: attempt };
        }
        // NAK is a definitive answer: do not retry.
        this.logger.warn(`CoA Disconnect-NAK untuk ${username} @ ${nasIp}`);
        return { acked: false, attempts: attempt };
      } catch (err) {
        lastError = err;
        this.logger.warn(`CoA attempt ${attempt}/${MAX_ATTEMPTS} ke ${nasIp} gagal: ${this.msg(err)}`);
      }
    }
    this.logger.error(`CoA Disconnect-Request ke ${nasIp} timeout setelah ${MAX_ATTEMPTS} percobaan`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /* ---------------------------------------------------------------- */

  private buildDisconnectRequest(
    identifier: number,
    requestAuth: Buffer,
    nasIp: string,
    username: string,
  ): Buffer {
    const userNameAttr = this.encodeAttr(ATTR_USER_NAME, Buffer.from(username, 'utf8'));
    const nasIpBytes = Buffer.from(nasIp.split('.').map((o) => Number(o)));
    const nasIpAttr = this.encodeAttr(ATTR_NAS_IP_ADDRESS, nasIpBytes);
    const attributes = Buffer.concat([userNameAttr, nasIpAttr]);

    const length = 20 + attributes.length;
    const header = Buffer.alloc(20);
    header.writeUInt8(CODE_DISCONNECT_REQUEST, 0);
    header.writeUInt8(identifier, 1);
    header.writeUInt16BE(length, 2);
    requestAuth.copy(header, 4);
    return Buffer.concat([header, attributes]);
  }

  private encodeAttr(type: number, value: Buffer): Buffer {
    if (value.length > 253) throw new Error(`RADIUS attribute ${type} terlalu panjang (${value.length} byte)`);
    return Buffer.concat([Buffer.from([type, 2 + value.length]), value]);
  }

  private sendOnce(
    nasIp: string,
    packet: Buffer,
    identifier: number,
    requestAuth: Buffer,
    secret: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const done = (fn: () => void): void => {
        clearTimeout(timer);
        socket.close();
        fn();
      };
      const timer = setTimeout(() => {
        done(() => reject(new Error(`Timeout menunggu respons CoA dari ${nasIp}:${COA_PORT}`)));
      }, RESPONSE_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      socket.on('error', (err) => {
        done(() => reject(new Error(`UDP CoA error: ${err.message}`)));
      });

      socket.on('message', (msg) => {
        try {
          done(() => resolve(this.verifyResponse(msg, identifier, requestAuth, secret)));
        } catch (err) {
          done(() => reject(err));
        }
      });

      socket.send(packet, COA_PORT, nasIp, (err) => {
        if (err) done(() => reject(new Error(`Gagal mengirim CoA ke ${nasIp}: ${err.message}`)));
      });
    });
  }

  /**
   * Verify identifier + ResponseAuthenticator, then map the code to
   * ACK(true) / NAK(false). Throws on malformed or forged responses.
   */
  private verifyResponse(
    msg: Buffer,
    identifier: number,
    requestAuth: Buffer,
    secret: string,
  ): boolean {
    if (msg.length < 20) throw new Error('Respons CoA terlalu pendek');
    const code = msg.readUInt8(0);
    const respId = msg.readUInt8(1);
    if (respId !== identifier) throw new Error('Identifier respons CoA tidak cocok');

    const expected = crypto
      .createHash('md5')
      .update(Buffer.concat([msg.subarray(0, 4), requestAuth, msg.subarray(20), Buffer.from(secret, 'utf8')]))
      .digest();
    if (!crypto.timingSafeEqual(expected, msg.subarray(4, 20))) {
      throw new Error('ResponseAuthenticator CoA tidak valid (kemungkinan secret salah)');
    }

    if (code === CODE_DISCONNECT_ACK) return true;
    if (code === CODE_DISCONNECT_NAK) return false;
    throw new Error(`Kode respons CoA tak dikenal: ${code}`);
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
