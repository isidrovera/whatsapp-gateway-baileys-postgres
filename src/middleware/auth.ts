import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfigValue } from '../services/config.service.js';

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

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const apiKey = await getConfigValue('GATEWAY_API_KEY');
  const receivedApiKey = getRequestApiKey(request);

  if (!apiKey || receivedApiKey !== apiKey) {
    return reply.code(401).send({
      ok: false,
      success: false,
      code: 'UNAUTHORIZED',
      message: 'API key inválida o ausente',
      error: 'Error de autenticación',
    });
  }
}