import crypto from 'node:crypto';
import { ensureEncryptionKey } from './session.service.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'enc:v1:';

async function getKey(): Promise<Buffer> {
  const hex = await ensureEncryptionKey();
  const buf = Buffer.from(hex, 'hex');

  if (buf.length < 32) {
    throw new Error('ENCRYPTION_KEY inválida: se requieren al menos 32 bytes en hex');
  }

  return buf.subarray(0, 32);
}

export async function encryptString(plain: string): Promise<string> {
  if (!plain) return '';

  const key = await getKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, tag, encrypted]).toString('base64');

  return PREFIX + payload;
}

export async function decryptString(value: string): Promise<string> {
  if (!value) return '';

  if (!value.startsWith(PREFIX)) {
    return value;
  }

  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');

  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Valor cifrado inválido');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}