import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV, standar untuk GCM

/**
 * Enkripsi AES-256-GCM untuk kredensial tersimpan (password router/OLT,
 * API key, dll). Kunci diambil dari env CREDENTIALS_KEY.
 *
 * Format keluaran:  iv_hex : authTag_hex : cipher_hex
 * IV dibuat acak setiap pemanggilan sehingga ciphertext tidak deterministik.
 */
export function encrypt(plainText: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Dekripsi keluaran encrypt(). Melempar Error bila format/tag tidak valid. */
export function decrypt(payload: string): string {
  const key = resolveKey();
  const parts = payload.split(':');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error('Format data terenkripsi tidak valid');
  }
  const [ivHex, tagHex, dataHex] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function resolveKey(): Buffer {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) {
    throw new Error('CREDENTIALS_KEY belum dikonfigurasi di environment');
  }
  // Terima 64 karakter hex ATAU 32 karakter biasa (utf8).
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8');
  if (key.length !== 32) {
    throw new Error('CREDENTIALS_KEY harus tepat 32 byte (64 hex atau 32 karakter)');
  }
  return key;
}
