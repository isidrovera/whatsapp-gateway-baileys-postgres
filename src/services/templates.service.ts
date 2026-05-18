import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

export type PublicEmailTemplate = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variables: Record<string, string> | null;
  active: boolean;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TemplateUpdateInput = {
  name?: string;
  description?: string | null;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string | null;
  active?: boolean;
};

function toPublic(row: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variables: unknown;
  active: boolean;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PublicEmailTemplate {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    variables: (row.variables as Record<string, string> | null) || null,
    active: row.active,
    isSystem: row.isSystem,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SEED_TEMPLATES: Array<{
  code: string;
  name: string;
  description: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variables: Record<string, string>;
}> = [
  {
    code: 'PASSWORD_RESET',
    name: 'Recuperación de contraseña',
    description: 'Email enviado cuando el usuario solicita recuperar su contraseña.',
    subject: 'Recuperar contraseña · WhatsApp Gateway',
    bodyHtml:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">' +
      '<h2 style="color:#111827;">Recuperar contraseña</h2>' +
      '<p>Hola {{username}},</p>' +
      '<p>Recibimos una solicitud para restablecer la contraseña de tu cuenta.</p>' +
      '<p>Haz clic en el siguiente enlace para crear una nueva contraseña. El enlace expira en {{expiresInMinutes}} minutos.</p>' +
      '<p style="text-align:center;margin:24px 0;">' +
      '<a href="{{resetUrl}}" style="background:#2563eb;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;">Restablecer contraseña</a>' +
      '</p>' +
      '<p style="color:#6b7280;font-size:13px;">Si no solicitaste este cambio, ignora este correo.</p>' +
      '<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">' +
      '<p style="color:#9ca3af;font-size:12px;">WhatsApp Gateway</p>' +
      '</div>',
    bodyText:
      'Hola {{username}},\n\n' +
      'Recibimos una solicitud para restablecer tu contraseña.\n\n' +
      'Abre este enlace para crear una nueva contraseña (expira en {{expiresInMinutes}} minutos):\n' +
      '{{resetUrl}}\n\n' +
      'Si no solicitaste este cambio, ignora este correo.',
    variables: {
      username: 'Nombre de usuario',
      resetUrl: 'URL completa para resetear la contraseña',
      expiresInMinutes: 'Minutos hasta que expire el enlace',
    },
  },
  {
    code: 'WHATSAPP_DISCONNECTED',
    name: 'WhatsApp desconectado',
    description: 'Notificación cuando la sesión de WhatsApp se desconecta.',
    subject: '⚠️ WhatsApp desconectado · {{gatewayName}}',
    bodyHtml:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">' +
      '<h2 style="color:#dc2626;">WhatsApp desconectado</h2>' +
      '<p>La sesión de WhatsApp del gateway se ha desconectado.</p>' +
      '<p><b>Hora:</b> {{timestamp}}<br>' +
      '<b>Razón:</b> {{reason}}</p>' +
      '<p>Accede al panel para reconectar:</p>' +
      '<p><a href="{{panelUrl}}">{{panelUrl}}</a></p>' +
      '</div>',
    bodyText:
      'WhatsApp desconectado.\n\n' +
      'Hora: {{timestamp}}\n' +
      'Razón: {{reason}}\n\n' +
      'Accede al panel: {{panelUrl}}',
    variables: {
      gatewayName: 'Nombre del gateway',
      timestamp: 'Fecha y hora del evento',
      reason: 'Razón de la desconexión',
      panelUrl: 'URL del panel del gateway',
    },
  },
  {
    code: 'WHATSAPP_CONNECTED',
    name: 'WhatsApp conectado',
    description: 'Notificación cuando WhatsApp se conecta correctamente.',
    subject: '✅ WhatsApp conectado · {{gatewayName}}',
    bodyHtml:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">' +
      '<h2 style="color:#059669;">WhatsApp conectado</h2>' +
      '<p>La sesión de WhatsApp se ha establecido correctamente.</p>' +
      '<p><b>Hora:</b> {{timestamp}}</p>' +
      '</div>',
    bodyText: 'WhatsApp conectado correctamente.\nHora: {{timestamp}}',
    variables: {
      gatewayName: 'Nombre del gateway',
      timestamp: 'Fecha y hora del evento',
    },
  },
  {
    code: 'LOGIN_FAILED_LOCKED',
    name: 'Cuenta bloqueada por intentos fallidos',
    description: 'Notificación cuando una cuenta se bloquea por demasiados intentos.',
    subject: '🔒 Cuenta bloqueada · {{gatewayName}}',
    bodyHtml:
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">' +
      '<h2 style="color:#d97706;">Cuenta bloqueada</h2>' +
      '<p>La cuenta <b>{{username}}</b> fue bloqueada por demasiados intentos de inicio de sesión fallidos.</p>' +
      '<p><b>Hora:</b> {{timestamp}}<br>' +
      '<b>IP:</b> {{ipAddress}}<br>' +
      '<b>Bloqueada hasta:</b> {{lockedUntil}}</p>' +
      '</div>',
    bodyText:
      'Cuenta bloqueada por intentos fallidos.\n\n' +
      'Usuario: {{username}}\n' +
      'Hora: {{timestamp}}\n' +
      'IP: {{ipAddress}}\n' +
      'Bloqueada hasta: {{lockedUntil}}',
    variables: {
      gatewayName: 'Nombre del gateway',
      username: 'Usuario afectado',
      timestamp: 'Fecha y hora del evento',
      ipAddress: 'IP desde donde se intentó',
      lockedUntil: 'Hasta cuándo está bloqueada',
    },
  },
];

export async function seedSystemTemplates(): Promise<void> {
  for (const tmpl of SEED_TEMPLATES) {
    const existing = await prisma.emailTemplate.findUnique({
      where: { code: tmpl.code },
    });

    if (existing) continue;

    await prisma.emailTemplate.create({
      data: {
        code: tmpl.code,
        name: tmpl.name,
        description: tmpl.description,
        subject: tmpl.subject,
        bodyHtml: tmpl.bodyHtml,
        bodyText: tmpl.bodyText,
        variables: tmpl.variables,
        active: true,
        isSystem: true,
      },
    });

    logger.info({ code: tmpl.code }, 'Plantilla seed creada');
  }
}

export async function listTemplates(): Promise<PublicEmailTemplate[]> {
  const rows = await prisma.emailTemplate.findMany({
    orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
  });

  return rows.map(toPublic);
}

export async function getTemplateByCode(
  code: string
): Promise<PublicEmailTemplate | null> {
  const row = await prisma.emailTemplate.findUnique({ where: { code } });
  return row ? toPublic(row) : null;
}

export async function getTemplateById(id: string): Promise<PublicEmailTemplate | null> {
  const row = await prisma.emailTemplate.findUnique({ where: { id } });
  return row ? toPublic(row) : null;
}

export async function updateTemplate(
  id: string,
  input: TemplateUpdateInput
): Promise<PublicEmailTemplate | null> {
  const existing = await prisma.emailTemplate.findUnique({ where: { id } });

  if (!existing) return null;

  const updated = await prisma.emailTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodyHtml !== undefined ? { bodyHtml: input.bodyHtml } : {}),
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  return toPublic(updated);
}

export async function createCustomTemplate(input: {
  code: string;
  name: string;
  description?: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}): Promise<PublicEmailTemplate> {
  const created = await prisma.emailTemplate.create({
    data: {
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description || null,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText || null,
      active: true,
      isSystem: false,
    },
  });

  return toPublic(created);
}

export async function deleteTemplate(id: string): Promise<{ ok: boolean; reason?: string }> {
  const existing = await prisma.emailTemplate.findUnique({ where: { id } });

  if (!existing) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  if (existing.isSystem) {
    return { ok: false, reason: 'IS_SYSTEM' };
  }

  await prisma.emailTemplate.delete({ where: { id } });

  return { ok: true };
}