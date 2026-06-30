import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireApiKey } from '../middleware/auth.js';
import { whatsapp } from '../services/baileys.service.js';
import { getConfigValue } from '../services/config.service.js';
import { logger } from '../utils/logger.js';

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

      logger.info(
        { phone: parsed.data.phone },
        '[AUTH-ROUTES] solicitando pairing code'
      );

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
      logger.warn('[AUTH-ROUTES] reconexión solicitada');

      await whatsapp.disconnect(false).catch((err) => {
        logger.warn({ err }, '[AUTH-ROUTES] error desconectando antes de reconectar');
      });

      await whatsapp.initialize(false);

      const status = whatsapp.getStatus();

      logger.info(
        status,
        '[AUTH-ROUTES] reconexión ejecutada'
      );

      return {
        ok: true,
        message: 'Reconexión solicitada correctamente',
        status,
      };
    }
  );

  app.post(
    '/api/auth/logout',
    { preHandler: requireApiKey },
    async () => {
      const authDir = await getAuthDirPath();

      logger.warn(
        { authDir },
        '[AUTH-ROUTES] logout WhatsApp solicitado'
      );

      /*
       * IMPORTANTE:
       * Este proyecto usa auth state en PostgreSQL:
       * usePostgresAuthState(prisma)
       *
       * Por eso no basta limpiar /app/storage/auth.
       * whatsapp.initialize(true) es quien debe limpiar la sesión real en BD.
       */

      await whatsapp.disconnect(false).catch((err) => {
        logger.warn({ err }, '[AUTH-ROUTES] error desconectando WhatsApp');
      });

      recreateDirectory(authDir);

      logger.warn(
        { authDir },
        '[AUTH-ROUTES] carpeta auth recreada solo por compatibilidad'
      );

      await whatsapp.initialize(true);

      const status = whatsapp.getStatus();
      const qr = whatsapp.getQR();

      logger.info(
        {
          status,
          hasQR: !!qr.qr,
          hasQRDataURL: !!qr.qrDataURL,
        },
        '[AUTH-ROUTES] logout finalizado y sesión PostgreSQL reiniciada'
      );

      return {
        ok: true,
        message: 'Sesión WhatsApp reiniciada correctamente en PostgreSQL',
        authMode: 'postgresql',
        authDir,
        status,
        hasQR: !!qr.qr,
      };
    }
  );

  app.post(
    '/api/auth/clear',
    { preHandler: requireApiKey },
    async () => {
      const authDir = await getAuthDirPath();

      logger.warn(
        { authDir },
        '[AUTH-ROUTES] limpieza total de sesión WhatsApp solicitada'
      );

      /*
       * Limpieza real:
       * initialize(true) borra la sesión en PostgreSQL mediante clearAll().
       */

      await whatsapp.disconnect(false).catch((err) => {
        logger.warn({ err }, '[AUTH-ROUTES] error desconectando antes de limpiar');
      });

      recreateDirectory(authDir);

      logger.warn(
        { authDir },
        '[AUTH-ROUTES] carpeta auth recreada solo por compatibilidad'
      );

      await whatsapp.initialize(true);

      const status = whatsapp.getStatus();
      const qr = whatsapp.getQR();

      logger.info(
        {
          status,
          hasQR: !!qr.qr,
          hasQRDataURL: !!qr.qrDataURL,
        },
        '[AUTH-ROUTES] limpieza finalizada y sesión PostgreSQL reiniciada'
      );

      return {
        ok: true,
        message: 'Sesión WhatsApp limpiada correctamente en PostgreSQL',
        authMode: 'postgresql',
        authDir,
        status,
        hasQR: !!qr.qr,
      };
    }
  );
}