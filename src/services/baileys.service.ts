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
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
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
      if (type !== 'notify') return;

      for (const msg of messages) {
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
      timestamp: new Date(
        Number(message.messageTimestamp || Date.now() / 1000) * 1000
      ).toISOString(),
    }).catch((err) =>
      logger.warn({ err }, 'No se pudo reportar grupo al webhook')
    );
  }

  private async handleIncomingMessage(message: proto.IWebMessageInfo) {
    try {
      if (Number(message.messageTimestamp || 0) * 1000 < this.startTime) {
        return;
      }

      const remoteJid = message.key?.remoteJid || message.key?.participant || '';

      if (!remoteJid || remoteJid === 'status@broadcast') {
        return;
      }

      if (message.key?.fromMe) {
        return;
      }

      if (this.isFromBotById(message.key?.id)) {
        return;
      }

      const text = extractText(message).trim();
      const messageType = getMessageType(message);

      if (isGroupJid(remoteJid)) {
        logger.info(
          {
            remoteJid,
          },
          'Grupo ignorado'
        );

        await this.reportGroup(message, remoteJid, text, messageType);
        return;
      }

      const ids = extractIdentifiers(remoteJid, message.key);

      const media = await this.buildMediaPayload(message, messageType).catch(
        (err) => {
          logger.error({ err }, 'Error descargando media');
          return null;
        }
      );

      const finalText = text || (media ? `[El usuario envió ${messageType}]` : '');

      if (!finalText && !media) {
        return;
      }

      await prisma.messageLog.create({
        data: {
          direction: 'in',
          chatType: 'private',
          phone: ids.phone || null,
          jid: ids.jid || null,
          lid: ids.lid || null,
          rawJid: ids.raw_jid || null,
          messageType,
          content: finalText,
          externalMessageId: message.key?.id || null,
          mediaUrl: media?.url || null,
          mimetype: media?.mimetype || null,
        },
      });

      const response = await postToInboundWebhook({
        source: 'baileys_gateway',
        chat_type: 'private',
        phone: ids.phone,
        from: remoteJid,
        jid: ids.jid,
        lid: ids.lid,
        raw_jid: ids.raw_jid,
        alt_jid: ids.alt_jid,
        message: finalText,
        message_type: messageType,
        message_id: message.key?.id || '',
        push_name: message.pushName || '',
        timestamp: new Date(
          Number(message.messageTimestamp || Date.now() / 1000) * 1000
        ).toISOString(),
        media,
      });

      if (!response?.ok || !response.shouldSend) {
        return;
      }

      const responseText = String(response.message || '').trim();

      if (!responseText) {
        return;
      }

      const sent = await this.sendText(remoteJid, responseText);

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
          messageId: message.key?.id,
        },
        'Error manejando mensaje'
      );
    }
  }
}

export const whatsapp = new WhatsAppGateway();