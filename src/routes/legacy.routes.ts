import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireApiKey } from '../middleware/auth.js';
import { whatsapp } from '../services/baileys.service.js';

const SendMessageSchema = z.object({
  to: z.string().min(5),
  message: z.string().min(1),
});

const SendMediaSchema = z
  .object({
    to: z.string().min(5),
    url: z.string().url().optional(),
    file_url: z.string().url().optional(),
    caption: z.string().optional(),
    message: z.string().optional(),
    media_type: z.enum(['image', 'audio', 'video', 'document']).optional(),
    mimetype: z.string().optional(),
    filename: z.string().optional(),
  })
  .refine((data) => data.url || data.file_url, {
    message: 'Debe enviar url o file_url',
    path: ['url'],
  });

function inferMediaType(
  url: string
): 'image' | 'audio' | 'video' | 'document' {
  const clean = url.toLowerCase().split('?')[0];

  if (
    clean.endsWith('.jpg') ||
    clean.endsWith('.jpeg') ||
    clean.endsWith('.png') ||
    clean.endsWith('.webp') ||
    clean.endsWith('.gif')
  ) {
    return 'image';
  }

  if (
    clean.endsWith('.mp4') ||
    clean.endsWith('.mov') ||
    clean.endsWith('.avi') ||
    clean.endsWith('.mkv')
  ) {
    return 'video';
  }

  if (
    clean.endsWith('.mp3') ||
    clean.endsWith('.ogg') ||
    clean.endsWith('.oga') ||
    clean.endsWith('.m4a') ||
    clean.endsWith('.wav')
  ) {
    return 'audio';
  }

  return 'document';
}

function inferFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();

    if (last) {
      return decodeURIComponent(last);
    }
  } catch {
    // ignore
  }

  return 'archivo';
}

export async function registerLegacyRoutes(app: FastifyInstance) {
  app.post(
    '/api/send-message',
    { preHandler: requireApiKey },
    async (request, reply) => {
      try {
        const parsed = SendMessageSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.code(400).send({
            success: false,
            ok: false,
            error: 'Payload inválido',
            code: 'INVALID_BODY',
            details: parsed.error.flatten(),
          });
        }

        const sent = await whatsapp.sendText(
          parsed.data.to,
          parsed.data.message
        );

        return {
          success: true,
          ok: true,
          message: 'Mensaje enviado correctamente',
          data: {
            to: parsed.data.to,
            external_message_id: sent?.key?.id || false,
            raw: sent,
          },
        };
      } catch (err: any) {
        request.log.error({ err }, 'Error legacy /api/send-message');

        return reply.code(500).send({
          success: false,
          ok: false,
          error: err?.message || String(err),
          code: 'SEND_MESSAGE_ERROR',
        });
      }
    }
  );

  app.post(
    '/api/send-media',
    { preHandler: requireApiKey },
    async (request, reply) => {
      try {
        const parsed = SendMediaSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.code(400).send({
            success: false,
            ok: false,
            error: 'Payload inválido',
            code: 'INVALID_BODY',
            details: parsed.error.flatten(),
          });
        }

        const mediaUrl = parsed.data.url || parsed.data.file_url || '';
        const caption = parsed.data.caption || parsed.data.message || '';
        const mediaType = parsed.data.media_type || inferMediaType(mediaUrl);

        const sent = await whatsapp.sendMedia({
          to: parsed.data.to,
          url: mediaUrl,
          caption,
          media_type: mediaType,
          mimetype: parsed.data.mimetype,
          filename: parsed.data.filename || inferFilename(mediaUrl),
        });

        return {
          success: true,
          ok: true,
          message: 'Multimedia enviado correctamente',
          data: {
            to: parsed.data.to,
            url: mediaUrl,
            caption,
            media_type: mediaType,
            external_message_id: sent?.key?.id || false,
            raw: sent,
          },
        };
      } catch (err: any) {
        request.log.error({ err }, 'Error legacy /api/send-media');

        return reply.code(500).send({
          success: false,
          ok: false,
          error: err?.message || String(err),
          code: 'SEND_MEDIA_ERROR',
        });
      }
    }
  );

  app.get(
    '/api/groups',
    { preHandler: requireApiKey },
    async (request, reply) => {
      try {
        const groups = await whatsapp.getGroups();

        return {
          success: true,
          ok: true,
          data: groups,
        };
      } catch (err: any) {
        request.log.error({ err }, 'Error legacy /api/groups');

        return reply.code(500).send({
          success: false,
          ok: false,
          error: err?.message || String(err),
          code: 'GET_GROUPS_ERROR',
          data: [],
        });
      }
    }
  );
}