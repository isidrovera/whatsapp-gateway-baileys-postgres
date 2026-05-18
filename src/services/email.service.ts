import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import {
  getSmtpConfigInternal,
  getSmtpPassword,
  isSmtpActiveAndReady,
  updateSmtpTestResult,
} from './smtp.service.js';

export type SendEmailInput = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  templateCode?: string;
  variables?: Record<string, string>;
};

export type SendEmailResult =
  | { ok: true; messageId: string | null; logId: number }
  | { ok: false; code: string; message: string; logId?: number };

let cachedTransporter: Transporter | null = null;
let cachedTransporterKey: string = '';

async function buildTransporter(): Promise<Transporter | null> {
  const row = await getSmtpConfigInternal();

  if (!row) return null;
  if (!row.host || !row.fromEmail) return null;

  const password =
    row.authMethod === 'PASSWORD' && row.username
      ? await getSmtpPassword()
      : null;

  const key = JSON.stringify({
    host: row.host,
    port: row.port,
    secure: row.secure,
    user: row.username || '',
    hasPassword: !!password,
    auth: row.authMethod,
  });

  if (cachedTransporter && cachedTransporterKey === key) {
    return cachedTransporter;
  }

  const transportOpts: Record<string, unknown> = {
    host: row.host,
    port: row.port,
    secure: row.secure,
  };

  if (row.authMethod === 'PASSWORD' && row.username && password) {
    transportOpts.auth = {
      user: row.username,
      pass: password,
    };
  }

  const transporter = nodemailer.createTransport(transportOpts);

  cachedTransporter = transporter;
  cachedTransporterKey = key;

  return transporter;
}

export function invalidateTransporterCache(): void {
  cachedTransporter = null;
  cachedTransporterKey = '';
}

export function renderTemplate(
  template: string,
  variables: Record<string, string> = {}
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = variables[key];
    return value !== undefined ? String(value) : match;
  });
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const ready = await isSmtpActiveAndReady();

  if (!ready) {
    const log = await prisma.emailLog.create({
      data: {
        toAddress: input.to,
        ccAddress: input.cc || null,
        bccAddress: input.bcc || null,
        subject: input.subject,
        bodyHtml: input.bodyHtml || null,
        bodyText: input.bodyText || null,
        templateCode: input.templateCode || null,
        variables: input.variables || undefined,
        status: 'FAILED',
        attempts: 0,
        lastError: 'SMTP no configurado o inactivo',
      },
    });

    return {
      ok: false,
      code: 'SMTP_NOT_READY',
      message: 'SMTP no configurado o inactivo',
      logId: log.id,
    };
  }

  const smtpRow = await getSmtpConfigInternal();

  if (!smtpRow) {
    return {
      ok: false,
      code: 'SMTP_NOT_FOUND',
      message: 'No hay configuración SMTP',
    };
  }

  const log = await prisma.emailLog.create({
    data: {
      toAddress: input.to,
      ccAddress: input.cc || null,
      bccAddress: input.bcc || null,
      subject: input.subject,
      bodyHtml: input.bodyHtml || null,
      bodyText: input.bodyText || null,
      templateCode: input.templateCode || null,
      variables: input.variables || undefined,
      status: 'PENDING',
      attempts: 0,
    },
  });

  let transporter: Transporter | null;

  try {
    transporter = await buildTransporter();
  } catch (err: any) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attempts: 1,
        lastError: err?.message || 'Error construyendo transporter',
      },
    });

    return {
      ok: false,
      code: 'TRANSPORTER_ERROR',
      message: err?.message || 'Error construyendo transporter',
      logId: log.id,
    };
  }

  if (!transporter) {
    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attempts: 1,
        lastError: 'Transporter no disponible',
      },
    });

    return {
      ok: false,
      code: 'TRANSPORTER_UNAVAILABLE',
      message: 'Transporter no disponible',
      logId: log.id,
    };
  }

  const fromHeader = `"${smtpRow.fromName}" <${smtpRow.fromEmail}>`;

  try {
    const result = await transporter.sendMail({
      from: fromHeader,
      to: input.to,
      cc: input.cc || undefined,
      bcc: input.bcc || undefined,
      replyTo: smtpRow.replyTo || undefined,
      subject: input.subject,
      html: input.bodyHtml || undefined,
      text: input.bodyText || undefined,
    });

    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: 'SENT',
        attempts: 1,
        sentAt: new Date(),
      },
    });

    logger.info(
      { logId: log.id, to: input.to, messageId: result.messageId },
      'Email enviado'
    );

    return {
      ok: true,
      messageId: result.messageId || null,
      logId: log.id,
    };
  } catch (err: any) {
    const errorMessage = err?.message || 'Error enviando email';

    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        attempts: 1,
        lastError: errorMessage,
      },
    });

    logger.error({ logId: log.id, err }, 'Error enviando email');

    return {
      ok: false,
      code: 'SEND_ERROR',
      message: errorMessage,
      logId: log.id,
    };
  }
}

export async function sendTestEmail(
  to: string
): Promise<SendEmailResult> {
  invalidateTransporterCache();

  const result = await sendEmail({
    to,
    subject: 'Prueba SMTP · WhatsApp Gateway',
    bodyHtml:
      '<h2>Prueba SMTP exitosa</h2>' +
      '<p>Si recibes este correo, la configuración del servidor SMTP es correcta.</p>' +
      '<p style="color:#6b7280;font-size:12px;">Enviado desde WhatsApp Gateway · ' +
      new Date().toISOString() +
      '</p>',
    bodyText: 'Prueba SMTP exitosa. Si recibes este correo, la configuración del servidor SMTP es correcta.',
  });

  await updateSmtpTestResult(result.ok, result.ok ? undefined : result.message);

  return result;
}

export async function listEmailLogs(limit: number = 50) {
  const rows = await prisma.emailLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      toAddress: true,
      subject: true,
      templateCode: true,
      status: true,
      attempts: true,
      lastError: true,
      sentAt: true,
      createdAt: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    to: r.toAddress,
    subject: r.subject,
    templateCode: r.templateCode,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}