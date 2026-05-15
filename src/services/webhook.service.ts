import { fetch } from 'undici';
import { prisma } from '../db/prisma.js';
import { getConfigValue, getNumberConfig } from './config.service.js';
import { logger } from '../utils/logger.js';

export type WebhookResponse = {
  ok?: boolean;
  shouldSend?: boolean;
  message?: string;
  outbox_id?: number | false;
  odoo_message_id?: number | false;
  [key: string]: any;
};

export async function postToInboundWebhook(payload: any): Promise<WebhookResponse> {
  const url = await getConfigValue('INBOUND_WEBHOOK_URL');
  const timeoutMs = (await getNumberConfig('WEBHOOK_TIMEOUT_MS')) || 30000;
  if (!url) throw new Error('INBOUND_WEBHOOK_URL no configurado en PostgreSQL');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await prisma.eventLog.create({
      data: {
        type: 'webhook.request',
        status: 'pending',
        phone: payload.phone || null,
        jid: payload.jid || null,
        lid: payload.lid || null,
        rawJid: payload.raw_jid || null,
        payload,
      },
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);

    await prisma.eventLog.create({
      data: {
        type: 'webhook.response',
        status: 'success',
        phone: payload.phone || null,
        jid: payload.jid || null,
        lid: payload.lid || null,
        rawJid: payload.raw_jid || null,
        payload,
        response: data,
      },
    });

    return data as WebhookResponse;
  } catch (error: any) {
    logger.error({ err: error }, 'Error enviando webhook');
    await prisma.eventLog.create({
      data: {
        type: 'webhook.error',
        status: 'error',
        phone: payload.phone || null,
        jid: payload.jid || null,
        lid: payload.lid || null,
        rawJid: payload.raw_jid || null,
        payload,
        error: error?.message || String(error),
      },
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
