import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import {
  getSessionById,
  hasAnyUser,
} from '../services/session.service.js';

export async function registerUiRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const hasUsers = await hasAnyUser();

    if (!hasUsers) {
      return reply.redirect('/static/setup.html');
    }

    const rawCookie = request.cookies?.[SESSION_COOKIE_NAME];

    if (!rawCookie) {
      return reply.redirect('/static/login.html');
    }

    const unsigned = request.unsignCookie(rawCookie);

    if (!unsigned.valid || !unsigned.value) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return reply.redirect('/static/login.html');
    }

    const session = await getSessionById(unsigned.value);

    if (!session) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return reply.redirect('/static/login.html');
    }

    return reply.redirect('/static/panel.html');
  });
}