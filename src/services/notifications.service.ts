import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { renderTemplate, sendEmail } from './email.service.js';
import { getTemplateByCode } from './templates.service.js';

export type PublicNotificationRule = {
  id: string;
  eventType: string;
  name: string;
  description: string | null;
  active: boolean;
  templateCode: string;
  throttleMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  recipients: PublicNotificationRecipient[];
};

export type PublicNotificationRecipient = {
  id: string;
  ruleId: string;
  email: string;
  active: boolean;
  createdAt: string;
};

export type RuleInput = {
  eventType: string;
  name: string;
  description?: string | null;
  templateCode: string;
  active?: boolean;
  throttleMinutes?: number;
};

export type RuleUpdateInput = {
  name?: string;
  description?: string | null;
  templateCode?: string;
  active?: boolean;
  throttleMinutes?: number;
};

function toPublicRecipient(r: {
  id: string;
  ruleId: string;
  email: string;
  active: boolean;
  createdAt: Date;
}): PublicNotificationRecipient {
  return {
    id: r.id,
    ruleId: r.ruleId,
    email: r.email,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
  };
}

function toPublicRule(row: {
  id: string;
  eventType: string;
  name: string;
  description: string | null;
  active: boolean;
  templateCode: string;
  throttleMinutes: number;
  lastTriggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  recipients: Array<{
    id: string;
    ruleId: string;
    email: string;
    active: boolean;
    createdAt: Date;
  }>;
}): PublicNotificationRule {
  return {
    id: row.id,
    eventType: row.eventType,
    name: row.name,
    description: row.description,
    active: row.active,
    templateCode: row.templateCode,
    throttleMinutes: row.throttleMinutes,
    lastTriggeredAt: row.lastTriggeredAt ? row.lastTriggeredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    recipients: row.recipients.map(toPublicRecipient),
  };
}

export async function listRules(): Promise<PublicNotificationRule[]> {
  const rows = await prisma.notificationRule.findMany({
    orderBy: { eventType: 'asc' },
    include: { recipients: { orderBy: { email: 'asc' } } },
  });

  return rows.map(toPublicRule);
}

export async function getRuleById(id: string): Promise<PublicNotificationRule | null> {
  const row = await prisma.notificationRule.findUnique({
    where: { id },
    include: { recipients: { orderBy: { email: 'asc' } } },
  });

  return row ? toPublicRule(row) : null;
}

export async function getRuleByEventType(
  eventType: string
): Promise<PublicNotificationRule | null> {
  const row = await prisma.notificationRule.findUnique({
    where: { eventType },
    include: { recipients: { orderBy: { email: 'asc' } } },
  });

  return row ? toPublicRule(row) : null;
}

export async function createRule(input: RuleInput): Promise<PublicNotificationRule> {
  const row = await prisma.notificationRule.create({
    data: {
      eventType: input.eventType.trim(),
      name: input.name.trim(),
      description: input.description ?? null,
      templateCode: input.templateCode.trim(),
      active: input.active ?? true,
      throttleMinutes: input.throttleMinutes ?? 0,
    },
    include: { recipients: true },
  });

  return toPublicRule(row);
}

export async function updateRule(
  id: string,
  input: RuleUpdateInput
): Promise<PublicNotificationRule | null> {
  const existing = await prisma.notificationRule.findUnique({ where: { id } });

  if (!existing) return null;

  const updated = await prisma.notificationRule.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.templateCode !== undefined ? { templateCode: input.templateCode.trim() } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.throttleMinutes !== undefined ? { throttleMinutes: input.throttleMinutes } : {}),
    },
    include: { recipients: { orderBy: { email: 'asc' } } },
  });

  return toPublicRule(updated);
}

export async function deleteRule(id: string): Promise<boolean> {
  const existing = await prisma.notificationRule.findUnique({ where: { id } });

  if (!existing) return false;

  await prisma.notificationRule.delete({ where: { id } });

  return true;
}

export async function addRecipient(
  ruleId: string,
  email: string
): Promise<PublicNotificationRecipient | null> {
  const rule = await prisma.notificationRule.findUnique({ where: { id: ruleId } });

  if (!rule) return null;

  const cleanEmail = email.trim().toLowerCase();

  const created = await prisma.notificationRecipient.upsert({
    where: { ruleId_email: { ruleId, email: cleanEmail } },
    update: { active: true },
    create: {
      ruleId,
      email: cleanEmail,
      active: true,
    },
  });

  return toPublicRecipient(created);
}

export async function removeRecipient(id: string): Promise<boolean> {
  const existing = await prisma.notificationRecipient.findUnique({ where: { id } });

  if (!existing) return false;

  await prisma.notificationRecipient.delete({ where: { id } });

  return true;
}

export async function toggleRecipient(
  id: string,
  active: boolean
): Promise<PublicNotificationRecipient | null> {
  const existing = await prisma.notificationRecipient.findUnique({ where: { id } });

  if (!existing) return null;

  const updated = await prisma.notificationRecipient.update({
    where: { id },
    data: { active },
  });

  return toPublicRecipient(updated);
}

export async function triggerEvent(
  eventType: string,
  variables: Record<string, string> = {}
): Promise<{ ok: boolean; code: string; message: string; sentTo?: string[] }> {
  const rule = await prisma.notificationRule.findUnique({
    where: { eventType },
    include: { recipients: true },
  });

  if (!rule) {
    return {
      ok: false,
      code: 'NO_RULE',
      message: `No hay regla para eventType=${eventType}`,
    };
  }

  if (!rule.active) {
    return {
      ok: false,
      code: 'RULE_INACTIVE',
      message: 'La regla está inactiva',
    };
  }

  if (rule.throttleMinutes > 0 && rule.lastTriggeredAt) {
    const elapsedMs = Date.now() - rule.lastTriggeredAt.getTime();
    const throttleMs = rule.throttleMinutes * 60 * 1000;

    if (elapsedMs < throttleMs) {
      return {
        ok: false,
        code: 'THROTTLED',
        message: `Throttled: faltan ${Math.ceil((throttleMs - elapsedMs) / 1000)}s`,
      };
    }
  }

  const template = await getTemplateByCode(rule.templateCode);

  if (!template) {
    return {
      ok: false,
      code: 'TEMPLATE_NOT_FOUND',
      message: `No existe la plantilla ${rule.templateCode}`,
    };
  }

  if (!template.active) {
    return {
      ok: false,
      code: 'TEMPLATE_INACTIVE',
      message: 'La plantilla está inactiva',
    };
  }

  const activeRecipients = rule.recipients.filter((r) => r.active);

  if (activeRecipients.length === 0) {
    return {
      ok: false,
      code: 'NO_RECIPIENTS',
      message: 'No hay destinatarios activos',
    };
  }

  const subject = renderTemplate(template.subject, variables);
  const bodyHtml = renderTemplate(template.bodyHtml, variables);
  const bodyText = template.bodyText
    ? renderTemplate(template.bodyText, variables)
    : undefined;

  const sentTo: string[] = [];

  for (const recipient of activeRecipients) {
    const result = await sendEmail({
      to: recipient.email,
      subject,
      bodyHtml,
      bodyText,
      templateCode: template.code,
      variables,
    });

    if (result.ok) {
      sentTo.push(recipient.email);
    } else {
      logger.warn(
        { recipient: recipient.email, eventType, code: result.code, message: result.message },
        'Fallo enviando notificación a destinatario'
      );
    }
  }

  await prisma.notificationRule.update({
    where: { id: rule.id },
    data: { lastTriggeredAt: new Date() },
  });

  return {
    ok: true,
    code: 'SENT',
    message: `Notificación enviada a ${sentTo.length} destinatarios`,
    sentTo,
  };
}