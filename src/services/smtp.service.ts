import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { encryptString, decryptString, isEncrypted } from './crypto.service.js';

export type PublicSmtpConfig = {
  id: number;
  active: boolean;
  host: string;
  port: number;
  secure: boolean;
  authMethod: string;
  username: string | null;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string;
};

export type SmtpConfigInput = {
  active?: boolean;
  host: string;
  port: number;
  secure?: boolean;
  authMethod?: string;
  username?: string | null;
  password?: string | null;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
};

function toPublic(row: {
  id: number;
  active: boolean;
  host: string;
  port: number;
  secure: boolean;
  authMethod: string;
  username: string | null;
  passwordEncrypted: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
}): PublicSmtpConfig {
  return {
    id: row.id,
    active: row.active,
    host: row.host,
    port: row.port,
    secure: row.secure,
    authMethod: row.authMethod,
    username: row.username,
    hasPassword: !!row.passwordEncrypted,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSmtpConfig(): Promise<PublicSmtpConfig | null> {
  const row = await prisma.smtpConfig.findFirst({
    where: { singleton: true },
  });

  if (!row) return null;

  return toPublic(row);
}

export async function getSmtpConfigInternal() {
  return prisma.smtpConfig.findFirst({
    where: { singleton: true },
  });
}

export async function getSmtpPassword(): Promise<string | null> {
  const row = await getSmtpConfigInternal();

  if (!row || !row.passwordEncrypted) return null;

  try {
    return await decryptString(row.passwordEncrypted);
  } catch (err) {
    logger.error({ err }, 'Error descifrando password SMTP');
    return null;
  }
}

export async function upsertSmtpConfig(input: SmtpConfigInput): Promise<PublicSmtpConfig> {
  const existing = await getSmtpConfigInternal();

  let encryptedPassword: string | null | undefined;

  if (input.password === '' || input.password === null) {
    encryptedPassword = null;
  } else if (typeof input.password === 'string' && input.password.length > 0) {
    encryptedPassword = await encryptString(input.password);
  } else {
    encryptedPassword = undefined;
  }

  const data = {
    active: input.active ?? existing?.active ?? false,
    host: input.host,
    port: input.port,
    secure: input.secure ?? false,
    authMethod: input.authMethod || 'PASSWORD',
    username: input.username ?? null,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    replyTo: input.replyTo ?? null,
  };

  let row;

  if (existing) {
    row = await prisma.smtpConfig.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(encryptedPassword !== undefined ? { passwordEncrypted: encryptedPassword } : {}),
      },
    });
  } else {
    row = await prisma.smtpConfig.create({
      data: {
        singleton: true,
        ...data,
        passwordEncrypted: encryptedPassword ?? null,
      },
    });
  }

  logger.info({ id: row.id, host: row.host }, 'Config SMTP guardada');

  return toPublic(row);
}

export async function updateSmtpTestResult(
  ok: boolean,
  errorMessage?: string
): Promise<void> {
  const existing = await getSmtpConfigInternal();

  if (!existing) return;

  await prisma.smtpConfig.update({
    where: { id: existing.id },
    data: {
      lastTestAt: new Date(),
      lastTestOk: ok,
      lastTestError: ok ? null : errorMessage || 'Error desconocido',
    },
  });
}

export async function isSmtpActiveAndReady(): Promise<boolean> {
  const row = await getSmtpConfigInternal();

  if (!row) return false;
  if (!row.active) return false;
  if (!row.host || !row.fromEmail) return false;

  if (row.authMethod === 'PASSWORD' && row.username && !row.passwordEncrypted) {
    return false;
  }

  return true;
}

export function ensureEncryptedFieldVisible(row: { passwordEncrypted: string | null }): boolean {
  return !!row.passwordEncrypted && isEncrypted(row.passwordEncrypted);
}