/**
 * Pure, development-only redaction for the Stagehand trial's private captures.
 *
 * The helper accepts structured values and a small set of known transport
 * encodings. Unknown response/message text is rejected; callers must persist
 * only a successful result.
 */

import { extractHmsPageDataRecord } from './folio-fol-parse.js';

export type StagehandCaptureKind = 'request-part' | 'response-body' | 'message';

export type StagehandCaptureRedactionResult<T> =
  | {
      ok: true;
      value: T;
      redactedPaths: string[];
    }
  | {
      ok: false;
      reason: 'UNSAFE_SECRET_CONTENT';
    };

const REDACTED = '[REDACTED]';
const MAX_RECURSION = 128;
const MAX_ENCODED_RECURSION = 16;

/* Compare normalized field names, not substrings: `company` is ordinary data. */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'passcode',
  'secret',
  'token',
  'cookie',
  'auth',
  'authorization',
  'authorizationheader',
  'authheader',
  'proxyauthorization',
  'bearer',
  'session',
  'sessionid',
  'sessionidentifier',
  'sessiontoken',
  'csrf',
  'csrftoken',
  'xsrf',
  'xsrftoken',
  'xcsrftoken',
  'jwt',
  'apikey',
  'xapikey',
  'accesskey',
  'accesstoken',
  'refreshkey',
  'refreshtoken',
  'clientsecret',
  'privatekey',
  'card',
  'cardnumber',
  'paymentcard',
  'paymentcardnumber',
  'virtualcard',
  'virtualcardnumber',
  'creditcard',
  'creditcardnumber',
  'cardpan',
  'pan',
  'pannumber',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'securitycode',
  'trackdata',
  'roompin',
  'paymentcredential',
  'setcookie',
]);

const QUERY_SECRET_RE =
  /(^|[?&\s])((?:password|passwd|passcode|secret|token|cookie|authorization|auth|session|csrf|csrf_token|csrftoken|xsrf|xsrf_token|xsrftoken|jwt|apikey|x-api-key|accesskey|refresh_token|card_number|payment_card_number|credit_card|cardpan|pan|cvv2?|cvc2?|security_code|room_pin|payment_credential))=([^&#\s]*)/gi;
const HEADER_SECRET_RE =
  /(^|\r?\n)\s*(authorization|proxy-authorization|cookie|set-cookie|x-(?:api|csrf|xsrf)-key|x-(?:csrf|xsrf)-token)\s*:\s*([^\r\n]*)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi;
const LABELED_CARD_RE =
  /\b(?:pan|primary\s+account\s+number|credit\s+card(?:\s+number)?|card\s+number)\b[^\d]{0,24}((?:\d[ -]?){13,19})/gi;
const SAFE_FIELD_DESCRIPTOR_KEYS = new Set([
  'name',
  'aliasnum',
  'control',
  'events',
  'filterable',
  'keyfield',
  'label',
  'lookup',
  'order',
  'type',
  'visible',
  'width',
]);
/* Observed HMS metadata/financial text fields may contain literal `%` signs. */
const SAFE_LITERAL_PERCENT_KEYS = new Set(['display', 'label', 'transdesc']);
const PERCENT_ESCAPE_RE = /%[0-9a-f]{2}/i;

type MutableState = { redactedPaths: Set<string> };

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized !== 'authorizationpresent' &&
    normalized !== 'requestheadernames' &&
    SENSITIVE_KEYS.has(normalized)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasInvalidPercentEncoding(value: string): boolean {
  return /%(?![0-9a-f]{2})/i.test(value);
}

function looksLikeForm(value: string): boolean {
  return !/^https?:\/\//i.test(value) && /^(?:[^=&\s]{1,80})=/.test(value);
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function looksLikeKnownRequestText(value: string): boolean {
  if (looksLikeForm(value) || looksLikeJson(value)) return true;
  QUERY_SECRET_RE.lastIndex = 0;
  const query = QUERY_SECRET_RE.test(value);
  QUERY_SECRET_RE.lastIndex = 0;
  HEADER_SECRET_RE.lastIndex = 0;
  const header = HEADER_SECRET_RE.test(value);
  HEADER_SECRET_RE.lastIndex = 0;
  BEARER_RE.lastIndex = 0;
  const bearer = BEARER_RE.test(value);
  BEARER_RE.lastIndex = 0;
  if (query || header || bearer) return true;
  if (hasInvalidPercentEncoding(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== value && (looksLikeJson(decoded) || looksLikeForm(decoded));
  } catch {
    return false;
  }
}

function addPath(state: MutableState, path: string): void {
  state.redactedPaths.add(path);
}

function allowsLiteralPercent(path: string): boolean {
  const leaf = path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '').toLowerCase();
  return SAFE_LITERAL_PERCENT_KEYS.has(leaf);
}

function looksLikeEncodedTransport(value: string): boolean {
  if (looksLikeForm(value) || PERCENT_ESCAPE_RE.test(value)) return true;
  QUERY_SECRET_RE.lastIndex = 0;
  const query = QUERY_SECRET_RE.test(value);
  QUERY_SECRET_RE.lastIndex = 0;
  HEADER_SECRET_RE.lastIndex = 0;
  const header = HEADER_SECRET_RE.test(value);
  HEADER_SECRET_RE.lastIndex = 0;
  BEARER_RE.lastIndex = 0;
  const bearer = BEARER_RE.test(value);
  BEARER_RE.lastIndex = 0;
  return query || header || bearer;
}

function scrubLabeledCards(value: string, path: string, state: MutableState): string {
  LABELED_CARD_RE.lastIndex = 0;
  return value.replace(LABELED_CARD_RE, (whole, candidate: string) => {
    const start = whole.lastIndexOf(candidate);
    addPath(state, path);
    return `${whole.slice(0, start)}${REDACTED}`;
  });
}

function scrubKnownText(value: string, path: string, state: MutableState): string | null {
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let found = false;

  QUERY_SECRET_RE.lastIndex = 0;
  for (const match of value.matchAll(QUERY_SECRET_RE)) {
    found = true;
    const raw = match[3] ?? '';
    if (!raw) return null;
    const start = (match.index ?? 0) + match[0].length - raw.length;
    replacements.push({ start, end: start + raw.length, replacement: REDACTED });
    addPath(state, `${path}.${match[2] ?? 'query'}`);
  }

  HEADER_SECRET_RE.lastIndex = 0;
  for (const match of value.matchAll(HEADER_SECRET_RE)) {
    found = true;
    const raw = match[3] ?? '';
    if (!raw) return null;
    const start = (match.index ?? 0) + match[0].length - raw.length;
    replacements.push({ start, end: start + raw.length, replacement: REDACTED });
    addPath(state, `${path}.${match[2] ?? 'header'}`);
  }

  BEARER_RE.lastIndex = 0;
  for (const match of value.matchAll(BEARER_RE)) {
    found = true;
    const start = match.index ?? 0;
    replacements.push({ start, end: start + match[0].length, replacement: `Bearer ${REDACTED}` });
    addPath(state, `${path}.bearer`);
  }

  if (!found && replacements.length === 0) return scrubLabeledCards(value, path, state);

  replacements.sort((left, right) => right.start - left.start);
  let output = value;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) continue;
    output = `${output.slice(0, replacement.start)}${replacement.replacement}${output.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return scrubLabeledCards(output, path, state);
}

function redactString(
  value: string,
  path: string,
  kind: StagehandCaptureKind,
  state: MutableState,
  depth: number,
  encodedDepth = 0,
): string | null {
  if (depth > MAX_RECURSION) return null;
  if (encodedDepth > MAX_ENCODED_RECURSION) return null;
  if (hasInvalidPercentEncoding(value)) return null;

  if (looksLikeForm(value) && kind === 'request-part') {
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(value);
    } catch {
      return null;
    }
    const output = new URLSearchParams();
    for (const [key, raw] of params.entries()) {
      if (isSensitiveKey(key)) {
        if (raw === '') output.append(key, raw);
        else {
          output.append(key, REDACTED);
          addPath(state, `${path}.${key}`);
        }
        continue;
      }
      const scrubbed = redactNestedString(raw, `${path}.${key}`, kind, state, depth + 1);
      if (scrubbed === null) return null;
      output.append(key, scrubbed);
    }
    return output.toString();
  }

  const decoded = decodeURIComponent(value);
  if (decoded !== value) {
    if (looksLikeJson(decoded)) {
      try {
        const parsed = JSON.parse(decoded) as unknown;
        const scrubbed = redactValue(parsed, path, kind, state, depth + 1);
        return encodeURIComponent(JSON.stringify(scrubbed));
      } catch {
        return null;
      }
    }
    const scrubbed = redactString(decoded, path, kind, state, depth + 1, encodedDepth + 1);
    if (scrubbed === null) return null;
    return encodeURIComponent(scrubbed);
  }

  return scrubKnownText(value, path, state);
}

function redactNestedString(
  value: string,
  path: string,
  kind: StagehandCaptureKind,
  state: MutableState,
  depth: number,
  encodedDepth = 0,
): string | null {
  if (depth > MAX_RECURSION) return null;
  if (encodedDepth > MAX_ENCODED_RECURSION) return null;
  if (looksLikeForm(value) && kind === 'request-part') {
    return redactString(value, path, kind, state, depth);
  }
  if (looksLikeJson(value)) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return JSON.stringify(redactValue(parsed, path, kind, state, depth + 1));
    } catch {
      return null;
    }
  }
  if (hasInvalidPercentEncoding(value)) {
    if (!allowsLiteralPercent(path) || looksLikeEncodedTransport(value)) return null;
    const scrubbed = scrubKnownText(value, path, state);
    return scrubbed === null ? null : scrubLabeledCards(scrubbed, path, state);
  }
  const decoded = decodeURIComponent(value);
  if (decoded !== value) {
    if (looksLikeJson(decoded)) {
      try {
        const parsed = JSON.parse(decoded) as unknown;
        const scrubbed = redactValue(parsed, path, kind, state, depth + 1);
        return encodeURIComponent(JSON.stringify(scrubbed));
      } catch {
        return null;
      }
    }
    const scrubbed = redactString(decoded, path, kind, state, depth + 1, encodedDepth + 1);
    return scrubbed === null ? null : encodeURIComponent(scrubbed);
  }
  const structured = scrubKnownText(value, path, state);
  if (structured === null) return null;
  return scrubLabeledCards(structured, path, state);
}

function isTuple(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string';
}

function redactTuple(
  tuple: [string, unknown],
  path: string,
  kind: StagehandCaptureKind,
  state: MutableState,
  depth: number,
): [string, unknown] {
  const [name, raw] = tuple;
  if (isSensitiveKey(name)) {
    if (raw !== null && raw !== undefined && raw !== '') {
      addPath(state, `${path}[1]`);
      return [name, REDACTED];
    }
    return [name, raw];
  }
  return [name, redactValue(raw, `${path}[1]`, kind, state, depth + 1)];
}

function redactValue(
  value: unknown,
  path: string,
  kind: StagehandCaptureKind,
  state: MutableState,
  depth: number,
): unknown {
  if (depth > MAX_RECURSION) throw new Error('UNSAFE_SECRET_CONTENT');
  if (typeof value === 'string') {
    const scrubbed = redactNestedString(value, path, kind, state, depth);
    if (scrubbed === null) throw new Error('UNSAFE_SECRET_CONTENT');
    return scrubbed;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (
        Array.isArray(item) &&
        typeof item[0] === 'string' &&
        isSensitiveKey(item[0]) &&
        !isTuple(item)
      ) {
        throw new Error('UNSAFE_SECRET_CONTENT');
      }
      return isTuple(item)
        ? redactTuple(item, `${path}[${index}]`, kind, state, depth + 1)
        : redactValue(item, `${path}[${index}]`, kind, state, depth + 1);
    });
  }
  if (!isPlainObject(value)) throw new Error('UNSAFE_SECRET_CONTENT');

  const descriptorName = typeof value.name === 'string' ? value.name : null;
  if (descriptorName !== null && isSensitiveKey(descriptorName)) {
    const keys = Object.keys(value);
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      if (keys.some((key) => !['name', 'value'].includes(key))) {
        throw new Error('UNSAFE_SECRET_CONTENT');
      }
      const raw = value.value;
      if (raw === null || raw === undefined || raw === '')
        throw new Error('UNSAFE_SECRET_CONTENT');
      const output: Record<string, unknown> = { name: descriptorName, value: REDACTED };
      addPath(state, `${path}.value`);
      return output;
    }
    if (
      keys.length === 1 ||
      keys.some((key) => !SAFE_FIELD_DESCRIPTOR_KEYS.has(key))
    ) {
      throw new Error('UNSAFE_SECRET_CONTENT');
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (kind === 'response-body' && key === 'body' && typeof raw === 'string') {
      const scrubbedBody = redactResponseText(raw, state);
      if (scrubbedBody === null) throw new Error('UNSAFE_SECRET_CONTENT');
      output[key] = scrubbedBody;
      continue;
    }
    if (
      /^(?:message|error|errortext|text)$/i.test(key) &&
      typeof raw === 'string'
    ) {
      throw new Error('UNSAFE_SECRET_CONTENT');
    }
    if (isSensitiveKey(key)) {
      if (raw !== null && raw !== undefined && raw !== '') {
        output[key] = REDACTED;
        addPath(state, childPath);
      } else {
        output[key] = raw;
      }
      continue;
    }
    output[key] = redactValue(raw, childPath, kind, state, depth + 1);
  }
  return output;
}

function redactResponseText(value: string, state: MutableState): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* The existing bounded HMS extractor is the only accepted non-strict fallback. */
    const pageData = extractHmsPageDataRecord(value);
    if (!pageData) return null;
    const scrubbed = redactValue(pageData, '$.pageData', 'response-body', state, 1);
    return JSON.stringify({ pageData: scrubbed });
  }
  return JSON.stringify(redactValue(parsed, '$', 'response-body', state, 1));
}

function redactTopLevelString(
  value: string,
  kind: StagehandCaptureKind,
  state: MutableState,
): string | null {
  if (kind === 'message') return null;
  if (kind === 'response-body') return redactResponseText(value, state);
  if (value === '') return value;
  if (looksLikeJson(value)) {
    try {
      return JSON.stringify(redactValue(JSON.parse(value) as unknown, '$', kind, state, 1));
    } catch {
      return null;
    }
  }
  if (!looksLikeKnownRequestText(value)) return null;
  return redactString(value, '$', kind, state, 0);
}

export function redactStagehandCapture<T>(
  value: T,
  kind: StagehandCaptureKind,
): StagehandCaptureRedactionResult<T> {
  const state: MutableState = { redactedPaths: new Set<string>() };
  try {
    const scrubbed =
      typeof value === 'string'
        ? redactTopLevelString(value, kind, state)
        : redactValue(value, '$', kind, state, 0);
    if (scrubbed === null) return { ok: false, reason: 'UNSAFE_SECRET_CONTENT' };
    return {
      ok: true,
      value: scrubbed as T,
      redactedPaths: [...state.redactedPaths].sort(),
    };
  } catch {
    return { ok: false, reason: 'UNSAFE_SECRET_CONTENT' };
  }
}
