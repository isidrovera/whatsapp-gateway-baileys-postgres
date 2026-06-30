import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from './utils/logger.js';
import { prisma } from './db/prisma.js';
import { registerLegacyRoutes } from './routes/legacy.routes.js';
import {
  ensureDefaultConfig,
  getConfigValue,
  getNumberConfig,
} from './services/config.service.js';
import {
  ensureSessionSecret,
  ensureEncryptionKey,
} from './services/session.service.js';
import { seedSystemTemplates } from './services/templates.service.js';
import { registerStatusRoutes } from './routes/status.routes.js';
import { registerConfigRoutes } from './routes/config.routes.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerMessageRoutes } from './routes/messages.routes.js';
import { registerUiRoutes } from './routes/ui.routes.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerSmtpRoutes } from './routes/smtp.routes.js';
import { registerTemplatesRoutes } from './routes/templates.routes.js';
import { registerNotificationsRoutes } from './routes/notifications.routes.js';
import { registerPasswordResetRoutes } from './routes/password-reset.routes.js';
import { whatsapp } from './services/baileys.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  logger.info('======================================');
  logger.info('Iniciando WhatsApp Gateway Baileys...');
  logger.info('======================================');

  logger.info('Inicializando configuración por defecto...');
  await ensureDefaultConfig();

  logger.info('Inicializando SESSION_SECRET...');
  const sessionSecret = await ensureSessionSecret();

  logger.info('Inicializando ENCRYPTION_KEY...');
  await ensureEncryptionKey();

  logger.info('Inicializando plantillas del sistema...');
  await seedSystemTemplates();

  const dbHost = await getConfigValue('HOST');
  const dbPort = await getNumberConfig('PORT');
  const dbMediaDir = await getConfigValue('MEDIA_DIR');

  const host = process.env.HOST || dbHost || '0.0.0.0';
  const port = Number(process.env.PORT || dbPort || 3105);

  const mediaDir = path.resolve(
    process.env.MEDIA_DIR || dbMediaDir || './storage/media'
  );

  const publicDir = path.resolve(__dirname, '../src/public');

  logger.info({
    env_HOST: process.env.HOST || null,
    db_HOST: dbHost || null,
    final_HOST: host,
  }, 'Configuración HOST');

  logger.info({
    env_PORT: process.env.PORT || null,
    db_PORT: dbPort || null,
    final_PORT: port,
  }, 'Configuración PORT');

  logger.info({
    env_MEDIA_DIR: process.env.MEDIA_DIR || null,
    db_MEDIA_DIR: dbMediaDir || null,
    final_MEDIA_DIR: mediaDir,
  }, 'Configuración MEDIA_DIR');

  logger.info({
    publicDir,
  }, 'Configuración directorio público');

  if (!fs.existsSync(mediaDir)) {
    logger.warn({ mediaDir }, 'MEDIA_DIR no existe, creando carpeta...');
    fs.mkdirSync(mediaDir, { recursive: true });
  } else {
    logger.info({ mediaDir }, 'MEDIA_DIR existe correctamente');
  }

  if (!fs.existsSync(publicDir)) {
    logger.warn({ publicDir }, 'Directorio público no existe');
  } else {
    logger.info({ publicDir }, 'Directorio público existe correctamente');
  }

  const app = Fastify({
    logger: true,
  });

  logger.info('Registrando cookie...');
  await app.register(cookie, {
    secret: sessionSecret,
  });

  logger.info('Registrando CORS...');
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  logger.info('Registrando ruta estática /public/media/...');
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: '/public/media/',
    decorateReply: false,
  });

  logger.info('Registrando ruta estática /static/...');
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/static/',
    decorateReply: false,
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'whatsapp-gateway-baileys-postgres',
    host,
    port,
    mediaDir,
    publicDir,
    time: new Date().toISOString(),
  }));

  logger.info('Registrando rutas de sesión...');
  await registerSessionRoutes(app);

  logger.info('Registrando rutas de recuperación de contraseña...');
  await registerPasswordResetRoutes(app);

  logger.info('Registrando rutas SMTP...');
  await registerSmtpRoutes(app);

  logger.info('Registrando rutas de plantillas...');
  await registerTemplatesRoutes(app);

  logger.info('Registrando rutas de notificaciones...');
  await registerNotificationsRoutes(app);

  logger.info('Registrando rutas de estado...');
  await registerStatusRoutes(app);

  logger.info('Registrando rutas de configuración...');
  await registerConfigRoutes(app);

  logger.info('Registrando rutas de autenticación...');
  await registerAuthRoutes(app);

  logger.info('Registrando rutas de mensajes...');
  await registerMessageRoutes(app);

  logger.info('Registrando rutas legacy...');
  await registerLegacyRoutes(app);

  logger.info('Registrando rutas UI...');
  await registerUiRoutes(app);

  logger.info('Inicializando Baileys...');
  await whatsapp.initialize(false);

  const close = async () => {
    logger.info('Cerrando servicio...');

    try {
      logger.info('Desconectando WhatsApp...');
      await whatsapp.disconnect(false);
    } catch (err) {
      logger.error({ err }, 'Error desconectando WhatsApp');
    }

    try {
      logger.info('Desconectando Prisma...');
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, 'Error desconectando Prisma');
    }

    logger.info('Servicio cerrado');
    process.exit(0);
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  logger.info({
    host,
    port,
  }, 'Iniciando servidor Fastify...');

  await app.listen({
    host,
    port,
  });

  logger.info('======================================');
  logger.info(`Gateway escuchando en http://${host}:${port}`);
  logger.info(`Health check: http://${host}:${port}/health`);
  logger.info('======================================');
}

main().catch((err) => {
  logger.error({ err }, 'Error iniciando gateway');
  process.exit(1);
});