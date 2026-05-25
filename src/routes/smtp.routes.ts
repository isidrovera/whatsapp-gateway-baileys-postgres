import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireSessionUser } from '../middleware/auth.js';
import {
  getSmtpConfig,
  upsertSmtpConfig,
} from '../services/smtp.service.js';
import {
  invalidateTransporterCache,
  listEmailLogs,
  sendTestEmail,
} from '../services/email.service.js';

const SmtpConfigSchema = z.object({
  active: z.boolean().optional(),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().optional(),
  authMethod: z.enum(['PASSWORD']).optional(),
  username: z.string().max(255).nullable().optional(),
  password: z.string().max(500).nullable().optional(),
  fromName: z.string().min(1).max(120),
  fromEmail: z.string().email(),
  replyTo: z.string().email().nullable().optional(),
});

const TestEmailSchema = z.object({
  to: z.string().email(),
});

const LogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function registerSmtpRoutes(app: FastifyInstance) {
  app.get(
    '/api/smtp/config',
    { preHandler: requireSessionUser },
    async () => {
      const config = await getSmtpConfig();

      return {
        ok: true,
        config,
      };
    }
  );

  app.put(
    '/api/smtp/config',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const parsed = SmtpConfigSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      const config = await upsertSmtpConfig(parsed.data);
      invalidateTransporterCache();

      return {
        ok: true,
        message: 'Configuración SMTP guardada',
        config,
      };
    }
  );

  app.post(
    '/api/smtp/test',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const parsed = TestEmailSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Email destino inválido',
          errors: parsed.error.flatten(),
        });
      }

      const result = await sendTestEmail(parsed.data.to);

      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          logId: result.logId,
        });
      }

      return {
        ok: true,
        message: 'Email de prueba enviado correctamente',
        messageId: result.messageId,
        logId: result.logId,
      };
    }
  );

  app.get(
    '/api/smtp/logs',
    { preHandler: requireSessionUser },
    async (request) => {
      const parsed = LogsQuerySchema.safeParse(request.query);
      const limit = parsed.success ? parsed.data.limit ?? 50 : 50;

      const logs = await listEmailLogs(limit);

      return {
        ok: true,
        logs,
      };
    }
  );
}