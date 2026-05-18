import type { FastifyReply, FastifyRequest } from 'fastify';
import { validateStoredApiKey } from '../services/config.service.js';
import { getSessionById, type PublicUser } from '../services/session.service.js';

export const SESSION_COOKIE_NAME = 'wg_session';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: PublicUser;
    sessionId?: string;
  }
}

export function getRequestApiKey(request: FastifyRequest): string {
  const xApiKey = request.headers['x-api-key'];

  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }

  const auth = request.headers.authorization || '';

  if (auth.startsWith('Bearer ')) {
    return auth.replace('Bearer ', '').trim();
  }

  return '';
}

async function tryAttachSessionUser(request: FastifyRequest): Promise<boolean> {
  const rawCookie = request.cookies?.[SESSION_COOKIE_NAME];

  if (!rawCookie) {
    return false;
  }

  const unsigned = request.unsignCookie(rawCookie);

  if (!unsigned.valid || !unsigned.value) {
    return false;
  }

  const session = await getSessionById(unsigned.value);

  if (!session) {
    return false;
  }

  request.sessionUser = session.user;
  request.sessionId = session.sessionId;

  return true;
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const hasSession = await tryAttachSessionUser(request);

  if (hasSession) {
    return;
  }

  const receivedApiKey = getRequestApiKey(request);
  const result = await validateStoredApiKey(receivedApiKey);

  if (!result.valid) {
    return reply.code(401).send({
      ok: false,
      success: false,
      code: 'UNAUTHORIZED',
      message: 'API key inválida o ausente',
      error: 'Error de autenticación',
    });
  }
}

export async function requireSessionUser(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const hasSession = await tryAttachSessionUser(request);

  if (!hasSession) {
    return reply.code(401).send({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Sesión requerida',
    });
  }
}

export async function optionalSessionUser(request: FastifyRequest) {
  await tryAttachSessionUser(request);
}