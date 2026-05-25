import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireSessionUser } from '../middleware/auth.js';
import {
  createCustomTemplate,
  deleteTemplate,
  getTemplateById,
  listTemplates,
  updateTemplate,
} from '../services/templates.service.js';

const ParamsIdSchema = z.object({
  id: z.string().min(1),
});

const CodeRegex = /^[A-Z0-9_]+$/;

const CreateTemplateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(50)
    .regex(CodeRegex, 'El código debe ser MAYÚSCULAS_CON_GUIONES_BAJOS'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  subject: z.string().min(1).max(300),
  bodyHtml: z.string().min(1),
  bodyText: z.string().optional(),
});

const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  subject: z.string().min(1).max(300).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export async function registerTemplatesRoutes(app: FastifyInstance) {
  app.get(
    '/api/templates',
    { preHandler: requireSessionUser },
    async () => {
      return {
        ok: true,
        templates: await listTemplates(),
      };
    }
  );

  app.get(
    '/api/templates/:id',
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

      const template = await getTemplateById(params.data.id);

      if (!template) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Plantilla no encontrada',
        });
      }

      return {
        ok: true,
        template,
      };
    }
  );

  app.post(
    '/api/templates',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const parsed = CreateTemplateSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      try {
        const template = await createCustomTemplate(parsed.data);

        return {
          ok: true,
          message: 'Plantilla creada correctamente',
          template,
        };
      } catch (err: any) {
        if (err?.code === 'P2002') {
          return reply.code(409).send({
            ok: false,
            code: 'CODE_EXISTS',
            message: 'Ya existe una plantilla con ese código',
          });
        }

        throw err;
      }
    }
  );

  app.patch(
    '/api/templates/:id',
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

      const parsed = UpdateTemplateSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      const template = await updateTemplate(params.data.id, parsed.data);

      if (!template) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Plantilla no encontrada',
        });
      }

      return {
        ok: true,
        message: 'Plantilla actualizada',
        template,
      };
    }
  );

  app.delete(
    '/api/templates/:id',
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

      const result = await deleteTemplate(params.data.id);

      if (!result.ok) {
        const statusCode = result.reason === 'IS_SYSTEM' ? 403 : 404;
        const code = result.reason || 'ERROR';
        const message =
          result.reason === 'IS_SYSTEM'
            ? 'Las plantillas del sistema no se pueden eliminar'
            : 'Plantilla no encontrada';

        return reply.code(statusCode).send({
          ok: false,
          code,
          message,
        });
      }

      return {
        ok: true,
        message: 'Plantilla eliminada',
      };
    }
  );
}