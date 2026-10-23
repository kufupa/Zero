/**
 * Offline ask → staff reply → HMS confirmation-letter linker.
 * Output is labelled context, never gold. No DB, no network, no mail bodies.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_DATASET_LABEL = 'context' as const;
export const LETTER_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_CONTEXT_OUT = '.private/mail-context/context.jsonl';

const LETTER_FILE_RE = /^([A-Z]{3,8})_Confirmation_Letter_(\d{8})(?:\b|\.|$)/i;
const LETTER_SUBJECT_CONF_RE = /Confirmation Letter_.*?\(n[°ºo]\s*(\d{8})/i;
const FORBIDDEN_OUTPUT_KEYS = new Set([
  'textBody',
  'htmlBody',
  'from',
  'to',
  'subject',
  'guest',
  'email',
  'filename',
  'recipientDomain',
]);

export type PropertyCode = string;

export type StayFacts = {
  guest?: string | null;
  arrival?: string | null;
  departure?: string | null;
  room?: string | null;
  adults?: number | null;
};

export type MailContextEvent = {
  id: string;
  threadId: string;
  at: string;
  direction: 'inbound' | 'outbound';
  role: 'ask' | 'staff_reply' | 'hms_letter';
  recipientDomain?: string | null;
  subject?: string | null;
  filename?: string | null;
  facts?: StayFacts | null;
};

export type FieldMatchFlags = {
  guest: boolean | null;
  arrival: boolean | null;
  departure: boolean | null;
  room: boolean | null;
  adults: boolean | null;
};

export type ContextLink = {
  label: typeof CONTEXT_DATASET_LABEL;
  link_confidence: number;
  fields_match: boolean;
  field_flags: FieldMatchFlags;
  ask_id: string;
  reply_id: string;
  letter_id: string;
  conf: string;
  property: PropertyCode | null;
  window_ms: number;
};

export type MailContextLinkerCli = {
  inPath: string;
  outPath: string;
};

export type MailContextLinkerResult = {
  written: number;
  outPath: string;
  label: typeof CONTEXT_DATASET_LABEL;
};

function fileName(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || value;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function norm(value: string | null | undefined): string | null {
  const raw = text(value);
  return raw ? raw.replace(/\s+/g, ' ').toLowerCase() : null;
}

export function maskContextId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

export function parseConfirmationLetterFilename(
  filename: string | null | undefined,
): { property: PropertyCode; conf: string } | null {
  const raw = text(filename);
  if (!raw) return null;
  const match = fileName(raw).match(LETTER_FILE_RE);
  if (!match?.[1] || !match[2]) return null;
  return { property: match[1].toUpperCase(), conf: match[2] };
}

export function parseConfirmationLetterSubjectConf(
  subject: string | null | undefined,
): string | null {
  const raw = text(subject);
  if (!raw) return null;
  return raw.match(LETTER_SUBJECT_CONF_RE)?.[1] ?? null;
}

function letterIdentity(event: MailContextEvent): {
  conf: string;
  property: PropertyCode | null;
} | null {
  const fromFile = parseConfirmationLetterFilename(event.filename);
  const fromSubject = parseConfirmationLetterSubjectConf(event.subject);
  if (fromFile && fromSubject && fromFile.conf !== fromSubject) return null;
  const conf = fromFile?.conf ?? fromSubject;
  if (!conf) return null;
  return { conf, property: fromFile?.property ?? null };
}

function compareField(
  askValue: string | number | null | undefined,
  letterValue: string | number | null | undefined,
): boolean | null {
  if (askValue == null || askValue === '' || letterValue == null || letterValue === '') {
    return null;
  }
  if (typeof askValue === 'number' || typeof letterValue === 'number') {
    return Number(askValue) === Number(letterValue);
  }
  return norm(String(askValue)) === norm(String(letterValue));
}

export function compareStayFacts(
  askFacts: StayFacts | null | undefined,
  letterFacts: StayFacts | null | undefined,
): { fields_match: boolean; field_flags: FieldMatchFlags } {
  const field_flags: FieldMatchFlags = {
    guest: compareField(askFacts?.guest, letterFacts?.guest),
    arrival: compareField(askFacts?.arrival, letterFacts?.arrival),
    departure: compareField(askFacts?.departure, letterFacts?.departure),
    room: compareField(askFacts?.room, letterFacts?.room),
    adults: compareField(askFacts?.adults, letterFacts?.adults),
  };
  const fields_match = !Object.values(field_flags).some((flag) => flag === false);
  return { fields_match, field_flags };
}

function linkConfidence(input: {
  sameThread: boolean;
  sameDomain: boolean;
  fieldsMatch: boolean;
}): number {
  let score = 0.5;
  if (input.sameThread) score += 0.25;
  else if (input.sameDomain) score += 0.15;
  if (input.fieldsMatch) score += 0.2;
  return Math.round(score * 100) / 100;
}

function msAt(iso: string): number {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) throw new Error(`mail-context event has invalid at ${iso}`);
  return value;
}

function sameDomain(a: MailContextEvent, b: MailContextEvent): boolean {
  const left = norm(a.recipientDomain);
  const right = norm(b.recipientDomain);
  return Boolean(left && right && left === right);
}

export function linkMailContext(events: readonly MailContextEvent[]): ContextLink[] {
  const asks = events.filter((event) => event.role === 'ask');
  const replies = events.filter((event) => event.role === 'staff_reply');
  const letters = events.filter((event) => event.role === 'hms_letter');
  const links: ContextLink[] = [];

  for (const askEvent of asks) {
    const replyEvent = replies
      .filter((row) => row.threadId === askEvent.threadId && msAt(row.at) >= msAt(askEvent.at))
      .sort((a, b) => msAt(a.at) - msAt(b.at))[0];
    if (!replyEvent) continue;
    const replyMs = msAt(replyEvent.at);
    const candidate = letters
      .map((letter) => {
        const identity = letterIdentity(letter);
        if (!identity) return null;
        const delta = msAt(letter.at) - replyMs;
        if (delta < 0 || delta > LETTER_WINDOW_MS) return null;
        const threadOk = letter.threadId === replyEvent.threadId;
        const domainOk = sameDomain(letter, replyEvent) || sameDomain(letter, askEvent);
        if (!threadOk && !domainOk) return null;
        return { letter, identity, delta, threadOk, domainOk };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort((a, b) => a.delta - b.delta)[0];
    if (!candidate) continue;
    const compared = compareStayFacts(askEvent.facts, candidate.letter.facts);
    links.push({
      label: CONTEXT_DATASET_LABEL,
      link_confidence: linkConfidence({
        sameThread: candidate.threadOk,
        sameDomain: candidate.domainOk,
        fieldsMatch: compared.fields_match,
      }),
      fields_match: compared.fields_match,
      field_flags: compared.field_flags,
      ask_id: maskContextId(askEvent.id),
      reply_id: maskContextId(replyEvent.id),
      letter_id: maskContextId(candidate.letter.id),
      conf: candidate.identity.conf,
      property: candidate.identity.property,
      window_ms: candidate.delta,
    });
  }

  return links;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readFacts(value: unknown): StayFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    guest: text(row.guest),
    arrival: text(row.arrival),
    departure: text(row.departure),
    room: text(row.room),
    adults: typeof row.adults === 'number' ? row.adults : null,
  };
}

function readEvent(value: unknown): MailContextEvent {
  const row = asRecord(value);
  const id = text(row.id);
  const threadId = text(row.threadId);
  const at = text(row.at);
  const direction = text(row.direction);
  const role = text(row.role);
  if (!id || !threadId || !at) throw new Error('mail-context event needs id, threadId, at');
  if (direction !== 'inbound' && direction !== 'outbound') {
    throw new Error(`mail-context event ${id} has invalid direction`);
  }
  if (role !== 'ask' && role !== 'staff_reply' && role !== 'hms_letter') {
    throw new Error(`mail-context event ${id} has invalid role`);
  }
  return {
    id,
    threadId,
    at,
    direction,
    role,
    recipientDomain: text(row.recipientDomain),
    subject: text(row.subject),
    filename: text(row.filename),
    facts: readFacts(row.facts),
  };
}

export function parseMailContextEvents(parsed: unknown): MailContextEvent[] {
  if (Array.isArray(parsed)) return parsed.map(readEvent);
  const record = asRecord(parsed);
  if (!Array.isArray(record.events)) throw new Error('mail-context input needs events[]');
  return record.events.map(readEvent);
}

export function parseMailContextLinkerCli(
  argv: readonly string[],
  serverRoot: string,
): MailContextLinkerCli {
  let inPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--in' && value && !value.startsWith('--')) {
      inPath = value;
      i += 1;
      continue;
    }
    if (flag === '--out' && value && !value.startsWith('--')) {
      outPath = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown mail-context linker flag ${flag}`);
  }
  if (!inPath) throw new Error('mail-context-linker.ts --in <events.json> [--out <context.jsonl>]');
  return {
    inPath: path.resolve(serverRoot, inPath),
    outPath: path.resolve(serverRoot, outPath ?? DEFAULT_CONTEXT_OUT),
  };
}

function assertNoForbiddenOutput(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenOutput(item, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) {
      throw new Error(`mail-context output forbids ${key} at ${trail}`);
    }
    assertNoForbiddenOutput(child, `${trail}.${key}`);
  }
}

export function writeContextJsonl(outPath: string, links: readonly ContextLink[]): void {
  assertNoForbiddenOutput(links, 'out');
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  const body = links.length === 0 ? '' : `${links.map((row) => JSON.stringify(row)).join('\n')}\n`;
  writeFileSync(tmpPath, body, 'utf8');
  renameSync(tmpPath, outPath);
}

export function runMailContextLinker(args: MailContextLinkerCli): MailContextLinkerResult {
  const parsed: unknown = JSON.parse(readFileSync(args.inPath, 'utf8'));
  const links = linkMailContext(parseMailContextEvents(parsed));
  writeContextJsonl(args.outPath, links);
  return { written: links.length, outPath: args.outPath, label: CONTEXT_DATASET_LABEL };
}
