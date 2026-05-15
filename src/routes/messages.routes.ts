import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { whatsapp } from '../services/baileys.service.js';

const SendTextSchema = z.object({
  to: z.string().min(5),
  message: z.string().min(1),
});

const SendMediaSchema = z.object({
  to: z.string().min(5),
  media_type: z.enum(['image', 'audio', 'video', 'document']),
  url: z.string().url().optional(),
  base64: z.string().optional(),
  mimetype: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
}).refine((data) => data.url || data.base64, {
  message: 'Debe enviar url o base64',
  path: ['url'],
});

export async function registerMessageRoutes(app: FastifyInstance) {
  app.post('/api/messages/send', { preHandler: requireApiKey }, async (request, reply) => {
    const parsed = SendTextSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'INVALID_BODY', errors: parsed.error.flatten() });
    const resp = await whatsapp.sendText(parsed.data.to, parsed.data.message);
    return { ok: true, external_message_id: resp?.key?.id || false, raw: resp };
  });

  app.post('/api/messages/send-media', { preHandler: requireApiKey }, async (request, reply) => {
    const parsed = SendMediaSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'INVALID_BODY', errors: parsed.error.flatten() });
    const resp = await whatsapp.sendMedia(parsed.data);
    return { ok: true, external_message_id: resp?.key?.id || false, raw: resp };
  });
}
