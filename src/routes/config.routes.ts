import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireApiKey } from '../middleware/auth.js';
import { getAllConfig, setConfig } from '../services/config.service.js';

const ConfigSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.number()])
);

export async function registerConfigRoutes(app: FastifyInstance) {
  app.get('/api/config', { preHandler: requireApiKey }, async () => ({
    ok: true,
    config: await getAllConfig(),
  }));

  app.put('/api/config', { preHandler: requireApiKey }, async (request, reply) => {
    const parsed = ConfigSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        errors: parsed.error.flatten(),
      });
    }

    return {
      ok: true,
      config: await setConfig(parsed.data as any),
    };
  });

  app.post(
    '/api/config/generate-api-key',
    { preHandler: requireApiKey },
    async () => {
      const apiKey = 'wg_' + crypto.randomBytes(32).toString('hex');

      const config = await setConfig({
        GATEWAY_API_KEY: apiKey,
      });

      return {
        ok: true,
        apiKey,
        config,
      };
    }
  );
}