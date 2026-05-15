import type { FastifyInstance } from 'fastify';
import { whatsapp } from '../services/baileys.service.js';

export async function registerStatusRoutes(app: FastifyInstance) {
  app.get('/api/status', async () => ({ ok: true, whatsapp: whatsapp.getStatus(), time: new Date().toISOString() }));
  app.get('/api/qr', async () => ({ ok: true, ...whatsapp.getQR() }));
}
