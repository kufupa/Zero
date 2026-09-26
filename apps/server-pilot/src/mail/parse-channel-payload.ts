/**
 * Parse forwarded channel manager (channel_fw) mail bodies — WebBeds, RateTiger, SynXis.
 * Operates on bounded UTF-8 text only; no HMS/CRS surfaces.
 */
import {
  channelPayloadDataSchema,
  channelPayloadChannelSchema,
  type ChannelPayloadChannel,
  type ChannelPayloadData,
} from './channel-payload-contract.js';

export const MAIL_PARSE_CHANNEL_MAX_BYTES = 512 * 1024;

/** Prefer quoted OTA block after human "see below" cover. */
export function extractChannelQuotedBlock(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lower = normalized.toLowerCase();
  const markers = [
    '----- original message -----',
    '----- forwarded message -----',
    'begin forwarded message',
    'see below',
  ];
  let start = 0;
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx >= 0) {
      start = Math.max(start, idx);
    }
  }
  return normalized.slice(start);
}

function detectChannel(block: string): ChannelPayloadChannel {
  const hay = block.toLowerCase();
  if (/\bwebbeds\b/.test(hay)) return 'webbeds';
  if (/\b(rate\s*tiger|ratetiger)\b/.test(hay)) return 'ratetiger';
  if (/\bsynxis\b/.test(hay)) return 'synxis';
  return 'unknown';
}

function captureFirst(pattern: RegExp, block: string): string | null {
  const match = pattern.exec(block);
  if (!match?.[1]) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function normalizeGuestLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function parseIsoDate(raw: string): string | null {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1]!;
  const dmy = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (dmy) {
    const dd = dmy[1]!.padStart(2, '0');
    const mm = dmy[2]!.padStart(2, '0');
    return `${dmy[3]}-${mm}-${dd}`;
  }
  return null;
}

function parseStayDates(block: string): { arrival: string; departure: string } | null {
  const arrivalRaw =
    captureFirst(
      /(?:check[- ]?in(?:\s+date)?|arrival(?:\s+date)?)\s*[:]\s*([^\n]+)/i,
      block,
    ) ??
    captureFirst(/arrive[s]?\s*[:]\s*([^\n]+)/i, block);
  const departureRaw =
    captureFirst(
      /(?:check[- ]?out(?:\s+date)?|departure(?:\s+date)?)\s*[:]\s*([^\n]+)/i,
      block,
    ) ??
    captureFirst(/depart[s]?\s*[:]\s*([^\n]+)/i, block);
  if (!arrivalRaw || !departureRaw) return null;
  const arrival = parseIsoDate(arrivalRaw);
  const departure = parseIsoDate(departureRaw);
  if (!arrival || !departure) return null;
  return { arrival, departure };
}

function parseExternalRef(block: string, channel: ChannelPayloadChannel): string | null {
  const patterns = [
    /(?:booking\s+reference|reservation\s+(?:number|no\.?|#)|confirmation\s+(?:number|no\.?|#)|external\s+ref(?:erence)?)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9._-]{2,64})/i,
    /\b(WB-TEST-\d+)\b/,
    /\b(SYX-TEST-\d+)\b/,
    /\b(RT-TEST-\d+)\b/,
  ];
  for (const pattern of patterns) {
    const value = captureFirst(pattern, block);
    if (value) return value;
  }
  if (channel === 'synxis') {
    return captureFirst(/\bconfirmation\s*#\s*([A-Za-z0-9-]+)/i, block);
  }
  return null;
}

function parseGuestLabel(block: string): string | null {
  const raw =
    captureFirst(/(?:guest\s+name|primary\s+guest|lead\s+guest)\s*[:]\s*([^\n]+)/i, block) ??
    captureFirst(/(?:guest)\s*[:]\s*([^\n]+)/i, block);
  if (!raw) return null;
  const label = normalizeGuestLabel(raw);
  return label.length > 0 ? label : null;
}

function parseCardHandleAbsent(block: string): boolean {
  const hay = block.toLowerCase();
  if (/virtual card not supplied|no virtual card|card handle absent|card not provided/.test(hay)) {
    return true;
  }
  if (/virtual card supplied|card number|payment card ending/.test(hay)) {
    return false;
  }
  return true;
}

export type ParseChannelPayloadOutcome =
  | { ok: true; data: ChannelPayloadData }
  | { ok: false; reason: 'empty' | 'unrecognized_channel_fw' | 'missing_required_fields' };

/**
 * Parse channel_fw payload from authorized mail body text (forward + quoted OTA).
 */
export function parseChannelPayloadFromText(rawText: string): ParseChannelPayloadOutcome {
  const text = rawText.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (text.length > MAIL_PARSE_CHANNEL_MAX_BYTES) {
    return { ok: false, reason: 'unrecognized_channel_fw' };
  }

  const block = extractChannelQuotedBlock(text);
  const channel = detectChannel(block);
  if (channel === 'unknown' && !/\bsee below\b/i.test(text)) {
    return { ok: false, reason: 'unrecognized_channel_fw' };
  }

  const externalRef = parseExternalRef(block, channel);
  const stayDates = parseStayDates(block);
  const guestLabel = parseGuestLabel(block);
  const cardHandleAbsent = parseCardHandleAbsent(block);

  if (!externalRef || !stayDates || !guestLabel) {
    return { ok: false, reason: 'missing_required_fields' };
  }

  const parsed = channelPayloadDataSchema.safeParse({
    channel: channelPayloadChannelSchema.parse(channel === 'unknown' ? detectChannel(text) : channel),
    externalRef,
    stayDates,
    guestLabel,
    cardHandleAbsent,
  });
  if (!parsed.success) {
    return { ok: false, reason: 'missing_required_fields' };
  }

  if (parsed.data.channel === 'unknown') {
    return { ok: false, reason: 'unrecognized_channel_fw' };
  }

  return { ok: true, data: parsed.data };
}

export function parseChannelPayloadFromBytes(body: Buffer): ParseChannelPayloadOutcome {
  return parseChannelPayloadFromText(body.toString('utf8'));
}
