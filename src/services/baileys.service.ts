import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WASocket,
} from 'baileys';
import { Boom } from '@hapi/boom';

import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { extractIdentifiers, isGroupJid, jidFromTo } from '../utils/jid.js';
import {
  extractText,
  getFileName,
  getMessageType,
  getMimeType,
} from '../utils/message.js';
import { getBooleanConfig, getConfigValue } from './config.service.js';
import {
  maybeBase64,
  saveIncomingMedia,
  getBufferFromBase64,
  getBufferFromUrl,
} from './media.service.js';
import { postToInboundWebhook } from './webhook.service.js';
import { markOdooOutboxSent } from './odoo.service.js';

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

  private cacheMessage(id?: string | null, message?: proto.IMessage | null) {
    if (!id || !message) return;

    this.messageCache.set(id, {
      message,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    if (this.messageCache.size > 1000) {
      this.cleanupMessageCache();
    }
  }

  private cleanupMessageCache() {
    const now = Date.now();

    for (const [id, item] of this.messageCache.entries()) {
      if (item.expiresAt <= now) {
        this.messageCache.delete(id);
      }
    }

    if (this.messageCache.size > 1000) {
      const excess = this.messageCache.size - 1000;
      const ids = Array.from(this.messageCache.keys()).slice(0, excess);

      for (const id of ids) {
        this.messageCache.delete(id);
      }
    }
  }

  private async getMessageForRetry(key: any): Promise<proto.IMessage | undefined> {
    try {
      const messageId = key?.id || '';

      if (!messageId) {
        return undefined;
      }

      const cached = this.messageCache.get(messageId);

      if (cached) {
        if (cached.expiresAt > Date.now()) {
          return cached.message;
        }

        this.messageCache.delete(messageId);
      }

      const logged = await prisma.messageLog.findFirst({
        where: {
          externalMessageId: messageId,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      if (!logged?.content) {
        logger.debug({ messageId }, '[WA] getMessage sin registro local');
        return undefined;
      }

      if (logged.messageType === 'text') {
        return {
          conversation: logged.content,
        };
      }

      logger.debug(
        {
          messageId,
          messageType: logged.messageType,
        },
        '[WA] getMessage encontrado pero no reconstruible como texto'
      );

      return undefined;
    } catch (err) {
      logger.warn({ err, key }, '[WA] error en getMessageForRetry');
      return undefined;
    }
  }

  private async getAuthDir() {
    const dir = path.resolve(
      (await getConfigValue('AUTH_DIR')) || './storage/auth'
    );

    fs.mkdirSync(dir, { recursive: true });

    return dir;
  }

  private scheduleReconnect(forceNew = false) {
    if (this.retryCount >= 10) {
      logger.error('Se alcanzó el límite de reintentos de WhatsApp');
      return;
    }

    const delay = Math.min(3000 * Math.pow(2, this.retryCount), 60000);
    this.retryCount += 1;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    logger.info(
      {
        retryCount: this.retryCount,
        delayMs: delay,
        forceNew,
      },
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

    if (!raw || Object.keys(raw).length === 0) {
      return true;
    }

    if (raw.protocolMessage) return true;
    if (raw.senderKeyDistributionMessage) return true;
    if (raw.messageContextInfo && Object.keys(raw).length === 1) return true;

    if ((message as any).messageStubType) {
      return true;
    }

    return false;
  }

  private getRemoteJid(message: proto.IWebMessageInfo) {
    return (
      message.key?.remoteJid ||
      message.key?.participant ||
      ''
    );
  }

  private getTimestampMs(message: proto.IWebMessageInfo) {
    const raw = Number(message.messageTimestamp || 0);

    if (!raw) return Date.now();

    if (raw > 1000000000000) {
      return raw;
    }

    return raw * 1000;
  }

  async initialize(forceNew = false) {
    const authDir = await this.getAuthDir();

    if (forceNew && fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(
      {
        version: version.join('.'),
        authDir,
      },
      'Iniciando Baileys'
    );

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      logger: logger as any,
      browser: Browsers.macOS('Google Chrome'),
      printQRInTerminal: false,

      /*
       * Se mantiene sin sincronizar historial completo para no alterar tu lógica.
       * Solo se mejora la sesión activa y la recuperación de mensajes para retry.
       */
      markOnlineOnConnect: true,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,

      /*
       * Antes devolvía siempre undefined.
       * Esto ayuda a Baileys cuando WhatsApp pide reintento/contexto de mensaje.
       */
      getMessage: async (key: any) => {
        return this.getMessageForRetry(key);
      },

      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      defaultQueryTimeoutMs: 60000,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on(
      'connection.update',
      async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          this.currentQR = qr;
          this.qrDataURL = await QRCode.toDataURL(qr);
          logger.info('QR disponible en /api/qr');
        }

        if (connection === 'open') {
          this.ready = true;
          this.currentQR = null;
          this.qrDataURL = null;
          this.retryCount = 0;

          logger.info(
            {
              user: this.sock?.user,
            },
            'WhatsApp conectado'
          );
        }

        if (connection === 'close') {
          this.ready = false;

          const code = (lastDisconnect?.error as Boom)?.output?.statusCode;

          logger.warn(
            {
              code,
              error: (lastDisconnect?.error as any)?.message,
            },
            'WhatsApp desconectado'
          );

          if (code === DisconnectReason.restartRequired) {
            return this.scheduleReconnect(false);
          }

          if (code === DisconnectReason.loggedOut) {
            return this.scheduleReconnect(true);
          }

          if (code === 405) {
            logger.error(
              'Error 405 WhatsApp. No se reconecta para evitar bloqueo.'
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
            fromMe: m.key?.fromMe,
            hasMessage: !!m.message,
            keys: m.message ? Object.keys(m.message as any) : [],
            stubType: (m as any).messageStubType,
          })),
        },
        '[WA-IN] messages.upsert recibido'
      );

      if (type !== 'notify') {
        logger.debug({ type }, '[WA-IN] upsert ignorado por tipo');
        return;
      }

      for (const msg of messages || []) {
        this.cacheMessage(msg.key?.id, msg.message);
        await this.handleIncomingMessage(msg);
      }
    });
  }

  async requestPairingCode(phone: string) {
    if (!this.sock) {
      throw new Error('Socket no inicializado');
    }

    const clean = phone.replace(/\D+/g, '');

    if (!clean) {
      throw new Error('Teléfono inválido para pairing code');
    }

    return this.sock.requestPairingCode(clean);
  }

  async disconnect(logout = false) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      if (logout) {
        await this.sock.logout().catch(() => undefined);
      } else {
        this.sock.end(undefined);
      }
    }

    this.sock = null;
    this.ready = false;
  }

  async getGroups() {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp no conectado');
    }

    const rawGroups = await this.sock.groupFetchAllParticipating();
    const groups = Object.values(rawGroups || {}).map((group: any) => {
      return {
        id: group.id,
        name: group.subject || group.name || group.id,
        subject: group.subject || group.name || group.id,
        participants_count: Array.isArray(group.participants)
          ? group.participants.length
          : 0,
        owner: group.owner || false,
        creation: group.creation || false,
      };
    });

    groups.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return groups;
  }

  async sendText(to: string, message: string) {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp no conectado');
    }

    const jid = jidFromTo(to);

    const resp = await this.sock.sendMessage(jid, {
      text: message,
    });

    this.markBotMessageId(resp?.key?.id);
    this.cacheMessage(resp?.key?.id, resp?.message);

    await prisma.messageLog.create({
      data: {
        direction: 'out',
        chatType: isGroupJid(jid) ? 'group' : 'private',
        phone: jid.includes('@') ? jid.split('@')[0] : to,
        jid,
        rawJid: jid,
        messageType: 'text',
        content: message,
        externalMessageId: resp?.key?.id || null,
      },
    });

    logger.info(
      {
        to: jid,
        externalMessageId: resp?.key?.id,
      },
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
  }) {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp no conectado');
    }

    const jid = jidFromTo(params.to);

    let buffer: Buffer;
    let mimetype = params.mimetype || 'application/octet-stream';

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

    if (params.media_type === 'image') {
      resp = await this.sock.sendMessage(jid, {
        image: buffer,
        caption: params.caption || '',
      });
    } else if (params.media_type === 'audio') {
      resp = await this.sock.sendMessage(jid, {
        audio: buffer,
        mimetype,
      });
    } else if (params.media_type === 'video') {
      resp = await this.sock.sendMessage(jid, {
        video: buffer,
        caption: params.caption || '',
      });
    } else {
      resp = await this.sock.sendMessage(jid, {
        document: buffer,
        mimetype,
        fileName: params.filename || 'archivo',
        caption: params.caption || '',
      });
    }

    this.markBotMessageId(resp?.key?.id);
    this.cacheMessage(resp?.key?.id, resp?.message);

    await prisma.messageLog.create({
      data: {
        direction: 'out',
        chatType: isGroupJid(jid) ? 'group' : 'private',
        phone: jid.includes('@') ? jid.split('@')[0] : params.to,
        jid,
        rawJid: jid,
        messageType: params.media_type,
        content: params.caption || '',
        externalMessageId: resp?.key?.id || null,
        mimetype,
      },
    });

    logger.info(
      {
        to: jid,
        mediaType: params.media_type,
        mimetype,
        externalMessageId: resp?.key?.id,
      },
      'Multimedia enviado'
    );

    return resp;
  }

  private async buildMediaPayload(
    message: proto.IWebMessageInfo,
    messageType: string
  ) {
    if (
      !['image', 'audio', 'video', 'document', 'sticker'].includes(messageType)
    ) {
      return null;
    }

    const mimetype = getMimeType(message);
    const filename = getFileName(message);

    if (!this.sock) {
      throw new Error('Socket no inicializado para descargar media');
    }

    const buffer = (await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: async (msg) => {
          return this.sock!.updateMediaMessage(msg);
        },
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
    if (!(await getBooleanConfig('REPORT_GROUPS_TO_WEBHOOK'))) {
      return;
    }

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
    }).catch((err) =>
      logger.warn({ err }, 'No se pudo reportar grupo al webhook')
    );
  }

  private async handleIncomingMessage(message: proto.IWebMessageInfo) {
    const messageId = message.key?.id || '';
    const remoteJid = this.getRemoteJid(message);

    try {
      this.cacheMessage(messageId, message.message);

      logger.info(
        {
          messageId,
          remoteJid,
          fromMe: message.key?.fromMe || false,
          participant: message.key?.participant || '',
          hasMessage: !!message.message,
          keys: message.message ? Object.keys(message.message as any) : [],
        },
        '[WA-IN] mensaje recibido'
      );

      if (this.getTimestampMs(message) < this.startTime - 15000) {
        logger.info({ messageId }, '[WA-IN] mensaje antiguo ignorado');
        return;
      }

      if (!remoteJid || remoteJid === 'status@broadcast') {
        logger.info({ messageId, remoteJid }, '[WA-IN] jid vacío/status ignorado');
        return;
      }

      if (message.key?.fromMe) {
        logger.info({ messageId, remoteJid }, '[WA-IN] mensaje propio ignorado');
        return;
      }

      if (this.isFromBotById(messageId)) {
        logger.info({ messageId, remoteJid }, '[WA-IN] mensaje enviado por bot ignorado');
        return;
      }

      if (this.isInternalOrUnsupportedMessage(message)) {
        logger.info(
          {
            messageId,
            remoteJid,
            keys: message.message ? Object.keys(message.message as any) : [],
          },
          '[WA-IN] mensaje interno/no soportado ignorado'
        );
        return;
      }

      const text = extractText(message).trim();
      const messageType = getMessageType(message);

      if (isGroupJid(remoteJid)) {
        if (await getBooleanConfig('IGNORE_GROUPS')) {
          logger.info({ remoteJid }, '[WA-IN] grupo ignorado');
          await this.reportGroup(message, remoteJid, text, messageType);
          return;
        }
      }

      const ids = extractIdentifiers(remoteJid, message.key);

      logger.info(
        {
          messageId,
          remoteJid,
          phone: ids.phone,
          jid: ids.jid,
          lid: ids.lid,
          raw_jid: ids.raw_jid,
          alt_jid: ids.alt_jid,
          candidates: ids.candidates,
          key: message.key,
          messageType,
          text,
        },
        '[WA-IN] mensaje normalizado'
      );

      const media = await this.buildMediaPayload(message, messageType).catch(
        (err) => {
          logger.error({ err, messageId }, '[WA-IN] error descargando media');
          return null;
        }
      );

      const finalText = text || (media ? `[El usuario envió ${messageType}]` : '');

      if (!finalText && !media) {
        logger.info({ messageId, messageType }, '[WA-IN] sin texto ni media, ignorado');
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
        {
          messageId,
          phone: ids.phone,
          message: finalText,
        },
        '[WA-IN] enviando a webhook n8n'
      );

      const response = await postToInboundWebhook(inboundPayload);

      logger.info(
        {
          messageId,
          ok: response?.ok,
          shouldSend: response?.shouldSend,
          outbox_id: response?.outbox_id,
          message: response?.message,
        },
        '[WA-IN] respuesta webhook n8n'
      );

      if (!response?.ok || !response.shouldSend) {
        logger.info({ messageId }, '[WA-IN] webhook no pidió responder');
        return;
      }

      const responseText = String(response.message || '').trim();

      if (!responseText) {
        logger.info({ messageId }, '[WA-IN] webhook sin texto de respuesta');
        return;
      }

      const sent = await this.sendText(remoteJid, responseText);

      logger.info(
        {
          messageId,
          externalMessageId: sent?.key?.id,
          outbox_id: response.outbox_id,
        },
        '[WA-IN] respuesta enviada por WhatsApp'
      );

      if (response.outbox_id) {
        await markOdooOutboxSent(
          Number(response.outbox_id),
          sent?.key?.id || ''
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
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