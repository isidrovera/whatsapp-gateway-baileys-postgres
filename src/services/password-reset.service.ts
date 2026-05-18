import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { hashPassword, revokeAllUserSessions } from './session.service.js';
import { getConfigValue } from './config.service.js';
import { triggerEvent } from './notifications.service.js';
import { sendEmail } from './email.service.js';
import { getTemplateByCode } from './templates.service.js';
import { renderTemplate } from './email.service.js';

const TOKEN_TTL_MINUTES = 60;

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function requestPasswordReset(
  identifier: string
): Promise<{ ok: true; message: string }> {
  const cleanIdentifier = identifier.trim().toLowerCase();
  const cleanIdentifierExact = identifier.trim();

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: cleanIdentifier },
        { username: cleanIdentifierExact },
      ],
      active: true,
    },
  });

  const genericResponse = {
    ok: true as const,
    message:
      'Si la cuenta existe y tiene email configurado, recibirás un enlace para restablecer la contraseña.',
  };

  if (!user) {
    logger.info({ identifier: cleanIdentifier }, 'Solicitud de reset para usuario inexistente');
    return genericResponse;
  }

  if (!user.email) {
    logger.info({ userId: user.id }, 'Usuario sin email configurado, no se envía reset');
    return genericResponse;
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  const publicBaseUrl = await getConfigValue('PUBLIC_BASE_URL');
  const baseUrl = publicBaseUrl || '';
  const resetUrl = `${baseUrl}/static/reset.html?token=${rawToken}`;

  const template = await getTemplateByCode('PASSWORD_RESET');

  if (!template || !template.active) {
    logger.error('Plantilla PASSWORD_RESET no existe o está inactiva');
    return genericResponse;
  }

  const variables = {
    username: user.username,
    resetUrl,
    expiresInMinutes: String(TOKEN_TTL_MINUTES),
  };

  const subject = renderTemplate(template.subject, variables);
  const bodyHtml = renderTemplate(template.bodyHtml, variables);
  const bodyText = template.bodyText
    ? renderTemplate(template.bodyText, variables)
    : undefined;

  const sendResult = await sendEmail({
    to: user.email,
    subject,
    bodyHtml,
    bodyText,
    templateCode: 'PASSWORD_RESET',
    variables,
  });

  if (!sendResult.ok) {
    logger.warn(
      { userId: user.id, code: sendResult.code, message: sendResult.message },
      'No se pudo enviar email de reset'
    );
  } else {
    logger.info({ userId: user.id, logId: sendResult.logId }, 'Email de reset enviado');
  }

  return genericResponse;
}

export async function validateResetToken(
  rawToken: string
): Promise<{
  valid: boolean;
  code?: string;
  message?: string;
  userId?: string;
  username?: string;
}> {
  if (!rawToken || rawToken.length < 16) {
    return {
      valid: false,
      code: 'INVALID_TOKEN',
      message: 'Token inválido',
    };
  }

  const tokenHash = hashToken(rawToken);

  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!token) {
    return {
      valid: false,
      code: 'INVALID_TOKEN',
      message: 'Token inválido o ya usado',
    };
  }

  if (token.usedAt) {
    return {
      valid: false,
      code: 'TOKEN_USED',
      message: 'Este enlace ya fue utilizado',
    };
  }

  if (token.expiresAt <= new Date()) {
    return {
      valid: false,
      code: 'TOKEN_EXPIRED',
      message: 'El enlace expiró. Solicita uno nuevo.',
    };
  }

  if (!token.user.active) {
    return {
      valid: false,
      code: 'USER_INACTIVE',
      message: 'La cuenta está inactiva',
    };
  }

  return {
    valid: true,
    userId: token.user.id,
    username: token.user.username,
  };
}

export async function consumeResetToken(
  rawToken: string,
  newPassword: string
): Promise
  | { ok: true; message: string }
  | { ok: false; code: string; message: string }
> {
  if (newPassword.length < 8) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'La nueva contraseña debe tener al menos 8 caracteres',
    };
  }

  const validation = await validateResetToken(rawToken);

  if (!validation.valid) {
    return {
      ok: false,
      code: validation.code || 'INVALID_TOKEN',
      message: validation.message || 'Token inválido',
    };
  }

  const tokenHash = hashToken(rawToken);
  const newHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { tokenHash },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: validation.userId! },
      data: {
        passwordHash: newHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
  ]);

  await revokeAllUserSessions(validation.userId!);

  logger.info({ userId: validation.userId }, 'Contraseña restablecida vía token');

  return {
    ok: true,
    message: 'Contraseña restablecida correctamente. Inicia sesión con tu nueva contraseña.',
  };
}

export async function cleanupExpiredResetTokens(): Promise<number> {
  const result = await prisma.passwordResetToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { usedAt: { not: null } },
      ],
    },
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, 'Tokens de reset expirados eliminados');
  }

  return result.count;
}