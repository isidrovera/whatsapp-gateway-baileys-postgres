export function isGroupJid(jid?: string | null): boolean {
  return !!jid && String(jid).endsWith('@g.us');
}

export function isLidJid(jid?: string | null): boolean {
  const value = String(jid || '').trim().toLowerCase();
  return !!value && (value.includes('@lid') || value.endsWith('.lid'));
}

export function isPnJid(jid?: string | null): boolean {
  const value = String(jid || '').trim().toLowerCase();
  return !!value && (value.includes('@s.whatsapp.net') || value.includes('@c.us'));
}

export function cleanPhone(value?: string | null): string {
  let input = String(value || '').trim();

  if (!input) return '';
  if (isLidJid(input)) return '';

  if (input.includes('@')) {
    input = input.split('@')[0];
  }

  let digits = input.replace(/\D+/g, '').replace(/^0+/, '');

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

function firstNonEmpty(...values: any[]): string {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function collectCandidateJids(remoteJid: string, key?: any): string[] {
  const candidates = [
    remoteJid,

    key?.remoteJid,
    key?.participant,
    key?.remoteJidAlt,
    key?.participantAlt,

    key?.chat,
    key?.from,
    key?.sender,
    key?.author,
    key?.idRemoteJid,
    key?.recipientJid,
    key?.participantPn,
    key?.remoteJidPn,
  ];

  const unique: string[] = [];

  for (const item of candidates) {
    const value = String(item || '').trim();

    if (!value) continue;

    if (!unique.includes(value)) {
      unique.push(value);
    }
  }

  return unique;
}

export function extractIdentifiers(remoteJid: string, key?: any) {
  const candidates = collectCandidateJids(remoteJid, key);

  let jid = '';
  let lid = '';
  let phone = '';
  let alt_jid = '';

  for (const candidate of candidates) {
    if (isPnJid(candidate) && !jid) {
      jid = candidate;
      phone = cleanPhone(candidate);
      continue;
    }

    if (isLidJid(candidate) && !lid) {
      lid = candidate;
      continue;
    }
  }

  for (const candidate of candidates) {
    if (candidate !== remoteJid) {
      alt_jid = candidate;
      break;
    }
  }

  // Si remoteJid es número normal, priorizarlo como jid.
  if (isPnJid(remoteJid)) {
    jid = remoteJid;
    phone = cleanPhone(remoteJid);
  }

  // Si remoteJid es LID, mantenerlo como lid/raw.
  if (isLidJid(remoteJid)) {
    lid = remoteJid;
  }

  return {
    phone,
    jid,
    lid,
    raw_jid: remoteJid || firstNonEmpty(jid, lid),
    alt_jid,
    candidates,
  };
}