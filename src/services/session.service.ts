import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { getConfigValue, getNumberConfig } from './config.service.js';

const BCRYPT_ROUNDS = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export type PublicUser = {
  id: string;
  username: string;
  email: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

export type PublicSession = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

export function toPublicUser(user: {
  id: string;
  username: string;
  email: string | null;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

export async function ensureSessionSecret(): Promise<string> {
  const current = await getConfigValue('SESSION_SECRET');

  if (current && current.length >= 32) {
    return current;
  }

  const generated = crypto.randomBytes(48).toString('hex');

  await prisma.config.upsert({
    where: { key: 'SESSION_SECRET' },
    update: { value: generated },
    create: { key: 'SESSION_SECRET', value: generated },
  });

  logger.info('SESSION_SECRET generado automáticamente');

  return generated;
}

export async function ensureEncryptionKey(): Promise<string> {
  const current = await getConfigValue('ENCRYPTION_KEY');

  if (current && current.length >= 32) {
    return current;
  }

  const generated = crypto.randomBytes(32).toString('hex');

  await prisma.config.upsert({
    where: { key: 'ENCRYPTION_KEY' },
    update: { value: generated },
    create: { key: 'ENCRYPTION_KEY', value: generated },
  });

  logger.info('ENCRYPTION_KEY generada automáticamente');

  return generated;
}

export async function hasAnyUser(): Promise<boolean> {
  const count = await prisma.user.count();
  return count > 0;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export type SetupResult =
  | { ok: true; user: PublicUser }
  | { ok: false; code: 'ALREADY_INITIALIZED'; message: string }
  | { ok: false; code: 'INVALID_INPUT'; message: string };

export async function createInitialAdmin(
  username: string,
  password: string,
  email?: string
): Promise<SetupResult> {
  const alreadyExists = await hasAnyUser();

  if (alreadyExists) {
    return {
      ok: false,
      code: 'ALREADY_INITIALIZED',
      message: 'Ya existe un usuario administrador. El setup inicial está cerrado.',
    };
  }

  const cleanUsername = username.trim();
  const cleanEmail = email?.trim() || undefined;

  if (cleanUsername.length < 3) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'El nombre de usuario debe tener al menos 3 caracteres',
    };
  }

  if (password.length < 8) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'La contraseña debe tener al menos 8 caracteres',
    };
  }

  const passwordHash = await hashPassword(password);

  const created = await prisma.user.create({
    data: {
      username: cleanUsername,
      email: cleanEmail || null,
      passwordHash,
      active: true,
    },
  });

  logger.info(
    { userId: created.id, username: created.username },
    'Admin inicial creado'
  );

  return {
    ok: true,
    user: toPublicUser(created),
  };
}

export type LoginResult =
  | {
      ok: true;
      user: PublicUser;
      sessionId: string;
      expiresAt: Date;
    }
  | {
      ok: false;
      code: 'INVALID_CREDENTIALS' | 'USER_INACTIVE' | 'LOCKED' | 'NO_USERS';
      message: string;
      lockedUntil?: Date;
    };

export async function loginWithPassword(
  username: string,
  password: string,
  meta: { ipAddress?: string | null; userAgent?: string | null }
): Promise<LoginResult> {
  const existsAny = await hasAnyUser();

  if (!existsAny) {
    return {
      ok: false,
      code: 'NO_USERS',
      message: 'Setup inicial requerido',
    };
  }

  const user = await prisma.user.findUnique({
    where: { username: username.trim() },
  });

  if (!user) {
    return {
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Usuario o contraseña incorrectos',
    };
  }

  if (!user.active) {
    return {
      ok: false,
      code: 'USER_INACTIVE',
      message: 'El usuario está inactivo',
    };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return {
      ok: false,
      code: 'LOCKED',
      message: 'Cuenta bloqueada por intentos fallidos',
      lockedUntil: user.lockedUntil,
    };
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const newAttempts = user.failedLoginAttempts + 1;
    const shouldLock = newAttempts >= MAX_FAILED_ATTEMPTS;
    const lockUntil = shouldLock
      ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
      : null;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: newAttempts,
        lockedUntil: lockUntil,
      },
    });

    if (shouldLock) {
      logger.warn(
        { userId: user.id, attempts: newAttempts },
        'Usuario bloqueado por intentos fallidos'
      );

      return {
        ok: false,
        code: 'LOCKED',
        message: 'Cuenta bloqueada por demasiados intentos fallidos',
        lockedUntil: lockUntil!,
      };
    }

    return {
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Usuario o contraseña incorrectos',
    };
  }

  const ttlHours = (await getNumberConfig('SESSION_TTL_HOURS')) || 12;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      ipAddress: meta.ipAddress || null,
      userAgent: meta.userAgent || null,
      expiresAt,
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  const refreshedUser = await prisma.user.findUnique({ where: { id: user.id } });

  return {
    ok: true,
    user: toPublicUser(refreshedUser!),
    sessionId: session.id,
    expiresAt,
  };
}

export async function getSessionById(
  sessionId: string
): Promise<{ user: PublicUser; sessionId: string } | null> {
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt <= new Date()) return null;
  if (!session.user.active) return null;

  await prisma.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  return {
    user: toPublicUser(session.user),
    sessionId: session.id,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listUserSessions(
  userId: string,
  currentSessionId: string
): Promise<PublicSession[]> {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastSeenAt: 'desc' },
  });

  return sessions.map((s) => ({
    id: s.id,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    current: s.id === currentSessionId,
  }));
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (newPassword.length < 8) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'La nueva contraseña debe tener al menos 8 caracteres',
    };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Usuario no encontrado',
    };
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);

  if (!valid) {
    return {
      ok: false,
      code: 'INVALID_CREDENTIALS',
      message: 'La contraseña actual es incorrecta',
    };
  }

  const newHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });

  logger.info({ userId }, 'Contraseña cambiada');

  return { ok: true };
}