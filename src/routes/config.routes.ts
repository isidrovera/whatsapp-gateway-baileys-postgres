import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireApiKey } from '../middleware/auth.js';

import {
  createApiKey,
  deactivateApiKey,
  getAllConfig,
  listPublicApiKeys,
  setConfig,
  updateApiKey,
} from '../services/config.service.js';

const ConfigSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.number()])
);

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

const UpdateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
});

const ParamsIdSchema = z.object({
  id: z.string().min(1),
});

export async function registerConfigRoutes(app: FastifyInstance) {
  app.get('/api/config', { preHandler: requireApiKey }, async () => ({
    ok: true,
    config: await getAllConfig(),
    apiKeys: await listPublicApiKeys(),
  }));

  app.put('/api/config', { preHandler: requireApiKey }, async (request, reply) => {
    const parsed = ConfigSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Configuración inválida',
        errors: parsed.error.flatten(),
      });
    }

    return {
      ok: true,
      config: await setConfig(parsed.data as any),
      apiKeys: await listPublicApiKeys(),
    };
  });

  app.get('/api/config/api-keys', { preHandler: requireApiKey }, async () => {
    return {
      ok: true,
      apiKeys: await listPublicApiKeys(),
    };
  });

  app.post(
    '/api/config/api-keys',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const parsed = CreateApiKeySchema.safeParse(request.body || {});

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos para crear API key',
          errors: parsed.error.flatten(),
        });
      }

      const result = await createApiKey(parsed.data.name);

      return {
        ok: true,
        message: 'API key creada correctamente. Guarda esta clave porque no se volverá a mostrar completa.',
        apiKey: result.apiKey,
        item: result.item,
        apiKeys: result.items,
      };
    }
  );

  app.patch(
    '/api/config/api-keys/:id',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const params = ParamsIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'ID inválido',
          errors: params.error.flatten(),
        });
      }

      const body = UpdateApiKeySchema.safeParse(request.body || {});

      if (!body.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos para actualizar API key',
          errors: body.error.flatten(),
        });
      }

      const item = await updateApiKey(params.data.id, body.data);

      if (!item) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'API key no encontrada',
        });
      }

      return {
        ok: true,
        item,
        apiKeys: await listPublicApiKeys(),
      };
    }
  );

  app.delete(
    '/api/config/api-keys/:id',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const params = ParamsIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'ID inválido',
          errors: params.error.flatten(),
        });
      }

      const item = await deactivateApiKey(params.data.id);

      if (!item) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'API key no encontrada',
        });
      }

      return {
        ok: true,
        message: 'API key desactivada correctamente',
        item,
        apiKeys: await listPublicApiKeys(),
      };
    }
  );

  app.post(
    '/api/config/generate-api-key',
    { preHandler: requireApiKey },
    async () => {
      const result = await createApiKey('API Key generada desde panel');

      return {
        ok: true,
        message: 'API key creada correctamente. Guarda esta clave porque no se volverá a mostrar completa.',
        apiKey: result.apiKey,
        item: result.item,
        apiKeys: result.items,
        config: await getAllConfig(),
      };
    }
  );
}