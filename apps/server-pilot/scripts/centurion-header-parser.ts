import { canonicalMessageId } from '../src/mail/ingest/message-id.js';

export type HeaderCompleteness = 'complete' | 'incomplete' | 'unknown';

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

// Accept complete Message-ID tokens only. In a malformed value retain only
// preceding unambiguous tokens and mark the field incomplete; never scan junk
// for a substring that happens to look like a Message-ID.
const dotAtom = String.raw`[A-Za-z0-9!#$%&'*+\-/=?^_\x60{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_\x60{|}~]+)*`;
const messageIdBody = String.raw`(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|${dotAtom})@(?:${dotAtom}|\[(?:[^\[\]\\\s]|\\[^\r\n])+\])`;

function tokenizeHeaderValue(raw: string, allowMany: boolean): { ids: string[]; malformed: boolean } {
  // RFC unfolding removes CRLF only when followed by folding whitespace.
  raw = raw.replace(/\r\n(?=[ \t])/g, '');
  const token = new RegExp(`(?:<(${messageIdBody})>|(${messageIdBody}))`, 'y');
  const ids: string[] = [];
  let position = 0;
  let separated = true;
  while (position < raw.length) {
    let whitespace = false;
    while (position < raw.length) {
      if (raw[position] === ' ' || raw[position] === '\t') { position++; whitespace = true; continue; }
      if (raw.slice(position, position + 2) === '\r\n' && /[ \t]/.test(raw[position + 2] ?? '')) {
        position += 2;
        whitespace = true;
        continue;
      }
      if (raw[position] === '(') {
        let depth = 1;
        position++;
        while (position < raw.length && depth > 0) {
          const ch = raw[position]!;
          if (ch === '\\') {
            if (position + 1 >= raw.length || /[\r\n]/.test(raw[position + 1]!)) return { ids, malformed: true };
            position += 2; continue;
          }
          if (ch === '\r' && raw[position + 1] === '\n' && /[ \t]/.test(raw[position + 2] ?? '')) {
            position += 2; continue;
          }
          if ((ch.charCodeAt(0) < 32 && ch !== '\t') || ch.charCodeAt(0) === 127) return { ids, malformed: true };
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          position++;
        }
        if (depth !== 0) return { ids, malformed: true };
        whitespace = true;
        continue;
      }
      break;
    }
    if (position === raw.length) break;
    if (ids.length && !whitespace && !(separated && raw[position] === '<')) return { ids, malformed: true };
    token.lastIndex = position;
    const match = token.exec(raw);
    if (!match || (!allowMany && ids.length)) return { ids, malformed: true };
    // Quoted IDs and domain literals cannot contain ASCII controls other than tab.
    for (const character of match[0]) {
      const code = character.charCodeAt(0);
      if ((code < 32 && code !== 9) || code === 127) return { ids, malformed: true };
    }
    position = token.lastIndex;
    separated = match[1] !== undefined;
    // A match must end at a legal boundary, not in the middle of junk.
    if (position < raw.length && raw[position] !== ' ' && raw[position] !== '\t' &&
        !(raw.slice(position, position + 2) === '\r\n' && /[ \t]/.test(raw[position + 2] ?? '')) &&
        raw[position] !== '(' && !(separated && raw[position] === '<')) return { ids, malformed: true };
    const id = canonicalMessageId(match[1] ?? match[2]);
    if (!id) return { ids, malformed: true };
    ids.push(id);
  }
  return { ids, malformed: ids.length === 0 };
}

/** Validate a whole saved header value without exposing or rewriting it. */
export function isValidHeaderValue(value: string, field: 'messageIds' | 'inReplyTo' | 'references'): boolean {
  return !tokenizeHeaderValue(value, field !== 'messageIds').malformed;
}

export function normalizedHeaders(
  values: readonly string[] | null | undefined,
  legacy: string | null | undefined,
  declared: HeaderCompleteness | undefined,
  allowMany: boolean,
): { ids: string[]; completeness: HeaderCompleteness } {
  let malformed = values != null && !Array.isArray(values);
  const present = Array.isArray(values);
  const inputs: unknown[] = present ? [...values] : [];
  if (legacy != null) inputs.push(legacy);
  const ids: string[] = [];
  for (const value of inputs) {
    if (typeof value !== 'string') { malformed = true; continue; }
    const parsed = tokenizeHeaderValue(value, allowMany);
    ids.push(...parsed.ids);
    malformed ||= parsed.malformed;
  }
  if (declared !== undefined && !['complete', 'incomplete', 'unknown'].includes(declared)) malformed = true;
  const completeness = malformed || declared === 'incomplete' ? 'incomplete'
    : !present || declared !== 'complete' ? 'unknown' : 'complete';
  return { ids: uniqueSorted(ids), completeness };
}
