import { fetch } from 'undici';
import { getBooleanConfig, getConfigValue } from './config.service.js';
import { logger } from '../utils/logger.js';

export async function markOdooOutboxSent(outboxId: number, externalMessageId?: string | null) {
  if (!(await getBooleanConfig('ODOO_MARK_SENT_ENABLED'))) return;

  const base = await getConfigValue('ODOO_BASE_URL');
  const token = await getConfigValue('ODOO_WHATSAPP_TOKEN');
  if (!base || !token) return;

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/sat/whatsapp/outbox/mark-sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ outbox_id: outboxId, external_message_id: externalMessageId || '' }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}: ${text}`);
    logger.info({ outboxId, externalMessageId }, '[ODOO] outbox marcado enviado');
  } catch (err) {
    logger.error({ err, outboxId, externalMessageId }, '[ODOO] error marcando outbox');
  }
}
