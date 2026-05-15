import { prisma } from '../db/prisma.js';

export type ConfigKey =
  | 'PORT'
  | 'HOST'
  | 'PUBLIC_BASE_URL'
  | 'GATEWAY_API_KEY'
  | 'AUTH_DIR'
  | 'MEDIA_DIR'
  | 'INBOUND_WEBHOOK_URL'
  | 'WEBHOOK_TIMEOUT_MS'
  | 'WEBHOOK_INCLUDE_MEDIA_BASE64'
  | 'ODOO_BASE_URL'
  | 'ODOO_WHATSAPP_TOKEN'
  | 'ODOO_MARK_SENT_ENABLED'
  | 'IGNORE_GROUPS'
  | 'REPORT_GROUPS_TO_WEBHOOK';

export const DEFAULT_CONFIG: Record<ConfigKey, string> = {
  PORT: '3105',
  HOST: '0.0.0.0',
  PUBLIC_BASE_URL: '',
  GATEWAY_API_KEY: 'change-me-gateway-api-key',
  AUTH_DIR: './storage/auth',
  MEDIA_DIR: './storage/media',
  INBOUND_WEBHOOK_URL: '',
  WEBHOOK_TIMEOUT_MS: '30000',
  WEBHOOK_INCLUDE_MEDIA_BASE64: 'false',
  ODOO_BASE_URL: '',
  ODOO_WHATSAPP_TOKEN: '',
  ODOO_MARK_SENT_ENABLED: 'false',
  IGNORE_GROUPS: 'true',
  REPORT_GROUPS_TO_WEBHOOK: 'true',
};

export async function ensureDefaultConfig() {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    await prisma.config.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
  }
}

export async function getConfigValue(key: ConfigKey): Promise<string> {
  const row = await prisma.config.findUnique({ where: { key } });
  return row?.value ?? DEFAULT_CONFIG[key] ?? '';
}

export async function getBooleanConfig(key: ConfigKey): Promise<boolean> {
  const value = await getConfigValue(key);
  return ['true', '1', 'yes', 'y', 'si', 'sí'].includes(String(value).toLowerCase());
}

export async function getNumberConfig(key: ConfigKey): Promise<number> {
  const value = await getConfigValue(key);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getAllConfig() {
  await ensureDefaultConfig();
  const rows = await prisma.config.findMany({ orderBy: { key: 'asc' } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setConfig(values: Record<string, string | number | boolean>) {
  for (const [key, value] of Object.entries(values)) {
    await prisma.config.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value) },
    });
  }
  return getAllConfig();
}
