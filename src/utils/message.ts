import type { proto } from '@whiskeysockets/baileys';

export function extractText(message: proto.IWebMessageInfo): string {
  const m = message.message;
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return '';
}

export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact';

export function getMessageType(message: proto.IWebMessageInfo): MessageKind {
  const m = message.message;
  if (!m) return 'text';
  if (m.imageMessage) return 'image';
  if (m.audioMessage) return 'audio';
  if (m.videoMessage) return 'video';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage || m.contactsArrayMessage) return 'contact';
  return 'text';
}

export function getMediaContent(message: proto.IWebMessageInfo): any {
  const m = message.message;
  if (!m) return null;
  return m.imageMessage || m.audioMessage || m.videoMessage || m.documentMessage || m.stickerMessage || null;
}

export function getMimeType(message: proto.IWebMessageInfo): string {
  return getMediaContent(message)?.mimetype || '';
}

export function getFileName(message: proto.IWebMessageInfo): string {
  return getMediaContent(message)?.fileName || '';
}