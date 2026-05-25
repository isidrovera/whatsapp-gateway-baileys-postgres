import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  consumeResetToken,
  requestPasswordReset,
  validateResetToken,
} from '../services/password-reset.service.js';

const RequestSchema = z.object({
  identifier: z.string().min(1).max(120),
});

const ValidateSchema = z.object({
  token: z.string().min(16).max(200),
});

const ConsumeSchema = z.object({
  token: z.string().min(16).max(200),
  newPassword: z.string().min(8).max(200),
});

export async function registerPasswordResetRoutes(app: FastifyInstance) {
  app.post('/api/password-reset/request', async (request, reply) => {
    const parsed = RequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Datos inválidos',
        errors: parsed.error.flatten(),
      });
    }

    const result = await requestPasswordReset(parsed.data.identifier);

    return result;
  });

  app.post('/api/password-reset/validate', async (request, reply) => {
    const parsed = ValidateSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Token inválido',
      });
    }

    const result = await validateResetToken(parsed.data.token);

    if (!result.valid) {
      return reply.code(400).send({
        ok: false,
        code: result.code || 'INVALID_TOKEN',
        message: result.message || 'Token inválido',
      });
    }

    return {
      ok: true,
      username: result.username,
    };
  });

  app.post('/api/password-reset/consume', async (request, reply) => {
    const parsed = ConsumeSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Datos inválidos',
        errors: parsed.error.flatten(),
      });
    }

    const result = await consumeResetToken(parsed.data.token, parsed.data.newPassword);

    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
      });
    }

    return result;
  });
}