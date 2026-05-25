export function isGroupJid(jid?: string | null): boolean {
  return !!jid && String(jid).trim().endsWith('@g.us');
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

  // IMPORTANTE:
  // En tus logs el número normal llegó aquí:
  // senderPn: "51924894829@s.whatsapp.net"
  addCandidate(candidates, key?.senderPn);

  // Otros posibles nombres según evento/versión.
  addCandidate(candidates, key?.participantPn);
  addCandidate(candidates, key?.remoteJidPn);
  addCandidate(candidates, key?.senderJid);
  addCandidate(candidates, key?.sender);
  addCandidate(candidates, key?.author);
  addCandidate(candidates, key?.from);
  addCandidate(candidates, key?.chat);
  addCandidate(candidates, key?.idRemoteJid);
  addCandidate(candidates, key?.recipientJid);

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

  if (isPnJid(remoteJid)) {
    jid = remoteJid;
    phone = cleanPhone(remoteJid);
  }

  if (isLidJid(remoteJid)) {
    lid = remoteJid;
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