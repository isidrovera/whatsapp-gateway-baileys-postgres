import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extension, lookup } from 'mime-types';
import { fetch } from 'undici';
import { getBooleanConfig, getConfigValue } from './config.service.js';

export async function getMediaDir() {
  const dir = await getConfigValue('MEDIA_DIR');
  const resolved = path.resolve(dir || './storage/media');
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

function guessExt(mimetype?: string, filename?: string) {
  if (filename && filename.includes('.')) return filename.split('.').pop() || 'bin';
  const ext = mimetype ? extension(mimetype) : false;
  return ext ? String(ext) : 'bin';
}

export async function saveIncomingMedia(buffer: Buffer, mimetype?: string, filename?: string) {
  const dir = await getMediaDir();
  const ext = guessExt(mimetype, filename);
  const stored = `${Date.now()}-${randomUUID()}.${ext}`;
  const filePath = path.join(dir, stored);
  await fs.writeFile(filePath, buffer);

  const publicBase = await getConfigValue('PUBLIC_BASE_URL');
  const url = publicBase ? `${publicBase.replace(/\/$/, '')}/public/media/${stored}` : `/public/media/${stored}`;

  return {
    filename: filename || stored,
    stored_filename: stored,
    path: filePath,
    url,
    mimetype: mimetype || lookup(filePath) || 'application/octet-stream',
  };
}

export async function maybeBase64(buffer: Buffer) {
  return (await getBooleanConfig('WEBHOOK_INCLUDE_MEDIA_BASE64')) ? buffer.toString('base64') : '';
}

export async function getBufferFromUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar media: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), mimetype: res.headers.get('content-type') || 'application/octet-stream' };
}

export function getBufferFromBase64(base64: string) {
  const cleaned = base64.includes(',') ? base64.split(',').pop() || '' : base64;
  return Buffer.from(cleaned, 'base64');
}
