import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireApiKey } from '../middleware/auth.js';
import { whatsapp } from '../services/baileys.service.js';
import { getConfigValue } from '../services/config.service.js';

const PairingSchema = z.object({
  phone: z.string().min(8),
});

async function getAuthDirPath() {
  const authDir = (await getConfigValue('AUTH_DIR')) || './storage/auth';
  return path.resolve(authDir);
}

function recreateDirectory(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    });
  }

  fs.mkdirSync(dir, {
    recursive: true,
  });
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/pairing-code',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const parsed = PairingSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Teléfono inválido',
          errors: parsed.error.flatten(),
        });
      }

      const code = await whatsapp.requestPairingCode(parsed.data.phone);

      return {
        ok: true,
        code,
      };
    }
  );

  app.post(
    '/api/auth/reconnect',
    { preHandler: requireApiKey },
    async () => {
      await whatsapp.disconnect(false);
      await whatsapp.initialize(false);

      return {
        ok: true,
        message: 'Reconexión solicitada correctamente',
      };
    }
  );

  app.post(
    '/api/auth/logout',
    { preHandler: requireApiKey },
    async () => {
      const authDir = await getAuthDirPath();

      await whatsapp.disconnect(true).catch(() => undefined);

      recreateDirectory(authDir);

      await whatsapp.initialize(true);

      return {
        ok: true,
        message: 'Sesión cerrada y carpeta auth limpiada correctamente',
        authDir,
      };
    }
  );

  app.post(
    '/api/auth/clear',
    { preHandler: requireApiKey },
    async () => {
      const authDir = await getAuthDirPath();

      await whatsapp.disconnect(false).catch(() => undefined);

      recreateDirectory(authDir);

      await whatsapp.initialize(true);

      return {
        ok: true,
        message: 'Carpeta auth limpiada correctamente',
        authDir,
      };
    }
  );
}