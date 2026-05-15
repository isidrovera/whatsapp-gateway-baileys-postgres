export function isGroupJid(jid?: string | null): boolean {
  return !!jid && jid.endsWith('@g.us');
}

export function isLidJid(jid?: string | null): boolean {
  return !!jid && (jid.includes('@lid') || jid.endsWith('.lid'));
}

export function isPnJid(jid?: string | null): boolean {
  return !!jid && (jid.includes('@s.whatsapp.net') || jid.includes('@c.us'));
}

export function cleanPhone(value?: string | null): string {
  let input = String(value || '').trim();
  if (!input) return '';
  if (isLidJid(input)) return '';
  if (input.includes('@')) input = input.split('@')[0];
  let digits = input.replace(/\D+/g, '').replace(/^0+/, '');
  if (digits.length === 9) digits = `51${digits}`;
  return digits;
}

export function jidFromTo(to: string): string {
  const trimmed = String(to || '').trim();
  if (!trimmed) throw new Error('Destino vacío');
  if (trimmed.includes('@')) return trimmed;
  const digits = cleanPhone(trimmed);
  if (!digits) throw new Error(`Destino inválido: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

export function extractIdentifiers(remoteJid: string, key?: any) {
  const alt = key?.remoteJidAlt || key?.participantAlt || '';
  let jid = '';
  let lid = '';
  let phone = '';

  if (isLidJid(remoteJid)) {
    lid = remoteJid;
    if (isPnJid(alt)) {
      jid = alt;
      phone = cleanPhone(alt);
    }
  } else {
    jid = remoteJid;
    phone = cleanPhone(remoteJid);
    if (isLidJid(alt)) lid = alt;
  }

  return { phone, jid, lid, raw_jid: remoteJid, alt_jid: alt || '' };
}
