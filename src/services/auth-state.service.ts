/**
 * usePostgresAuthState
 *
 * Auth state de Baileys v7 respaldado en PostgreSQL via Prisma.
 * Reemplaza useMultiFileAuthState para producción.
 *
 * Cubre todo el SignalDataTypeMap de v7:
 *   pre-key, session, sender-key, sender-key-memory,
 *   app-state-sync-key, app-state-sync-version,
 *   lid-mapping, device-list, tctoken   ← nuevos en v7
 *
 * Estrategia de serialización:
 *   - Buffer / Uint8Array  → { _type: 'Buffer', data: number[] }
 *   - Todo lo demás        → JSON nativo (objetos, arrays, strings)
 *
 * Ref: https://baileys.wiki/docs/socket/configuration#auth
 * Ref: https://baileys.wiki/docs/migration/to-v7.0.0#lids
 */

import {
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

// ─── constantes ───────────────────────────────────────────────────────────────
const CREDS_KEY_ID = 'creds';
const CREDS_KIND   = 'creds';

// ─── helpers de serialización ─────────────────────────────────────────────────
// Baileys usa BufferJSON.replacer/reviver para serializar sus tipos internos
// (Buffer, Uint8Array, proto objects). Lo reutilizamos para mantener
// compatibilidad exacta con lo que espera la librería.

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function deserialize(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  return JSON.parse(JSON.stringify(raw), BufferJSON.reviver);
}

// ─── lectura de creds ─────────────────────────────────────────────────────────
async function readCreds(
  prisma: PrismaClient
): Promise<AuthenticationCreds> {
  try {
    const row = await prisma.whatsappAuthState.findUnique({
      where: { kind_keyId: { kind: CREDS_KIND, keyId: CREDS_KEY_ID } },
    });

    if (!row) {
      logger.info('[AUTH-STATE] sin creds en BD; inicializando nuevas credenciales');
      return initAuthCreds();
    }

    return deserialize(row.value) as AuthenticationCreds;
  } catch (err) {
    logger.error({ err }, '[AUTH-STATE] error leyendo creds; inicializando nuevas');
    return initAuthCreds();
  }
}

// ─── escritura de creds ───────────────────────────────────────────────────────
async function writeCreds(
  prisma: PrismaClient,
  creds: AuthenticationCreds
): Promise<void> {
  try {
    await prisma.whatsappAuthState.upsert({
      where:  { kind_keyId: { kind: CREDS_KIND, keyId: CREDS_KEY_ID } },
      create: { kind: CREDS_KIND, keyId: CREDS_KEY_ID, value: serialize(creds) as any },
      update: { value: serialize(creds) as any },
    });
  } catch (err) {
    logger.error({ err }, '[AUTH-STATE] error guardando creds');
    throw err;
  }
}

// ─── SignalKeyStore ───────────────────────────────────────────────────────────
function makeSignalKeyStore(prisma: PrismaClient): SignalKeyStore {
  return {
    // ── get ──────────────────────────────────────────────────────────────────
    async get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
      if (!ids.length) return {};

      try {
        const rows = await prisma.whatsappAuthState.findMany({
          where: {
            kind: type,
            keyId: { in: ids },
          },
        });

        const result: { [id: string]: SignalDataTypeMap[T] } = {};

        for (const row of rows) {
          result[row.keyId] = deserialize(row.value) as SignalDataTypeMap[T];
        }

        logger.debug(
          { type, requested: ids.length, found: rows.length },
          '[AUTH-STATE] keys.get'
        );

        return result;
      } catch (err) {
        logger.error({ err, type, ids }, '[AUTH-STATE] error en keys.get');
        return {};
      }
    },

    // ── set ──────────────────────────────────────────────────────────────────
    async set(data: SignalDataSet): Promise<void> {
      // Construimos un batch de upserts y deletes.
      // Baileys indica borrado pasando null como valor.
      const upserts: Array<{ kind: string; keyId: string; value: any }> = [];
      const deletes: Array<{ kind: string; keyId: string }> = [];

      for (const [type, entries] of Object.entries(data)) {
        if (!entries) continue;

        for (const [id, value] of Object.entries(entries)) {
          if (value === null || value === undefined) {
            deletes.push({ kind: type, keyId: id });
          } else {
            upserts.push({
              kind:  type,
              keyId: id,
              value: serialize(value),
            });
          }
        }
      }

      try {
        // Ejecutamos en una transacción para atomicidad.
        await prisma.$transaction(async (tx) => {
          // Upserts
          for (const row of upserts) {
            await tx.whatsappAuthState.upsert({
              where:  { kind_keyId: { kind: row.kind, keyId: row.keyId } },
              create: { kind: row.kind, keyId: row.keyId, value: row.value },
              update: { value: row.value },
            });
          }

          // Deletes
          if (deletes.length) {
            // deleteMany con OR para no hacer N queries individuales.
            await tx.whatsappAuthState.deleteMany({
              where: {
                OR: deletes.map((d) => ({ kind: d.kind, keyId: d.keyId })),
              },
            });
          }
        });

        logger.debug(
          { upserted: upserts.length, deleted: deletes.length },
          '[AUTH-STATE] keys.set completado'
        );
      } catch (err) {
        logger.error({ err, upserted: upserts.length, deleted: deletes.length }, '[AUTH-STATE] error en keys.set');
        throw err;
      }
    },

    // ── clear ────────────────────────────────────────────────────────────────
    // Llamado por Baileys cuando se hace logout. Borra todas las claves Signal
    // pero NO las creds (esas las maneja el nivel superior).
    async clear(): Promise<void> {
      try {
        const { count } = await prisma.whatsappAuthState.deleteMany({
          where: { kind: { not: CREDS_KIND } },
        });
        logger.info({ deleted: count }, '[AUTH-STATE] keys.clear: todas las claves Signal eliminadas');
      } catch (err) {
        logger.error({ err }, '[AUTH-STATE] error en keys.clear');
        throw err;
      }
    },
  };
}

// ─── export principal ─────────────────────────────────────────────────────────

export type PostgresAuthState = {
  state: {
    creds: AuthenticationCreds;
    keys: SignalKeyStore;
  };
  saveCreds: () => Promise<void>;
  /**
   * Elimina TODA la sesión de la BD (creds + keys).
   * Úsalo cuando hagas forceNew=true en el gateway.
   */
  clearAll: () => Promise<void>;
};

export async function usePostgresAuthState(
  prisma: PrismaClient
): Promise<PostgresAuthState> {
  const creds = await readCreds(prisma);
  const keys  = makeSignalKeyStore(prisma);

  const saveCreds = async () => {
    await writeCreds(prisma, creds);
  };

  const clearAll = async () => {
    try {
      const { count } = await prisma.whatsappAuthState.deleteMany({});
      logger.info({ deleted: count }, '[AUTH-STATE] clearAll: sesión completa eliminada de BD');
    } catch (err) {
      logger.error({ err }, '[AUTH-STATE] error en clearAll');
      throw err;
    }
  };

  return {
    state: { creds, keys },
    saveCreds,
    clearAll,
  };
}