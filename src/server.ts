import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
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
  await ensureDefaultConfig();
  const sessionSecret = await ensureSessionSecret();
  await ensureEncryptionKey();
  await seedSystemTemplates();

  const host = (await getConfigValue('HOST')) || '0.0.0.0';
  const port = (await getNumberConfig('PORT')) || 3105;
  const mediaDir = path.resolve(
    (await getConfigValue('MEDIA_DIR')) || './storage/media'
  );

  const publicDir = path.resolve(__dirname, '../src/public');

  const app = Fastify({
    logger: true,
  });

  await app.register(cookie, {
    secret: sessionSecret,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: '/public/media/',
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/static/',
    decorateReply: false,
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'whatsapp-gateway-baileys-postgres',
    time: new Date().toISOString(),
  }));

  await registerSessionRoutes(app);
  await registerPasswordResetRoutes(app);
  await registerSmtpRoutes(app);
  await registerTemplatesRoutes(app);
  await registerNotificationsRoutes(app);
  await registerStatusRoutes(app);
  await registerConfigRoutes(app);
  await registerAuthRoutes(app);
  await registerMessageRoutes(app);
  await registerLegacyRoutes(app);
  await registerUiRoutes(app);

  await whatsapp.initialize(false);

  const close = async () => {
    logger.info('Cerrando servicio...');
    await whatsapp.disconnect(false);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  await app.listen({
    host,
    port,
  });

  logger.info(`Gateway escuchando en ${host}:${port}`);
}

main().catch((err) => {
  logger.error({ err }, 'Error iniciando gateway');
  process.exit(1);
});