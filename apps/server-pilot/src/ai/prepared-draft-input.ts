/**
 * Closed, bounded input contract for U5 drafting, extraction and judging.
 *
 * This module is deliberately model-agnostic. It freezes the authorized
 * request facts before anything is serialized into a prompt, workflow trace,
 * or adapter transport. Mail text is evidence and remains clearly delimited;
 * it is never treated as an instruction or authority grant.
 */

export const PREPARED_DRAFT_INPUT_VERSION = 'u5-prepared-draft-input-v1';
export const MAX_PREPARED_REQUEST_TEXT = 8_192;
export const MAX_PREPARED_FACTS = 64;
export const MAX_PREPARED_ASKS = 32;
export const MAX_PREPARED_POLICY_RULES = 32;
export const MAX_PREPARED_ATTACHMENTS = 8;
export const MAX_PREPARED_CAPABILITIES = 32;
export const MAX_PREPARED_SERIALIZED_BYTES = 48_000;

export type PreparedDraftAudience = 'guest' | 'internal';
export type PreparedFactSource =
  | 'inbound'
  | 'mail'
  | 'hms'
  | 'property'
  | 'policy'
  | 'attachment'
  | 'action';
export type PreparedFactAuthority = 'authorized' | 'untrusted' | 'unknown';
export type PreparedFactStatus = 'known' | 'unknown' | 'partial' | 'not_authorized';

export type PreparedFact = {
  key: string;
  label: string;
  value: unknown;
  source: PreparedFactSource;
  authority: PreparedFactAuthority;
  status: PreparedFactStatus;
  evidenceRef?: string;
  observedAt?: string;
  disclosure?: 'guest' | 'staff_only';
};

export type PreparedAsk = {
  code: string;
  label: string;
  required?: boolean;
  acquisition?: string;
  capabilityId?: string;
};

export type PreparedPolicy = {
  version: string;
  rules: string[];
};

export type PreparedAttachment = {
  artifactRef: string;
  sourceHash?: string;
  kind?: 'pdf' | 'image' | 'text' | 'other';
};

export type PreparedDraftInput = {
  schemaVersion: typeof PREPARED_DRAFT_INPUT_VERSION;
  requestId: string;
  threadId?: string;
  audience: PreparedDraftAudience;
  requestText: string;
  requestTextTruncated: boolean;
  asks: PreparedAsk[];
  facts: PreparedFact[];
  policy?: PreparedPolicy;
  authorizedAttachments: PreparedAttachment[];
  releasedCapabilities: Record<string, string>;
};

export type PrepareDraftInputRequest = {
  requestId?: string;
  threadId?: string;
  audience: PreparedDraftAudience;
  inboundText?: string;
  requestText?: string;
  asks?: readonly PreparedAsk[];
  facts?: readonly PreparedFact[];
  policy?: PreparedPolicy;
  authorizedAttachments?: readonly PreparedAttachment[];
  releasedCapabilities?: Readonly<Record<string, string>>;
};

export class PreparedDraftInputError extends Error {
  readonly code: 'INPUT_MISSING' | 'INPUT_TOO_LARGE' | 'SENSITIVE_INPUT' | 'INVALID_INPUT';

  constructor(code: PreparedDraftInputError['code'], message: string) {
    super(message);
    this.name = 'PreparedDraftInputError';
    this.code = code;
  }
}

const SENSITIVE_KEY =
  /(?:password|passphrase|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cvv|cvc|card[_-]?(?:number|pan)|routing(?:[_-]?number)?|account(?:[_-]?number)?)/i;
const SENSITIVE_TEXT =
  /(?:password|passphrase|secret|api[_-]?key|authorization|bearer|token|cvv|cvc|card[_-]?(?:number|pan)|routing(?:[_-]?number)?|account(?:[_-]?number)?)\s*(?:[:=]|is)\s*[^\s,;]+/i;
const FACT_SOURCES = new Set<PreparedFactSource>([
  'inbound',
  'mail',
  'hms',
  'property',
  'policy',
  'attachment',
  'action',
]);
const FACT_AUTHORITIES = new Set<PreparedFactAuthority>(['authorized', 'untrusted', 'unknown']);
const FACT_STATUSES = new Set<PreparedFactStatus>([
  'known',
  'unknown',
  'partial',
  'not_authorized',
]);
const ATTACHMENT_KINDS = new Set<NonNullable<PreparedAttachment['kind']>>([
  'pdf',
  'image',
  'text',
  'other',
]);

function assertBoundedString(value: string, name: string, max: number): string {
  if (typeof value !== 'string') {
    throw new PreparedDraftInputError('INVALID_INPUT', `${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new PreparedDraftInputError('INPUT_MISSING', `${name} is required`);
  }
  if (trimmed.length > max) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', `${name} exceeds its bounded limit`);
  }
  return trimmed;
}

function assertSafeValue(value: unknown, path: string, depth = 0, seen = new Set<object>()): void {
  if (depth > 8) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', `${path} is too deeply nested`);
  }
  if (typeof value === 'string') {
    if (value.length > 4_096) {
      throw new PreparedDraftInputError('INPUT_TOO_LARGE', `${path} exceeds its bounded limit`);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) {
      throw new PreparedDraftInputError('SENSITIVE_INPUT', `${path} contains private key material`);
    }
    if (SENSITIVE_TEXT.test(value)) {
      throw new PreparedDraftInputError(
        'SENSITIVE_INPUT',
        `${path} contains sensitive credential-shaped text`,
      );
    }
    return;
  }
  if (value === null) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PreparedDraftInputError('INVALID_INPUT', `${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new PreparedDraftInputError('INVALID_INPUT', `${path} contains a cyclic value`);
    }
    seen.add(value);
    if (value.length > 64) {
      throw new PreparedDraftInputError('INPUT_TOO_LARGE', `${path} contains too many values`);
    }
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`, depth + 1));
    seen.delete(value);
    return;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new PreparedDraftInputError('INVALID_INPUT', `${path} contains a cyclic value`);
    }
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new PreparedDraftInputError('SENSITIVE_INPUT', `${path}.${key} is sensitive`);
      }
      assertSafeValue(nested, `${path}.${key}`, depth + 1);
    }
    seen.delete(value);
    return;
  }
  throw new PreparedDraftInputError('INVALID_INPUT', `${path} contains an unsupported value`);
}

function copySafeValue(value: unknown): unknown {
  // assertSafeValue has already restricted values to JSON-compatible scalar,
  // array and record data, so this copy cannot carry a live caller reference.
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function cloneFact(fact: PreparedFact, index: number): PreparedFact {
  const key = assertBoundedString(fact.key, `facts[${index}].key`, 128);
  const label = assertBoundedString(fact.label, `facts[${index}].label`, 160);
  if (SENSITIVE_KEY.test(key) || SENSITIVE_KEY.test(label)) {
    throw new PreparedDraftInputError('SENSITIVE_INPUT', `facts[${index}] is sensitive`);
  }
  if (!FACT_SOURCES.has(fact.source)) {
    throw new PreparedDraftInputError('INVALID_INPUT', `facts[${index}].source is invalid`);
  }
  if (!FACT_AUTHORITIES.has(fact.authority)) {
    throw new PreparedDraftInputError('INVALID_INPUT', `facts[${index}].authority is invalid`);
  }
  if (!FACT_STATUSES.has(fact.status)) {
    throw new PreparedDraftInputError('INVALID_INPUT', `facts[${index}].status is invalid`);
  }
  assertSafeValue(fact.value, `facts[${index}].value`);
  return {
    key,
    label,
    value: copySafeValue(fact.value),
    source: fact.source,
    authority: fact.authority,
    status: fact.status,
    ...(fact.evidenceRef
      ? { evidenceRef: assertBoundedString(fact.evidenceRef, 'evidenceRef', 256) }
      : {}),
    ...(fact.observedAt
      ? { observedAt: assertBoundedString(fact.observedAt, 'observedAt', 64) }
      : {}),
    ...(fact.disclosure ? { disclosure: fact.disclosure } : {}),
  };
}

function cloneAsk(ask: PreparedAsk, index: number): PreparedAsk {
  const code = assertBoundedString(ask.code, `asks[${index}].code`, 96);
  const label = assertBoundedString(ask.label, `asks[${index}].label`, 160);
  if (SENSITIVE_KEY.test(code) || SENSITIVE_KEY.test(label)) {
    throw new PreparedDraftInputError('SENSITIVE_INPUT', `asks[${index}] is sensitive`);
  }
  return {
    code,
    label,
    ...(ask.required === undefined ? {} : { required: Boolean(ask.required) }),
    ...(ask.acquisition
      ? { acquisition: assertBoundedString(ask.acquisition, 'ask acquisition', 256) }
      : {}),
    ...(ask.capabilityId
      ? { capabilityId: assertBoundedString(ask.capabilityId, 'ask capabilityId', 128) }
      : {}),
  };
}

function clonePolicy(policy: PreparedPolicy | undefined): PreparedPolicy | undefined {
  if (!policy) return undefined;
  const version = assertBoundedString(policy.version, 'policy.version', 128);
  if (!Array.isArray(policy.rules)) {
    throw new PreparedDraftInputError('INVALID_INPUT', 'policy.rules must be an array');
  }
  if (policy.rules.length > MAX_PREPARED_POLICY_RULES) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'policy has too many rules');
  }
  const rules = policy.rules.map((rule, index) =>
    assertBoundedString(rule, `policy.rules[${index}]`, 1_024),
  );
  return { version, rules };
}

function cloneAttachment(attachment: PreparedAttachment, index: number): PreparedAttachment {
  const artifactRef = assertBoundedString(
    attachment.artifactRef,
    `authorizedAttachments[${index}].artifactRef`,
    256,
  );
  if (SENSITIVE_KEY.test(artifactRef)) {
    throw new PreparedDraftInputError('SENSITIVE_INPUT', 'attachment reference is sensitive');
  }
  if (attachment.kind !== undefined && !ATTACHMENT_KINDS.has(attachment.kind)) {
    throw new PreparedDraftInputError('INVALID_INPUT', 'attachment kind is invalid');
  }
  return {
    artifactRef,
    ...(attachment.sourceHash
      ? { sourceHash: assertBoundedString(attachment.sourceHash, 'sourceHash', 128) }
      : {}),
    ...(attachment.kind ? { kind: attachment.kind } : {}),
  };
}

/** Freeze and validate authorized material before prompt/workflow serialization. */
export function prepareDraftInput(input: PrepareDraftInputRequest): PreparedDraftInput {
  const requestTextRaw = input.requestText ?? input.inboundText ?? '';
  const requestText = typeof requestTextRaw === 'string' ? requestTextRaw.trim() : '';
  if (!requestText) {
    throw new PreparedDraftInputError('INPUT_MISSING', 'request text is required');
  }
  const requestTextTruncated = requestText.length > MAX_PREPARED_REQUEST_TEXT;
  const boundedRequestText = requestText.slice(0, MAX_PREPARED_REQUEST_TEXT);

  const facts = [...(input.facts ?? [])];
  const asks = [...(input.asks ?? [])];
  const attachments = [...(input.authorizedAttachments ?? [])];
  if (facts.length > MAX_PREPARED_FACTS) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'too many facts');
  }
  if (asks.length > MAX_PREPARED_ASKS) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'too many asks');
  }
  if (attachments.length > MAX_PREPARED_ATTACHMENTS) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'too many attachments');
  }
  const capabilityEntries = Object.entries(input.releasedCapabilities ?? {});
  if (capabilityEntries.length > MAX_PREPARED_CAPABILITIES) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'too many released capabilities');
  }
  assertSafeValue(boundedRequestText, 'requestText');

  if (input.audience !== 'guest' && input.audience !== 'internal') {
    throw new PreparedDraftInputError('INVALID_INPUT', 'audience is invalid');
  }
  const requestId = input.requestId
    ? assertBoundedString(input.requestId, 'requestId', 128)
    : 'request-unknown';
  const threadId = input.threadId
    ? assertBoundedString(input.threadId, 'threadId', 256)
    : undefined;
  const prepared: PreparedDraftInput = {
    schemaVersion: PREPARED_DRAFT_INPUT_VERSION,
    requestId,
    ...(threadId ? { threadId } : {}),
    audience: input.audience,
    requestText: boundedRequestText,
    requestTextTruncated,
    asks: asks.map(cloneAsk),
    facts: facts.map(cloneFact),
    ...(input.policy ? { policy: clonePolicy(input.policy) } : {}),
    authorizedAttachments: attachments.map(cloneAttachment),
    releasedCapabilities: Object.fromEntries(
      capabilityEntries.map(([key, value]) => [
        assertBoundedString(key, 'capability key', 128),
        assertBoundedString(value, 'capability version', 128),
      ]),
    ),
  };

  const serialized = JSON.stringify(prepared);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PREPARED_SERIALIZED_BYTES) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'prepared input exceeds serialized limit');
  }
  return deepFreeze(prepared);
}

/** Stable JSON prompt payload; callers must pass the prepared object, not raw mail. */
export function serializePreparedDraftInput(input: PreparedDraftInput): string {
  if (!input || input.schemaVersion !== PREPARED_DRAFT_INPUT_VERSION) {
    throw new PreparedDraftInputError('INVALID_INPUT', 'prepared input schema version is invalid');
  }
  if (
    !Array.isArray(input.facts) ||
    !Array.isArray(input.asks) ||
    !Array.isArray(input.authorizedAttachments)
  ) {
    throw new PreparedDraftInputError('INVALID_INPUT', 'prepared input collections are invalid');
  }
  if (
    input.facts.length > MAX_PREPARED_FACTS ||
    input.asks.length > MAX_PREPARED_ASKS ||
    input.authorizedAttachments.length > MAX_PREPARED_ATTACHMENTS ||
    Object.keys(input.releasedCapabilities ?? {}).length > MAX_PREPARED_CAPABILITIES
  ) {
    throw new PreparedDraftInputError(
      'INPUT_TOO_LARGE',
      'prepared input collections exceed bounds',
    );
  }
  assertSafeValue(input.requestText, 'requestText');
  input.facts.forEach((fact, index) => {
    cloneFact(fact, index);
  });
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PREPARED_SERIALIZED_BYTES) {
    throw new PreparedDraftInputError('INPUT_TOO_LARGE', 'prepared input exceeds serialized limit');
  }
  return serialized;
}

export const preparedDraftInputToPrompt = serializePreparedDraftInput;
