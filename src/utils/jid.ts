export function isGroupJid(jid?: string | null): boolean {
  return !!jid && String(jid).trim().toLowerCase().endsWith('@g.us');
}

export function isLidJid(jid?: string | null): boolean {
  const value = String(jid || '').trim().toLowerCase();
  return !!value && (value.includes('@lid') || value.endsWith('.lid'));
}

export function isPnJid(jid?: string | null): boolean {
  const value = String(jid || '').trim().toLowerCase();

  return !!value && (
    value.includes('@s.whatsapp.net') ||
    value.includes('@c.us')
  );
}

export function normalizeLidJid(jid?: string | null): string {
  const value = String(jid || '').trim();

  if (!value) return '';

  if (value.toLowerCase().includes('@lid')) {
    const left = value.split('@')[0].replace(/\D+/g, '');
    return left ? `${left}@lid` : value;
  }

  if (value.toLowerCase().endsWith('.lid')) {
    const left = value.replace(/\.lid$/i, '').replace(/\D+/g, '');
    return left ? `${left}@lid` : value;
  }

  return '';
}

export function cleanPhone(value?: string | null): string {
  let input = String(value || '').trim();

  if (!input) return '';
  if (isLidJid(input)) return '';

  if (input.includes('@')) {
    input = input.split('@')[0];
  }

  let digits = input.replace(/\D+/g, '').replace(/^0+/, '');

  // Perú: si llega 9 dígitos, agregar 51.
  if (digits.length === 9) {
    digits = `51${digits}`;
  }

  return digits;
}

export function jidFromTo(to: string): string {
  const trimmed = String(to || '').trim();

  if (!trimmed) {
    throw new Error('Destino vacío');
  }

  if (trimmed.includes('@')) {
    return trimmed;
  }

  const digits = cleanPhone(trimmed);

  if (!digits) {
    throw new Error(`Destino inválido: ${to}`);
  }

  return `${digits}@s.whatsapp.net`;
}

function addCandidate(list: string[], value?: string | null) {
  const item = String(value || '').trim();

  if (!item) return;
  if (list.includes(item)) return;

  list.push(item);
}

function collectCandidateJids(remoteJid: string, key?: any): string[] {
  const candidates: string[] = [];

  addCandidate(candidates, remoteJid);

  addCandidate(candidates, key?.remoteJid);
  addCandidate(candidates, key?.participant);

  // Campos alternativos de Baileys / WhatsApp multi-device.
  addCandidate(candidates, key?.remoteJidAlt);
  addCandidate(candidates, key?.participantAlt);

  // Campos PN que a veces trae Baileys cuando remoteJid llega como @lid.
  addCandidate(candidates, key?.senderPn);
  addCandidate(candidates, key?.participantPn);
  addCandidate(candidates, key?.remoteJidPn);
  addCandidate(candidates, key?.chatPn);
  addCandidate(candidates, key?.authorPn);

  // Otros posibles nombres según versión/evento.
  addCandidate(candidates, key?.senderJid);
  addCandidate(candidates, key?.sender);
  addCandidate(candidates, key?.author);
  addCandidate(candidates, key?.from);
  addCandidate(candidates, key?.chat);
  addCandidate(candidates, key?.idRemoteJid);
  addCandidate(candidates, key?.recipientJid);
  addCandidate(candidates, key?.remoteJidActual);
  addCandidate(candidates, key?.participantActual);

  return candidates;
}

export function extractIdentifiers(remoteJid: string, key?: any) {
  const candidates = collectCandidateJids(remoteJid, key);

  let jid = '';
  let lid = '';
  let phone = '';
  let alt_jid = '';

  for (const candidate of candidates) {
    if (!jid && isPnJid(candidate)) {
      jid = candidate;
      phone = cleanPhone(candidate);
      continue;
    }

    if (!lid && isLidJid(candidate)) {
      lid = normalizeLidJid(candidate) || candidate;
      continue;
    }
  }

  for (const candidate of candidates) {
    if (candidate !== remoteJid) {
      alt_jid = candidate;
      break;
    }
  }

  if (isPnJid(remoteJid)) {
    jid = remoteJid;
    phone = cleanPhone(remoteJid);
  }

  if (isLidJid(remoteJid)) {
    lid = normalizeLidJid(remoteJid) || remoteJid;
  }

  return {
    phone,
    jid,
    lid,
    raw_jid: remoteJid || jid || lid || '',
    alt_jid,
    candidates,
  };
}