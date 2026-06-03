import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import {
  cleanPhone,
  extractIdentifiers,
  isGroupJid,
  isLidJid,
  isPnJid,
  jidFromTo,
  normalizeLidJid,
} from '../utils/jid.js';
import {
  extractText,
  getFileName,
  getMessageType,
  getMimeType,
} from '../utils/message.js';
import {
  getBooleanConfig,
  getConfigValue,
  getNumberConfig,
} from './config.service.js';
import {
  maybeBase64,
  saveIncomingMedia,
  getBufferFromBase64,
  getBufferFromUrl,
} from './media.service.js';
import { postToInboundWebhook } from './webhook.service.js';
import { markOdooOutboxSent } from './odoo.service.js';
import { usePostgresAuthState } from './auth-state.service.js';

type SendMessageSafeOptions = {
  traceId?: string;
  outboxId?: number | false | null;
  timeoutMs?: number;
  messageType?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// v7: la versión de WA Web se deja al default interno de Baileys (ProtoCocktail).
// No fijar version manualmente ni usar fetchLatestWaWebVersion en cada conexión.
// Ref: https://baileys.wiki/docs/socket/configuration#version
// ─────────────────────────────────────────────────────────────────────────────

class WhatsAppGateway {
  private sock: WASocket | null = null;
  private ready = false;
  private currentQR: string | null = null;
  private qrDataURL: string | null = null;
  private startTime = Date.now();
  private botSentMessageIds = new Map<string, number>();
  private messageCache = new Map<string, { message: proto.IMessage; expiresAt: number }>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryCount = 0;

  // saveCreds se guarda aquí para poder llamarlo desde el evento creds.update
  // sin tener que re-instanciar el auth state en cada reconexión.
  private saveCreds: (() => Promise<void>) | null = null;

  private static readonly MESSAGE_CACHE_TTL_MS = 60 * 60 * 1000;
  private static readonly MESSAGE_CACHE_MAX = 2000;

  getStatus() {
    return {
      connected: this.ready,
      hasQR: !!this.currentQR,
      user: this.sock?.user || null,
      retryCount: this.retryCount,
    };
  }

  getQR() {
    return {
      qr: this.currentQR,
      qrDataURL: this.qrDataURL,
    };
  }

  private serializeError(error: any) {
    return {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || null,
      code: error?.code || null,
      statusCode: error?.output?.statusCode || error?.statusCode || null,
    };
  }

  private async createTraceLog(params: {
    type: string;
    status: string;
    phone?: string | null;
    jid?: string | null;
    lid?: string | null;
    rawJid?: string | null;
    payload?: any;
    response?: any;
    error?: string | null;
  }) {
    try {
      await prisma.eventLog.create({
        data: {
          type: params.type,
          status: params.status,
          phone: params.phone || null,
          jid: params.jid || null,
          lid: params.lid || null,
          rawJid: params.rawJid || null,
          payload: params.payload || {},
          response: params.response || undefined,
          error: params.error || undefined,
        },
      });
    } catch (err) {
      logger.warn(
        { err, traceType: params.type, traceStatus: params.status },
        '[TRACE] No se pudo guardar eventLog'
      );
    }
  }

  private markBotMessageId(id?: string | null) {
    if (!id) return;
    this.botSentMessageIds.set(id, Date.now() + 5 * 60 * 1000);
  }

  private isFromBotById(id?: string | null) {
    if (!id) return false;
    const exp = this.botSentMessageIds.get(id);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.botSentMessageIds.delete(id);
      return false;
    }
    return true;
  }

  // ==================================================
  // CACHÉ DE MENSAJES (para reenvíos / getMessage)
  // ==================================================
  private cacheMessage(id?: string | null, message?: proto.IMessage | null) {
    if (!id || !message) return;

    this.messageCache.set(id, {
      message,
      expiresAt: Date.now() + WhatsAppGateway.MESSAGE_CACHE_TTL_MS,
    });

    logger.debug(
      { messageId: id, cacheSize: this.messageCache.size },
      '[WA-CACHE] mensaje cacheado para posible reenvío'
    );

    if (this.messageCache.size > WhatsAppGateway.MESSAGE_CACHE_MAX) {
      this.cleanupMessageCache();
    }
  }

  private cleanupMessageCache() {
    const now = Date.now();
    let removedExpired = 0;

    for (const [id, item] of this.messageCache.entries()) {
      if (item.expiresAt <= now) {
        this.messageCache.delete(id);
        removedExpired++;
      }
    }

    let removedExcess = 0;
    if (this.messageCache.size > WhatsAppGateway.MESSAGE_CACHE_MAX) {
      const excess = this.messageCache.size - WhatsAppGateway.MESSAGE_CACHE_MAX;
      const ids = Array.from(this.messageCache.keys()).slice(0, excess);
      for (const id of ids) {
        this.messageCache.delete(id);
        removedExcess++;
      }
    }

    logger.debug(
      { removedExpired, removedExcess, cacheSize: this.messageCache.size },
      '[WA-CACHE] limpieza de caché ejecutada'
    );
  }

  // ==================================================
  // getMessage
  //
  // Estrategia de resolución (en orden):
  //   1) Caché en memoria (proto.IMessage completo)
  //   2) BD: rawProto serializado
  //   3) BD: reconstrucción de texto plano (solo messageType=text)
  //   4) undefined → Baileys limpia el estado sin re-cifrar
  //
  // CRÍTICO: devolver undefined es correcto cuando no se puede recuperar
  // el proto original. Devolver proto vacío con sesión en pendingPreKey
  // (frecuente en v7 con LIDs) causa "Esperando el mensaje" permanente.
  // Ref: https://baileys.wiki/docs/socket/configuration#getmessage
  // ==================================================
  private async getMessageForRetry(key: any): Promise<proto.IMessage | undefined> {
    const messageId = key?.id || '';
    const remoteJid = key?.remoteJid || '';

    logger.info(
      { messageId, remoteJid, fromMe: key?.fromMe },
      '[WA-GETMSG] WhatsApp solicita reenvío de mensaje'
    );

    if (!messageId) {
      logger.warn('[WA-GETMSG] sin messageId; devolviendo undefined');
      return undefined;
    }

    // ── FUENTE 1: caché en memoria ──
    try {
      const cached = this.messageCache.get(messageId);
      if (cached) {
        if (cached.expiresAt > Date.now()) {
          logger.info({ messageId }, '[WA-GETMSG] ✅ resuelto desde caché en memoria');
          return cached.message;
        }
        this.messageCache.delete(messageId);
      }
    } catch (err) {
      logger.warn({ err, messageId }, '[WA-GETMSG] error leyendo caché en memoria');
    }

    // ── FUENTE 2 y 3: base de datos ──
    try {
      const logged = await prisma.messageLog.findFirst({
        where: { externalMessageId: messageId },
        orderBy: { createdAt: 'desc' },
      });

      if (!logged) {
        logger.warn({ messageId }, '[WA-GETMSG] sin registro en BD; devolviendo undefined');
        return undefined;
      }

      const rawProto = (logged as any)?.rawProto;
      if (rawProto) {
        try {
          const parsed = typeof rawProto === 'string' ? JSON.parse(rawProto) : rawProto;
          if (parsed && typeof parsed === 'object') {
            logger.info({ messageId }, '[WA-GETMSG] ✅ resuelto desde BD (rawProto)');
            this.cacheMessage(messageId, parsed as proto.IMessage);
            return parsed as proto.IMessage;
          }
        } catch (err) {
          logger.warn({ err, messageId }, '[WA-GETMSG] rawProto no parseable');
        }
      }

      if (logged.messageType === 'text' && logged.content) {
        logger.info({ messageId }, '[WA-GETMSG] ✅ resuelto desde BD (reconstrucción texto)');
        const reconstructed: proto.IMessage = { conversation: logged.content };
        this.cacheMessage(messageId, reconstructed);
        return reconstructed;
      }

      logger.warn(
        { messageId, messageType: logged.messageType },
        '[WA-GETMSG] registro hallado pero no reconstruible; devolviendo undefined'
      );
      return undefined;
    } catch (err) {
      logger.warn({ err: this.serializeError(err), messageId }, '[WA-GETMSG] error en BD');
    }

    logger.warn({ messageId }, '[WA-GETMSG] todas las fuentes agotadas; devolviendo undefined');
    return undefined;
  }

  private scheduleReconnect(forceNew = false) {
    if (this.retryCount >= 10) {
      logger.error('Se alcanzó el límite de reintentos de WhatsApp');
      return;
    }

    const delay = Math.min(3000 * Math.pow(2, this.retryCount), 60000);
    this.retryCount += 1;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    logger.info(
      { retryCount: this.retryCount, delayMs: delay, forceNew },
      'Programando reconexión WhatsApp'
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initialize(forceNew).catch((err) =>
        logger.error({ err }, 'Error reconectando WhatsApp')
      );
    }, delay);
  }

  private isInternalOrUnsupportedMessage(message: proto.IWebMessageInfo) {
    const raw: any = message.message || {};
    if (!raw || Object.keys(raw).length === 0) return true;
    if (raw.protocolMessage) return true;
    const keys = Object.keys(raw);
    if (raw.senderKeyDistributionMessage && keys.length === 1) return true;
    if (raw.messageContextInfo && keys.length === 1) return true;
    if ((message as any).messageStubType) return true;
    return false;
  }

  private getRemoteJid(message: proto.IWebMessageInfo) {
    return message.key?.remoteJid || message.key?.participant || '';
  }

  private getTimestampMs(message: proto.IWebMessageInfo) {
    const raw = Number(message.messageTimestamp || 0);
    if (!raw) return Date.now();
    if (raw > 1000000000000) return raw;
    return raw * 1000;
  }

  private normalizePhoneCandidate(value?: string | null): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (isLidJid(raw)) return '';
    const digits = cleanPhone(raw);
    if (!digits) return '';
    return digits;
  }

  // ==================================================
  // RESOLUCIÓN DE LID → PN
  //
  // v7: el mapeo LID↔PN es ahora obligatorio en todas las sesiones nuevas.
  // Los campos canónicos remoteJidAlt (DMs) y participantAlt (grupos) son
  // provistos directamente en el MessageKey por WhatsApp.
  // Fallback: signalRepository.lidMapping.getPNForLID (persiste en
  // WhatsappAuthState gracias al auth state de Prisma).
  // Ref: https://baileys.wiki/docs/migration/to-v7.0.0#lids
  // ==================================================
  private async resolvePhoneFromLid(
    lidJid?: string | null,
    key?: any
  ): Promise<{ phone: string; jid: string; source: string } | null> {
    try {
      const lid = normalizeLidJid(lidJid) || String(lidJid || '').trim();
      if (!lid || !isLidJid(lid)) return null;

      const possibleAltValues = [
        key?.remoteJidAlt,
        key?.participantAlt,
        key?.senderPn,
        key?.participantPn,
        key?.remoteJidPn,
        key?.chatPn,
        key?.authorPn,
      ];

      for (const item of possibleAltValues) {
        if (item && isPnJid(item)) {
          const phone = this.normalizePhoneCandidate(item);
          if (phone) {
            return { phone, jid: `${phone}@s.whatsapp.net`, source: 'message_key_alt' };
          }
        }
      }

      const repo = (this.sock as any)?.signalRepository;
      const lidMapping = repo?.lidMapping;

      if (!lidMapping || typeof lidMapping.getPNForLID !== 'function') {
        logger.debug({ lid }, '[LID] lidMapping no disponible');
        return null;
      }

      const result = await lidMapping.getPNForLID(lid);
      if (!result) {
        logger.debug({ lid }, '[LID] sin resultado getPNForLID');
        return null;
      }

      const value =
        typeof result === 'string'
          ? result
          : result?.jid || result?.pn || result?.phoneNumber || '';

      const phone = this.normalizePhoneCandidate(value);
      if (!phone) {
        logger.debug({ lid, result }, '[LID] getPNForLID devolvió valor no usable');
        return null;
      }

      return { phone, jid: `${phone}@s.whatsapp.net`, source: 'signalRepository.lidMapping' };
    } catch (err) {
      logger.warn({ err, lidJid }, '[LID] error resolviendo LID');
      return null;
    }
  }

  private async completeIdentifiersFromBaileys(
    ids: ReturnType<typeof extractIdentifiers>,
    key?: any
  ) {
    if (ids.phone || !ids.lid) return ids;

    const resolved = await this.resolvePhoneFromLid(ids.lid, key);

    if (!resolved) {
      logger.info(
        { lid: ids.lid, raw_jid: ids.raw_jid },
        '[LID] no se pudo completar teléfono; se enviará solo LID'
      );
      return ids;
    }

    ids.phone = resolved.phone;
    ids.jid = resolved.jid;
    if (!ids.alt_jid) ids.alt_jid = resolved.jid;

    logger.info(
      { lid: ids.lid, phone: ids.phone, jid: ids.jid, source: resolved.source },
      '[LID] teléfono completado'
    );

    return ids;
  }

  private async getSendTimeoutMs(defaultValue: number) {
    const configured = await getNumberConfig('WHATSAPP_SEND_TIMEOUT_MS');
    return configured && configured > 0 ? configured : defaultValue;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async sendMessageSafe(
    jid: string,
    payload: any,
    options: SendMessageSafeOptions = {}
  ) {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp no conectado');
    }

    const timeoutMs =
      options.timeoutMs ||
      (await this.getSendTimeoutMs(options.messageType === 'text' ? 30000 : 60000));

    const startedAt = Date.now();

    logger.info(
      {
        jid,
        traceId: options.traceId || '',
        outboxId: options.outboxId || false,
        messageType: options.messageType || 'unknown',
        timeoutMs,
      },
      '[WA-OUT] iniciando envío'
    );

    await this.createTraceLog({
      type: 'whatsapp.outgoing.attempt',
      status: 'pending',
      phone: isLidJid(jid) ? null : cleanPhone(jid),
      jid: isLidJid(jid) ? null : jid,
      lid: isLidJid(jid) ? jid : null,
      rawJid: jid,
      payload: {
        traceId: options.traceId || '',
        outboxId: options.outboxId || false,
        messageType: options.messageType || 'unknown',
        timeoutMs,
      },
    });

    try {
      const resp = await this.withTimeout(
        this.sock.sendMessage(jid, payload),
        timeoutMs,
        `Timeout enviando mensaje WhatsApp a ${jid}`
      );

      const externalMessageId = resp?.key?.id || '';
      if (!externalMessageId) {
        throw new Error(`Baileys no devolvió externalMessageId para ${jid}`);
      }

      this.markBotMessageId(externalMessageId);
      this.cacheMessage(externalMessageId, resp?.message);

      logger.info(
        {
          jid,
          traceId: options.traceId || '',
          outboxId: options.outboxId || false,
          externalMessageId,
          elapsedMs: Date.now() - startedAt,
        },
        '[WA-OUT] mensaje confirmado por Baileys'
      );

      await this.createTraceLog({
        type: 'whatsapp.outgoing.success',
        status: 'success',
        phone: isLidJid(jid) ? null : cleanPhone(jid),
        jid: isLidJid(jid) ? null : jid,
        lid: isLidJid(jid) ? jid : null,
        rawJid: jid,
        payload: {
          traceId: options.traceId || '',
          outboxId: options.outboxId || false,
          messageType: options.messageType || 'unknown',
        },
        response: { externalMessageId, elapsedMs: Date.now() - startedAt },
      });

      return resp;
    } catch (err: any) {
      const serialized = this.serializeError(err);

      logger.error(
        {
          err: serialized,
          jid,
          traceId: options.traceId || '',
          outboxId: options.outboxId || false,
          elapsedMs: Date.now() - startedAt,
        },
        '[WA-OUT] error enviando mensaje por Baileys'
      );

      await this.createTraceLog({
        type: 'whatsapp.outgoing.error',
        status: 'error',
        phone: isLidJid(jid) ? null : cleanPhone(jid),
        jid: isLidJid(jid) ? null : jid,
        lid: isLidJid(jid) ? jid : null,
        rawJid: jid,
        payload: {
          traceId: options.traceId || '',
          outboxId: options.outboxId || false,
          messageType: options.messageType || 'unknown',
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
        },
        error: serialized.message,
        response: serialized,
      });

      throw err;
    }
  }

  private async traceOutboxFailure(params: {
    outboxId?: number | false | null;
    jid?: string | null;
    traceId?: string;
    error: any;
  }) {
    if (!params.outboxId) return;

    const serialized = this.serializeError(params.error);

    logger.error(
      {
        outboxId: params.outboxId,
        jid: params.jid || '',
        traceId: params.traceId || '',
        error: serialized,
      },
      '[ODOO-OUTBOX] fallo al enviar respuesta WhatsApp'
    );

    await this.createTraceLog({
      type: 'odoo.outbox.send_failed',
      status: 'error',
      phone: params.jid && !isLidJid(params.jid) ? cleanPhone(params.jid) : null,
      jid: params.jid && !isLidJid(params.jid) ? params.jid : null,
      lid: params.jid && isLidJid(params.jid) ? params.jid : null,
      rawJid: params.jid || null,
      payload: { outboxId: params.outboxId, traceId: params.traceId || '' },
      error: serialized.message,
      response: serialized,
    });
  }

  private async persistRawProto(
    externalMessageId: string | null | undefined,
    message: proto.IMessage | null | undefined
  ) {
    if (!externalMessageId || !message) return;

    try {
      const serialized = JSON.stringify(message);
      await prisma.messageLog.updateMany({
        where: { externalMessageId },
        data: { rawProto: serialized } as any,
      });
      logger.debug({ externalMessageId }, '[WA-CACHE] rawProto persistido en BD');
    } catch (err) {
      logger.debug(
        { err: this.serializeError(err), externalMessageId },
        '[WA-CACHE] no se pudo persistir rawProto (¿falta campo en schema?)'
      );
    }
  }

  // ==================================================
  // INITIALIZE
  //
  // v7 + Prisma auth state:
  //   - usePostgresAuthState(prisma) reemplaza useMultiFileAuthState.
  //     Persiste creds + todas las claves Signal (incluyendo las nuevas
  //     de v7: lid-mapping, device-list, tctoken) en PostgreSQL.
  //   - forceNew=true limpia la sesión completa de la BD (clearAll)
  //     antes de reinicializar con creds frescas.
  //   - saveCreds se guarda en this.saveCreds para reutilizarlo en
  //     reconexiones sin re-instanciar el auth state.
  //   - version omitido → Baileys v7 lo gestiona internamente.
  //     Ref: https://baileys.wiki/docs/socket/configuration#version
  // ==================================================
  async initialize(forceNew = false) {
    // Si forceNew, borrar toda la sesión de la BD antes de arrancar.
    if (forceNew) {
      const { clearAll } = await usePostgresAuthState(prisma);
      await clearAll();
      logger.info('[WA] sesión anterior eliminada de BD (forceNew=true)');
    }

    const { state, saveCreds } = await usePostgresAuthState(prisma);

    // Guardar saveCreds en la instancia para reutilizarlo en reconexiones.
    this.saveCreds = saveCreds;

    logger.info({ forceNew }, 'Iniciando Baileys v7 con auth state PostgreSQL');

    // ─────────────────────────────────────────────────────────────────────
    // browser: Browsers.macOS('Desktop') → recibir history sync completo.
    // Ref: https://baileys.wiki/docs/socket/configuration#syncfullhistory
    //
    // markOnlineOnConnect: false → no marcar online al conectar para
    // evitar perder notificaciones en el móvil.
    // Ref: https://baileys.wiki/docs/socket/configuration#markonlineonconnect
    //
    // getMessage: devuelve undefined cuando no puede recuperar el proto.
    // NUNCA devolver proto vacío con sesión en pendingPreKey (@lid).
    // Ref: https://baileys.wiki/docs/socket/configuration#getmessage
    // ─────────────────────────────────────────────────────────────────────
    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },

      logger: logger as any,

      browser: Browsers.macOS('Desktop'),

      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,

      getMessage: async (key: any) => this.getMessageForRetry(key),

      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      defaultQueryTimeoutMs: 60000,
    });

    // Persistir creds cada vez que Baileys las actualiza.
    this.sock.ev.on('creds.update', async () => {
      if (this.saveCreds) {
        await this.saveCreds();
      }
    });

    // ─────────────────────────────────────────────────────────────────────
    // lid-mapping.update (nuevo en v7)
    //
    // Emitido cuando el dispositivo principal envía nuevos mapeos LID↔PN.
    // El auth state de Prisma los persiste automáticamente a través de
    // keys.set('lid-mapping', ...) — este listener es solo para logging.
    // Ref: https://baileys.wiki/docs/migration/to-v7.0.0#lids
    // ─────────────────────────────────────────────────────────────────────
    this.sock.ev.on('lid-mapping.update', (mappings) => {
      logger.info(
        { count: Array.isArray(mappings) ? mappings.length : 1 },
        '[LID] lid-mapping.update recibido; mapeo LID↔PN persistido en BD'
      );
    });

    // messaging-history.set: cachear mensajes históricos para getMessage.
    // Ref: https://baileys.wiki/docs/socket/history-sync
    this.sock.ev.on('messaging-history.set', ({ messages, syncType }) => {
      const total = messages?.length || 0;
      logger.info({ syncType, total }, '[WA-HISTORY] cacheando mensajes históricos');

      let cached = 0;
      let skipped = 0;

      for (const msg of messages || []) {
        const id = msg.key?.id;
        const message = msg.message;
        if (id && message) {
          this.cacheMessage(id, message);
          cached++;
        } else {
          skipped++;
        }
      }

      logger.info({ syncType, total, cached, skipped }, '[WA-HISTORY] mensajes cacheados');
    });

    this.sock.ev.on(
      'connection.update',
      async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          this.currentQR = qr;
          try {
            this.qrDataURL = await QRCode.toDataURL(qr);
            logger.info('QR disponible en /api/qr');
          } catch (err) {
            logger.error({ err }, '[WA-AUTH] error generando QR DataURL');
          }
        }

        if (connection === 'connecting') {
          logger.info(
            { retryCount: this.retryCount, hasQR: !!this.currentQR },
            '[WA-CONN] conectando a WhatsApp'
          );
        }

        if (connection === 'open') {
          this.ready = true;
          this.currentQR = null;
          this.qrDataURL = null;
          this.retryCount = 0;

          logger.info(
            {
              user: this.sock?.user,
              browser: 'macOS Desktop',
              markOnlineOnConnect: false,
              keepAliveIntervalMs: 15000,
            },
            'WhatsApp conectado (Baileys v7 + auth PostgreSQL)'
          );

          await this.createTraceLog({
            type: 'whatsapp.connection.open',
            status: 'success',
            payload: {
              user: this.sock?.user || null,
              browser: 'macOS Desktop',
              markOnlineOnConnect: false,
            },
          });
        }

        if (connection === 'close') {
          this.ready = false;

          const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const errorMessage = (lastDisconnect?.error as any)?.message || '';

          logger.warn(
            { code, error: errorMessage, retryCount: this.retryCount },
            'WhatsApp desconectado'
          );

          await this.createTraceLog({
            type: 'whatsapp.connection.close',
            status: 'error',
            payload: { code, error: errorMessage, retryCount: this.retryCount },
            error: errorMessage || `Disconnect code ${code || 'unknown'}`,
          });

          if (code === DisconnectReason.restartRequired) {
            logger.info({ code }, '[WA-CONN] restartRequired, reconectando');
            return this.scheduleReconnect(false);
          }

          if (code === DisconnectReason.loggedOut) {
            logger.warn({ code }, '[WA-CONN] loggedOut, forzando nueva sesión');
            return this.scheduleReconnect(true);
          }

          if (code === 405) {
            logger.error(
              { code, error: errorMessage },
              'Error 405. No se reconecta para evitar bloqueo.'
            );
            return;
          }

          this.scheduleReconnect(false);
        }
      }
    );

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.info(
        {
          type,
          count: messages?.length || 0,
          messages: (messages || []).map((m) => ({
            id: m.key?.id,
            remoteJid: m.key?.remoteJid,
            participant: m.key?.participant,
            remoteJidAlt: (m.key as any)?.remoteJidAlt,
            participantAlt: (m.key as any)?.participantAlt,
            fromMe: m.key?.fromMe,
            hasMessage: !!m.message,
            keys: m.message ? Object.keys(m.message as any) : [],
            stubType: (m as any).messageStubType,
          })),
        },
        '[WA-IN] messages.upsert recibido'
      );

      // Cachear todos los mensajes (cualquier type) para getMessage.
      for (const m of messages || []) {
        this.cacheMessage(m.key?.id, m.message);
      }

      // Solo procesar 'notify' para lógica de negocio.
      if (type !== 'notify') {
        logger.debug({ type }, '[WA-IN] upsert ignorado por tipo (solo cacheado)');
        return;
      }

      for (const msg of messages || []) {
        await this.handleIncomingMessage(msg);
      }
    });

    logger.info(
      {
        browser: 'macOS Desktop',
        markOnlineOnConnect: false,
        syncFullHistory: true,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 15000,
        authState: 'PostgreSQL',
      },
      '[WA] Cliente Baileys v7 inicializado'
    );
  }

  async requestPairingCode(phone: string) {
    if (!this.sock) throw new Error('Socket no inicializado');

    const clean = phone.replace(/\D+/g, '');
    if (!clean) throw new Error('Teléfono inválido para pairing code');

    logger.info({ phone: clean }, '[WA-AUTH] solicitando pairing code');

    return this.sock.requestPairingCode(clean);
  }

  async disconnect(logout = false) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    logger.info(
      { logout, connected: this.ready, hasSocket: !!this.sock },
      '[WA] desconectando socket'
    );

    if (this.sock) {
      if (logout) {
        await this.sock.logout().catch((err) => {
          logger.warn({ err }, '[WA] error haciendo logout');
          return undefined;
        });
      } else {
        this.sock.end(undefined);
      }
    }

    this.sock = null;
    this.ready = false;
    this.saveCreds = null;
  }

  async getGroups() {
    if (!this.sock || !this.ready) throw new Error('WhatsApp no conectado');

    const rawGroups = await this.sock.groupFetchAllParticipating();

    // v7: owner es ahora LID; ownerPn tiene el PN asociado.
    const groups = Object.values(rawGroups || {}).map((group: any) => ({
      id: group.id,
      name: group.subject || group.name || group.id,
      subject: group.subject || group.name || group.id,
      participants_count: Array.isArray(group.participants) ? group.participants.length : 0,
      owner: group.owner || false,
      creation: group.creation || false,
    }));

    groups.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return groups;
  }

  async sendText(
    to: string,
    message: string,
    options: SendMessageSafeOptions = {}
  ) {
    if (!this.sock || !this.ready) throw new Error('WhatsApp no conectado');

    const text = String(message || '').trim();
    if (!text) throw new Error('Mensaje vacío');

    const jid = jidFromTo(to);
    const traceId = options.traceId || `text-${Date.now()}`;

    const resp = await this.sendMessageSafe(
      jid,
      { text },
      {
        ...options,
        traceId,
        messageType: 'text',
        timeoutMs: options.timeoutMs || (await this.getSendTimeoutMs(30000)),
      }
    );

    this.markBotMessageId(resp?.key?.id);
    this.cacheMessage(resp?.key?.id, resp?.message);

    const externalMessageId = resp?.key?.id || null;

    await prisma.messageLog.create({
      data: {
        direction: 'out',
        chatType: isGroupJid(jid) ? 'group' : 'private',
        phone: isLidJid(jid) ? null : cleanPhone(jid) || to,
        jid: isLidJid(jid) ? null : jid,
        lid: isLidJid(jid) ? jid : null,
        rawJid: jid,
        messageType: 'text',
        content: text,
        externalMessageId,
      },
    });

    await this.persistRawProto(externalMessageId, resp?.message);

    logger.info(
      { to: jid, traceId, outboxId: options.outboxId || false, externalMessageId: resp?.key?.id },
      'Mensaje de texto enviado'
    );

    return resp;
  }

  async sendMedia(params: {
    to: string;
    media_type: 'image' | 'audio' | 'video' | 'document';
    url?: string;
    base64?: string;
    mimetype?: string;
    filename?: string;
    caption?: string;
    traceId?: string;
    outboxId?: number | false | null;
  }) {
    if (!this.sock || !this.ready) throw new Error('WhatsApp no conectado');

    const jid = jidFromTo(params.to);
    const traceId = params.traceId || `media-${params.media_type}-${Date.now()}`;

    let buffer: Buffer;
    let mimetype = params.mimetype || 'application/octet-stream';

    logger.info(
      {
        jid,
        traceId,
        outboxId: params.outboxId || false,
        mediaType: params.media_type,
        hasUrl: !!params.url,
        hasBase64: !!params.base64,
        filename: params.filename || '',
      },
      '[WA-OUT] preparando multimedia'
    );

    if (params.url) {
      const downloaded = await getBufferFromUrl(params.url);
      buffer = downloaded.buffer;
      mimetype = params.mimetype || downloaded.mimetype;
    } else if (params.base64) {
      buffer = getBufferFromBase64(params.base64);
    } else {
      throw new Error('Debe enviar url o base64');
    }

    let resp: any;
    const timeoutMs = await this.getSendTimeoutMs(60000);

    if (params.media_type === 'image') {
      resp = await this.sendMessageSafe(
        jid,
        { image: buffer, caption: params.caption || '' },
        { traceId, outboxId: params.outboxId || false, messageType: 'image', timeoutMs }
      );
    } else if (params.media_type === 'audio') {
      resp = await this.sendMessageSafe(
        jid,
        { audio: buffer, mimetype },
        { traceId, outboxId: params.outboxId || false, messageType: 'audio', timeoutMs }
      );
    } else if (params.media_type === 'video') {
      resp = await this.sendMessageSafe(
        jid,
        { video: buffer, caption: params.caption || '' },
        { traceId, outboxId: params.outboxId || false, messageType: 'video', timeoutMs }
      );
    } else {
      resp = await this.sendMessageSafe(
        jid,
        {
          document: buffer,
          mimetype,
          fileName: params.filename || 'archivo',
          caption: params.caption || '',
        },
        { traceId, outboxId: params.outboxId || false, messageType: 'document', timeoutMs }
      );
    }

    this.markBotMessageId(resp?.key?.id);
    this.cacheMessage(resp?.key?.id, resp?.message);

    const externalMessageId = resp?.key?.id || null;

    await prisma.messageLog.create({
      data: {
        direction: 'out',
        chatType: isGroupJid(jid) ? 'group' : 'private',
        phone: isLidJid(jid) ? null : cleanPhone(jid) || params.to,
        jid: isLidJid(jid) ? null : jid,
        lid: isLidJid(jid) ? jid : null,
        rawJid: jid,
        messageType: params.media_type,
        content: params.caption || '',
        externalMessageId,
        mimetype,
      },
    });

    await this.persistRawProto(externalMessageId, resp?.message);

    logger.info(
      {
        to: jid,
        traceId,
        outboxId: params.outboxId || false,
        mediaType: params.media_type,
        mimetype,
        externalMessageId: resp?.key?.id,
      },
      'Multimedia enviado'
    );

    return resp;
  }

  private async buildMediaPayload(message: proto.IWebMessageInfo, messageType: string) {
    if (!['image', 'audio', 'video', 'document', 'sticker'].includes(messageType)) {
      return null;
    }

    const mimetype = getMimeType(message);
    const filename = getFileName(message);

    if (!this.sock) throw new Error('Socket no inicializado para descargar media');

    const buffer = (await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: async (msg) => this.sock!.updateMediaMessage(msg),
      }
    )) as Buffer;

    const saved = await saveIncomingMedia(buffer, mimetype, filename);

    return {
      media_type: messageType,
      mimetype: saved.mimetype,
      filename: saved.filename,
      url: saved.url,
      base64: await maybeBase64(buffer),
      size: buffer.length,
    };
  }

  private async reportGroup(
    message: proto.IWebMessageInfo,
    remoteJid: string,
    text: string,
    messageType: string
  ) {
    if (!(await getBooleanConfig('REPORT_GROUPS_TO_WEBHOOK'))) return;

    await postToInboundWebhook({
      source: 'baileys_gateway',
      chat_type: 'group',
      should_ignore: true,
      group_jid: remoteJid,
      raw_jid: remoteJid,
      message: text,
      message_type: messageType,
      message_id: message.key?.id || '',
      push_name: message.pushName || '',
      timestamp: new Date(this.getTimestampMs(message)).toISOString(),
    }).catch((err) => logger.warn({ err }, 'No se pudo reportar grupo al webhook'));
  }

  private async handleIncomingMessage(message: proto.IWebMessageInfo) {
    const messageId = message.key?.id || '';
    const remoteJid = this.getRemoteJid(message);
    const traceId = `in-${messageId || Date.now()}`;

    try {
      this.cacheMessage(messageId, message.message);

      logger.info(
        {
          traceId,
          messageId,
          remoteJid,
          fromMe: message.key?.fromMe || false,
          participant: message.key?.participant || '',
          remoteJidAlt: (message.key as any)?.remoteJidAlt,
          participantAlt: (message.key as any)?.participantAlt,
          hasMessage: !!message.message,
          keys: message.message ? Object.keys(message.message as any) : [],
        },
        '[WA-IN] mensaje recibido'
      );

      if (this.getTimestampMs(message) < this.startTime - 15000) {
        logger.info({ traceId, messageId }, '[WA-IN] mensaje antiguo ignorado');
        return;
      }

      if (!remoteJid || remoteJid === 'status@broadcast') {
        logger.info({ traceId, messageId, remoteJid }, '[WA-IN] jid vacío/status ignorado');
        return;
      }

      if (message.key?.fromMe) {
        logger.info({ traceId, messageId, remoteJid }, '[WA-IN] mensaje propio ignorado');
        return;
      }

      if (this.isFromBotById(messageId)) {
        logger.info({ traceId, messageId, remoteJid }, '[WA-IN] mensaje bot ignorado');
        return;
      }

      if (this.isInternalOrUnsupportedMessage(message)) {
        logger.info({ traceId, messageId, remoteJid }, '[WA-IN] mensaje interno/no soportado ignorado');
        return;
      }

      const text = extractText(message).trim();
      const messageType = getMessageType(message);

      if (isGroupJid(remoteJid)) {
        if (await getBooleanConfig('IGNORE_GROUPS')) {
          logger.info({ traceId, remoteJid }, '[WA-IN] grupo ignorado');
          await this.reportGroup(message, remoteJid, text, messageType);
          return;
        }
      }

      const rawIds = extractIdentifiers(remoteJid, message.key);
      const ids = await this.completeIdentifiersFromBaileys(rawIds, message.key);

      logger.info(
        {
          traceId,
          messageId,
          remoteJid,
          phone: ids.phone,
          jid: ids.jid,
          lid: ids.lid,
          raw_jid: ids.raw_jid,
          alt_jid: ids.alt_jid,
          messageType,
          text,
        },
        '[WA-IN] mensaje normalizado'
      );

      const media = await this.buildMediaPayload(message, messageType).catch((err) => {
        logger.error({ err, traceId, messageId }, '[WA-IN] error descargando media');
        return null;
      });

      const finalText = text || (media ? `[El usuario envió ${messageType}]` : '');

      if (!finalText && !media) {
        logger.info({ traceId, messageId, messageType }, '[WA-IN] sin texto ni media, ignorado');
        return;
      }

      await prisma.messageLog.create({
        data: {
          direction: 'in',
          chatType: isGroupJid(remoteJid) ? 'group' : 'private',
          phone: ids.phone || null,
          jid: ids.jid || null,
          lid: ids.lid || null,
          rawJid: ids.raw_jid || null,
          messageType,
          content: finalText,
          externalMessageId: messageId || null,
          mediaUrl: media?.url || null,
          mimetype: media?.mimetype || null,
        },
      });

      const inboundPayload = {
        source: 'baileys_gateway',
        chat_type: isGroupJid(remoteJid) ? 'group' : 'private',
        phone: ids.phone,
        from: remoteJid,
        jid: ids.jid,
        lid: ids.lid,
        raw_jid: ids.raw_jid,
        alt_jid: ids.alt_jid,
        message: finalText,
        message_type: messageType,
        message_id: messageId,
        push_name: message.pushName || '',
        timestamp: new Date(this.getTimestampMs(message)).toISOString(),
        media,
      };

      logger.info(
        { traceId, messageId, phone: ids.phone, jid: ids.jid, lid: ids.lid, message: finalText },
        '[WA-IN] enviando a webhook n8n/Odoo'
      );

      const response = await postToInboundWebhook(inboundPayload);

      logger.info(
        {
          traceId,
          messageId,
          ok: response?.ok,
          shouldSend: response?.shouldSend,
          outbox_id: response?.outbox_id,
          odoo_message_id: response?.odoo_message_id,
          hasMessage: !!response?.message,
        },
        '[WA-IN] respuesta webhook n8n/Odoo'
      );

      if (!response?.ok || !response.shouldSend) {
        logger.info({ traceId, messageId }, '[WA-IN] webhook no pidió responder');
        return;
      }

      const responseText = String(response.message || '').trim();

      if (!responseText) {
        logger.info({ traceId, messageId }, '[WA-IN] webhook sin texto de respuesta');
        return;
      }

      try {
        const sent = await this.sendText(remoteJid, responseText, {
          traceId: `${traceId}-reply`,
          outboxId: response.outbox_id || false,
          timeoutMs: await this.getSendTimeoutMs(30000),
        });

        logger.info(
          {
            traceId,
            messageId,
            externalMessageId: sent?.key?.id,
            outbox_id: response.outbox_id,
          },
          '[WA-IN] respuesta enviada por WhatsApp'
        );

        if (response.outbox_id) {
          await markOdooOutboxSent(Number(response.outbox_id), sent?.key?.id || '');

          logger.info(
            { traceId, outbox_id: response.outbox_id, externalMessageId: sent?.key?.id || '' },
            '[ODOO-OUTBOX] marcado como enviado'
          );
        }
      } catch (sendErr) {
        await this.traceOutboxFailure({
          outboxId: response.outbox_id || false,
          jid: remoteJid,
          traceId,
          error: sendErr,
        });
        throw sendErr;
      }
    } catch (err) {
      logger.error(
        {
          err: this.serializeError(err),
          traceId,
          messageId,
          remoteJid,
          keys: message.message ? Object.keys(message.message as any) : [],
        },
        '[WA-IN] Error manejando mensaje'
      );
    }
  }
}

export const whatsapp = new WhatsAppGateway();