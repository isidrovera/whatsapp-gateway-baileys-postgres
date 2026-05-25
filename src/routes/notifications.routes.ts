import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireSessionUser } from '../middleware/auth.js';
import {
  addRecipient,
  createRule,
  deleteRule,
  getRuleById,
  listRules,
  removeRecipient,
  toggleRecipient,
  triggerEvent,
  updateRule,
} from '../services/notifications.service.js';

const ParamsIdSchema = z.object({
  id: z.string().min(1),
});

const ParamsRuleIdSchema = z.object({
  ruleId: z.string().min(1),
});

const ParamsRuleRecipientSchema = z.object({
  ruleId: z.string().min(1),
  recipientId: z.string().min(1),
});

const EventTypeRegex = /^[A-Z0-9_]+$/;

const CreateRuleSchema = z.object({
  eventType: z
    .string()
    .min(2)
    .max(50)
    .regex(EventTypeRegex, 'eventType debe ser MAYÚSCULAS_CON_GUIONES_BAJOS'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  templateCode: z.string().min(1).max(50),
  active: z.boolean().optional(),
  throttleMinutes: z.number().int().min(0).max(1440).optional(),
});

const UpdateRuleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  templateCode: z.string().min(1).max(50).optional(),
  active: z.boolean().optional(),
  throttleMinutes: z.number().int().min(0).max(1440).optional(),
});

const AddRecipientSchema = z.object({
  email: z.string().email(),
});

const ToggleRecipientSchema = z.object({
  active: z.boolean(),
});

const TriggerEventSchema = z.object({
  eventType: z.string().min(1),
  variables: z.record(z.string(), z.string()).optional(),
});

export async function registerNotificationsRoutes(app: FastifyInstance) {
  app.get(
    '/api/notifications/rules',
    { preHandler: requireSessionUser },
    async () => {
      return {
        ok: true,
        rules: await listRules(),
      };
    }
  );

  app.get(
    '/api/notifications/rules/:id',
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

      const rule = await getRuleById(params.data.id);

      if (!rule) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Regla no encontrada',
        });
      }

      return {
        ok: true,
        rule,
      };
    }
  );

  app.post(
    '/api/notifications/rules',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const parsed = CreateRuleSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      try {
        const rule = await createRule(parsed.data);

        return {
          ok: true,
          message: 'Regla creada correctamente',
          rule,
        };
      } catch (err: any) {
        if (err?.code === 'P2002') {
          return reply.code(409).send({
            ok: false,
            code: 'EVENT_TYPE_EXISTS',
            message: 'Ya existe una regla con ese eventType',
          });
        }

        throw err;
      }
    }
  );

  app.patch(
    '/api/notifications/rules/:id',
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

      const parsed = UpdateRuleSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      const rule = await updateRule(params.data.id, parsed.data);

      if (!rule) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Regla no encontrada',
        });
      }

      return {
        ok: true,
        message: 'Regla actualizada',
        rule,
      };
    }
  );

  app.delete(
    '/api/notifications/rules/:id',
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

      const ok = await deleteRule(params.data.id);

      if (!ok) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Regla no encontrada',
        });
      }

      return {
        ok: true,
        message: 'Regla eliminada',
      };
    }
  );

  app.post(
    '/api/notifications/rules/:ruleId/recipients',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const params = ParamsRuleIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'ID inválido',
        });
      }

      const parsed = AddRecipientSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Email inválido',
          errors: parsed.error.flatten(),
        });
      }

      const recipient = await addRecipient(params.data.ruleId, parsed.data.email);

      if (!recipient) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Regla no encontrada',
        });
      }

      return {
        ok: true,
        message: 'Destinatario agregado',
        recipient,
      };
    }
  );

  app.patch(
    '/api/notifications/rules/:ruleId/recipients/:recipientId',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const params = ParamsRuleRecipientSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'IDs inválidos',
        });
      }

      const parsed = ToggleRecipientSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      const recipient = await toggleRecipient(params.data.recipientId, parsed.data.active);

      if (!recipient) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Destinatario no encontrado',
        });
      }

      return {
        ok: true,
        message: 'Destinatario actualizado',
        recipient,
      };
    }
  );

  app.delete(
    '/api/notifications/rules/:ruleId/recipients/:recipientId',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const params = ParamsRuleRecipientSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_PARAMS',
          message: 'IDs inválidos',
        });
      }

      const ok = await removeRecipient(params.data.recipientId);

      if (!ok) {
        return reply.code(404).send({
          ok: false,
          code: 'NOT_FOUND',
          message: 'Destinatario no encontrado',
        });
      }

      return {
        ok: true,
        message: 'Destinatario eliminado',
      };
    }
  );

  app.post(
    '/api/notifications/trigger',
    { preHandler: requireSessionUser },
    async (request, reply) => {
      const parsed = TriggerEventSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          code: 'INVALID_BODY',
          message: 'Datos inválidos',
          errors: parsed.error.flatten(),
        });
      }

      const result = await triggerEvent(parsed.data.eventType, parsed.data.variables);

      return {
        ok: result.ok,
        code: result.code,
        message: result.message,
        sentTo: result.sentTo,
      };
    }
  );
}