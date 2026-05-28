import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';

export type ConfigKey =
  | 'PORT'
  | 'HOST'
  | 'PUBLIC_BASE_URL'
  | 'GATEWAY_API_KEY'
  | 'GATEWAY_API_KEYS'
  | 'AUTH_DIR'
  | 'MEDIA_DIR'
  | 'INBOUND_WEBHOOK_URL'
  | 'WEBHOOK_TIMEOUT_MS'
  | 'WHATSAPP_SEND_TIMEOUT_MS'
  | 'WEBHOOK_INCLUDE_MEDIA_BASE64'
  | 'ODOO_BASE_URL'
  | 'ODOO_WHATSAPP_TOKEN'
  | 'ODOO_MARK_SENT_ENABLED'
  | 'IGNORE_GROUPS'
  | 'REPORT_GROUPS_TO_WEBHOOK'
  | 'SESSION_SECRET'
  | 'SESSION_TTL_HOURS'
  | 'ENCRYPTION_KEY';

export type StoredApiKey = {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  active: boolean;
  createdAt: string;
  lastUsedAt?: string;
};

export type PublicApiKey = {
  id: string;
  name: string;
  prefix: string;
  active: boolean;
  createdAt: string;
  lastUsedAt?: string;
};

export const DEFAULT_CONFIG: Record<ConfigKey, string> = {
  PORT: '3105',
  HOST: '0.0.0.0',
  PUBLIC_BASE_URL: '',
  GATEWAY_API_KEY: 'change-me-gateway-api-key',
  GATEWAY_API_KEYS: '[]',
  AUTH_DIR: './storage/auth',
  MEDIA_DIR: './storage/media',
  INBOUND_WEBHOOK_URL: '',
  WEBHOOK_TIMEOUT_MS: '30000',
  WHATSAPP_SEND_TIMEOUT_MS: '30000',
  WEBHOOK_INCLUDE_MEDIA_BASE64: 'false',
  ODOO_BASE_URL: '',
  ODOO_WHATSAPP_TOKEN: '',
  ODOO_MARK_SENT_ENABLED: 'false',
  IGNORE_GROUPS: 'true',
  REPORT_GROUPS_TO_WEBHOOK: 'true',
  SESSION_SECRET: '',
  SESSION_TTL_HOURS: '12',
  ENCRYPTION_KEY: '',
};

export async function ensureDefaultConfig() {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    await prisma.config.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
  }

  await ensureLegacyApiKeyImported();
}

export async function getConfigValue(key: ConfigKey): Promise<string> {
  const row = await prisma.config.findUnique({ where: { key } });
  return row?.value ?? DEFAULT_CONFIG[key] ?? '';
}

export async function getBooleanConfig(key: ConfigKey): Promise<boolean> {
  const value = await getConfigValue(key);
  return ['true', '1', 'yes', 'y', 'si', 'sí'].includes(
    String(value).toLowerCase()
  );
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

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function generateRawApiKey(): string {
  return 'wg_' + crypto.randomBytes(32).toString('hex');
}

function normalizeApiKeys(value: unknown): StoredApiKey[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object')
    .map((item: any) => ({
      id: String(item.id || ''),
      name: String(item.name || 'API Key'),
      prefix: String(item.prefix || ''),
      keyHash: String(item.keyHash || ''),
      active: item.active !== false,
      createdAt: String(item.createdAt || new Date().toISOString()),
      lastUsedAt: item.lastUsedAt ? String(item.lastUsedAt) : undefined,
    }))
    .filter((item) => item.id && item.keyHash);
}

export async function getApiKeys(): Promise<StoredApiKey[]> {
  const raw = await getConfigValue('GATEWAY_API_KEYS');

  try {
    return normalizeApiKeys(JSON.parse(raw || '[]'));
  } catch {
    return [];
  }
}

export async function saveApiKeys(apiKeys: StoredApiKey[]) {
  await prisma.config.upsert({
    where: { key: 'GATEWAY_API_KEYS' },
    update: { value: JSON.stringify(apiKeys) },
    create: { key: 'GATEWAY_API_KEYS', value: JSON.stringify(apiKeys) },
  });

  return apiKeys;
}

export function toPublicApiKey(apiKey: StoredApiKey): PublicApiKey {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    active: apiKey.active,
    createdAt: apiKey.createdAt,
    lastUsedAt: apiKey.lastUsedAt,
  };
}

export async function listPublicApiKeys(): Promise<PublicApiKey[]> {
  const apiKeys = await getApiKeys();
  return apiKeys.map(toPublicApiKey);
}

export async function createApiKey(name?: string) {
  const rawApiKey = generateRawApiKey();
  const now = new Date().toISOString();

  const storedApiKey: StoredApiKey = {
    id: crypto.randomUUID(),
    name: name?.trim() || 'API Key',
    prefix: rawApiKey.slice(0, 12),
    keyHash: hashApiKey(rawApiKey),
    active: true,
    createdAt: now,
  };

  const apiKeys = await getApiKeys();
  apiKeys.push(storedApiKey);

  await saveApiKeys(apiKeys);

  return {
    apiKey: rawApiKey,
    item: toPublicApiKey(storedApiKey),
    items: apiKeys.map(toPublicApiKey),
  };
}

export async function updateApiKey(
  id: string,
  values: {
    name?: string;
    active?: boolean;
  }
) {
  const apiKeys = await getApiKeys();

  const index = apiKeys.findIndex((item) => item.id === id);

  if (index === -1) {
    return null;
  }

  if (typeof values.name === 'string' && values.name.trim()) {
    apiKeys[index].name = values.name.trim();
  }

  if (typeof values.active === 'boolean') {
    apiKeys[index].active = values.active;
  }

  await saveApiKeys(apiKeys);

  return toPublicApiKey(apiKeys[index]);
}

export async function deactivateApiKey(id: string) {
  return updateApiKey(id, { active: false });
}

export async function validateStoredApiKey(receivedApiKey: string) {
  if (!receivedApiKey) {
    return {
      valid: false,
      source: 'none' as const,
      id: null as string | null,
    };
  }

  const legacyApiKey = await getConfigValue('GATEWAY_API_KEY');

  if (legacyApiKey && receivedApiKey === legacyApiKey) {
    return {
      valid: true,
      source: 'legacy' as const,
      id: null as string | null,
    };
  }

  const receivedHash = hashApiKey(receivedApiKey);
  const apiKeys = await getApiKeys();

  const found = apiKeys.find(
    (item) => item.active && item.keyHash === receivedHash
  );

  if (!found) {
    return {
      valid: false,
      source: 'api_keys' as const,
      id: null as string | null,
    };
  }

  found.lastUsedAt = new Date().toISOString();
  await saveApiKeys(apiKeys);

  return {
    valid: true,
    source: 'api_keys' as const,
    id: found.id,
  };
}

async function ensureLegacyApiKeyImported() {
  const apiKeys = await getApiKeys();

  if (apiKeys.length > 0) {
    return;
  }

  const legacyApiKey = await getConfigValue('GATEWAY_API_KEY');

  if (!legacyApiKey) {
    return;
  }

  const now = new Date().toISOString();

  const imported: StoredApiKey = {
    id: crypto.randomUUID(),
    name: 'Clave legacy principal',
    prefix: legacyApiKey.slice(0, 12),
    keyHash: hashApiKey(legacyApiKey),
    active: true,
    createdAt: now,
  };

  await saveApiKeys([imported]);
}