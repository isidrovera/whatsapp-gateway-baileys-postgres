import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  SESSION_COOKIE_NAME,
  requireSessionUser,
} from '../middleware/auth.js';

import {
  changePassword,
  createInitialAdmin,
  hasAnyUser,
  listUserSessions,
  loginWithPassword,
  revokeAllUserSessions,
  revokeSession,
} from '../services/session.service.js';

const SetupSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(200),
  email: z.string().email().optional(),
});

const LoginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(200),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

const ParamsIdSchema = z.object({
  id: z.string().min(1),
});

function buildCookieOptions(expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: false,
    signed: true,
    expires: expiresAt,
  };
}

export async function registerSessionRoutes(app: FastifyInstance) {
  app.get('/api/session/status', async () => {
    const hasUsers = await hasAnyUser();

    return {
      ok: true,
      setupRequired: !hasUsers,
    };
  });

  app.get('/api/session/me', async (request, reply) => {
    const rawCookie = request.cookies?.[SESSION_COOKIE_NAME];
    const hasUsers = await hasAnyUser();

    if (!rawCookie) {
      return {
        ok: true,
        authenticated: false,
        setupRequired: !hasUsers,
        user: null,
      };
    }

    const unsigned = request.unsignCookie(rawCookie);

    if (!unsigned.valid || !unsigned.value) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });

      return {
        ok: true,
        authenticated: false,
        setupRequired: !hasUsers,
        user: null,
      };
    }

    const { getSessionById } = await import('../services/session.service.js');
    const session = await getSessionById(unsigned.value);

    if (!session) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });

      return {
        ok: true,
        authenticated: false,
        setupRequired: !hasUsers,
        user: null,
      };
    }

    return {
      ok: true,
      authenticated: true,
      setupRequired: false,
      user: session.user,
      sessionId: session.sessionId,
    };
  });

  app.post('/api/session/setup', async (request, reply) => {
    const parsed = SetupSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Datos inválidos',
        errors: parsed.error.flatten(),
      });
    }

    const result = await createInitialAdmin(
      parsed.data.username,
      parsed.data.password,
      parsed.data.email
    );

    if (!result.ok) {
      const code = result.code === 'ALREADY_INITIALIZED' ? 409 : 400;
      return reply.code(code).send({
        ok: false,
        code: result.code,
        message: result.message,
      });
    }

    const loginResult = await loginWithPassword(
      parsed.data.username,
      parsed.data.password,
      {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      }
    );

    if (!loginResult.ok) {
      return {
        ok: true,
        message: 'Usuario creado. Inicia sesión manualmente.',
        user: result.user,
      };
    }

    reply.setCookie(
      SESSION_COOKIE_NAME,
      loginResult.sessionId,
      buildCookieOptions(loginResult.expiresAt)
    );

    return {
      ok: true,
      message: 'Usuario administrador creado y sesión iniciada',
      user: loginResult.user,
    };
  });

  app.post('/api/session/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: 'INVALID_BODY',
        message: 'Datos inválidos',
        errors: parsed.error.flatten(),
      });
    }

    const result = await loginWithPassword(
      parsed.data.username,
      parsed.data.password,
      {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      }
    );

    if (!result.ok) {
      const statusCode =
        result.code === 'NO_USERS'
          ? 409
          : result.code === 'LOCKED'
          ? 423
          : result.code === 'USER_INACTIVE'
          ? 403
          : 401;

      return reply.code(statusCode).send({
        ok: false,
        code: result.code,
        message: result.message,
        lockedUntil: result.lockedUntil
          ? result.lockedUntil.toISOString()
          : undefined,
      });
    }

    reply.setCookie(
      SESSION_COOKIE_NAME,
      result.sessionId,
      buildCookieOptions(result.expiresAt)
    );

    return {
      ok: true,
      message: 'Sesión iniciada correctamente',
      user: result.user,
      expiresAt: result.expiresAt.toISOString(),
    };
  });

  app.post(
    '/api/session/logout',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      if (request.sessionId) {
        await revokeSession(request.sessionId);
      }

      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });

      return {
        ok: true,
        message: 'Sesión cerrada correctamente',
      };
    }
  );

  app.post(
    '/api/session/logout-all',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      if (request.sessionUser) {
        await revokeAllUserSessions(request.sessionUser.id);
      }

      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });

      return {
        ok: true,
        message: 'Todas las sesiones fueron cerradas',
      };
    }
  );

  app.get(
    '/api/session/list',
    { preHandler: requireSessionUser },
    async (request) => {
      const userId = request.sessionUser!.id;
      const currentSessionId = request.sessionId || '';

      return {
        ok: true,
        sessions: await listUserSessions(userId, currentSessionId),
      };
    }
  );

  app.delete(
    '/api/session/list/:id',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const params = ParamsIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'ID inválido',
        });
      }

      await revokeSession(params.data.id);

      return {
        ok: true,
        message: 'Sesión revocada',
      };
    }
  );

  app.post(
    '/api/session/change-password',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const parsed = ChangePasswordSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      const userId = request.sessionUser!.id;

      const result = await changePassword(
        userId,
        parsed.data.currentPassword,
        parsed.data.newPassword
      );

      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
        });
      }

      await revokeAllUserSessions(userId);
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });

      return {
        ok: true,
        message: 'Contraseña cambiada. Vuelve a iniciar sesión.',
      };
    }
  );
}