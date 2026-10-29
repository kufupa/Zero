/**
 * Canonical fail-closed HMS request policy.
 * Fixture / reviewed signatures only — never mutate PMS, never log raw values.
 */

import type {
  RedactedRequestSignature,
  RequestDecision,
  RequestPolicyManifest,
  RequestRule,
} from './contracts.js';
import {
  equalDigestHex,
  hmacSha256PrivateValue,
} from './private-digests.js';

export const BLOCK_CODES = {
  UNKNOWN_ORIGIN: 'unknown_origin',
  UNKNOWN_PATH: 'unknown_path',
  UNKNOWN_METHOD: 'unknown_method',
  UNKNOWN_RESOURCE_TYPE: 'unknown_resource_type',
  EXTRA_QUERY: 'extra_query',
  MISSING_FIXED_QUERY: 'missing_fixed_query',
  CHANGED_FIXED_QUERY: 'changed_fixed_query',
  DUPLICATE_QUERY: 'duplicate_query',
  EXTRA_BODY: 'extra_body',
  MISSING_FIXED_BODY: 'missing_fixed_body',
  CHANGED_FIXED_BODY: 'changed_fixed_body',
  DUPLICATE_BODY: 'duplicate_body',
  INVALID_VARIABLE_QUERY: 'invalid_variable_query',
  INVALID_VARIABLE_BODY: 'invalid_variable_body',
  REQUIRED_CONTENT_TYPE: 'required_content_type',
  REQUIRED_HEADER_HMAC: 'required_header_hmac',
  QUERY_KEY_SEQUENCE: 'query_key_sequence',
  BODY_KEY_SEQUENCE: 'body_key_sequence',
  MALFORMED_ENCODING: 'malformed_encoding',
  MALFORMED_JSON: 'malformed_json',
  MALFORMED_MULTIPART: 'malformed_multipart',
  OVERSIZED_BODY: 'oversized_body',
  MUTATION_ACTION: 'mutation_action',
  SUBMIT_BUTTON: 'submit_button',
  CHANGED_TENANT: 'changed_tenant',
  CHANGED_PROPERTY: 'changed_property',
  CROSS_ORIGIN_REDIRECT: 'cross_origin_redirect',
  UNREVIEWED_REDIRECT: 'unreviewed_redirect',
  WEBSOCKET: 'websocket',
  POPUP: 'popup',
  DOWNLOAD: 'download',
  SERVICE_WORKER: 'service_worker',
  DATA_URL: 'data_url',
  BLOB_URL: 'blob_url',
  CRS_CHECK_AVAILABILITY: 'crs_check_availability',
  UNMATCHED_REQUEST: 'unmatched_request',
} as const;

export type BlockCode = (typeof BLOCK_CODES)[keyof typeof BLOCK_CODES];

/** Lightweight Playwright Route stand-in (server-pilot has no playwright dep). */
export type PolicyRouteRequest = {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  postData(): string | null;
  redirectedFrom(): { url(): string } | null;
  isNavigationRequest(): boolean;
};

export type PolicyRoute = {
  request(): PolicyRouteRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

export type ObservedRequestInput = {
  url: string;
  method: string;
  resourceType: string;
  headers?: Record<string, string>;
  postData?: string | null;
  redirectedFrom?: string | null;
};

export type RequestPolicyPrivateDigestContext = {
  key: string | Buffer;
  keyVersion: string;
};

const KEY_SEQUENCE = Symbol('requestKeySequence');
type Multimap = Map<string, string[]> & {
  [KEY_SEQUENCE]: string[];
};

const SUBMIT_KEY_RE =
  /^(submit|btn(save|delete|create|amend|cancel|ok|yes)|.*\.action)$/i;
const MUTATION_ACTION_RE =
  /^(delete|save|create|amend|cancel|post|settle|refund|send|print|export|submit|checkavailability|check.?availability)$/i;
const MUTATION_ACTION_TOKEN_RE =
  /(?:^|[.:/\\\s_-])(?:delete|save|create|amend|cancel|post|settle|refund|send|print|export|submit|check[\s._-]*availability)(?:$|[.:/\\\s_-])/i;
const MUTATION_CONTROL_KEY_RE =
  /(?:^|[_-])(?:action|function|command|event|button)(?:$|[_-])/i;
const CRS_PATH_RE = /\/crs\/check-availability|checkavailability/i;
const MUTATION_FIELD_MAX_BYTES = 8 * 1024;
const AUTOSAVE_KEY_RE = /autosave|auto[_-]?save/i;

/** Decode at most two percent-encoding rounds; residual %xx fails closed. */
export function normalizeMutationFieldText(
  raw: string,
): { ok: true; value: string } | { ok: false; code: BlockCode } {
  if (Buffer.byteLength(raw) > MUTATION_FIELD_MAX_BYTES) {
    return { ok: false, code: BLOCK_CODES.OVERSIZED_BODY };
  }
  let current = raw;
  for (let round = 0; round < 2; round++) {
    if (hasMalformedPercentEncoding(current)) {
      return { ok: false, code: BLOCK_CODES.MALFORMED_ENCODING };
    }
    if (!/%[0-9A-Fa-f]{2}/.test(current)) break;
    try {
      const next = decodeURIComponent(current.replace(/\+/g, ' '));
      if (next === current) break;
      current = next;
    } catch {
      return { ok: false, code: BLOCK_CODES.MALFORMED_ENCODING };
    }
  }
  if (/%[0-9A-Fa-f]{2}/.test(current)) {
    return { ok: false, code: BLOCK_CODES.MALFORMED_ENCODING };
  }
  return { ok: true, value: current };
}

function mutationShapeInText(
  text: string,
  allowEmbeddedTokens = false,
): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (
    MUTATION_ACTION_RE.test(text.trim()) ||
    (allowEmbeddedTokens && MUTATION_ACTION_TOKEN_RE.test(text.trim()))
  ) {
    return true;
  }
  if (
    /^(delete|save|create|amend|cancel|post|settle|refund|send|print|export|submit|checkavailability)$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

/** Recursively inspect keys/values for mutation / autosave / encoded variants. */
export function scanMultimapForMutation(map: Multimap): BlockCode | null {
  for (const [key, values] of map) {
    const keyNorm = normalizeMutationFieldText(key);
    if (!keyNorm.ok) return keyNorm.code;
    if (AUTOSAVE_KEY_RE.test(keyNorm.value)) {
      return BLOCK_CODES.MUTATION_ACTION;
    }
    if (SUBMIT_KEY_RE.test(keyNorm.value)) {
      return BLOCK_CODES.SUBMIT_BUTTON;
    }
    if (mutationShapeInText(keyNorm.value)) {
      return BLOCK_CODES.MUTATION_ACTION;
    }
    const mutationControl = MUTATION_CONTROL_KEY_RE.test(keyNorm.value);
    for (const value of values) {
      const valNorm = normalizeMutationFieldText(value);
      if (!valNorm.ok) return valNorm.code;
      if (mutationShapeInText(valNorm.value, mutationControl)) {
        return BLOCK_CODES.MUTATION_ACTION;
      }
      // Nested JSON string values (e.g. payload={"action":"save"})
      const nestedText = valNorm.value.trim();
      if (
        (nestedText.startsWith('{') && nestedText.endsWith('}')) ||
        (nestedText.startsWith('[') && nestedText.endsWith(']'))
      ) {
        try {
          const nested = JSON.parse(nestedText) as unknown;
          rejectDuplicateJsonBodyKeys(nestedText);
          const nestedHit = scanJsonForMutation(nested, 0, mutationControl);
          if (nestedHit) return nestedHit;
        } catch (error) {
          if (error instanceof DuplicateJsonBodyKeyError) return BLOCK_CODES.MALFORMED_JSON;
          /* not JSON — continue */
        }
      }
    }
  }
  return null;
}

function scanJsonForMutation(
  value: unknown,
  depth = 0,
  mutationControl = false,
): BlockCode | null {
  if (depth > 8) return BLOCK_CODES.MALFORMED_JSON;
  if (typeof value === 'string') {
    const norm = normalizeMutationFieldText(value);
    if (!norm.ok) return norm.code;
    if (mutationShapeInText(norm.value, mutationControl)) return BLOCK_CODES.MUTATION_ACTION;
    const nestedText = norm.value.trim();
    if (
      (nestedText.startsWith('{') && nestedText.endsWith('}')) ||
      (nestedText.startsWith('[') && nestedText.endsWith(']'))
    ) {
      try {
        const nested = JSON.parse(nestedText) as unknown;
        rejectDuplicateJsonBodyKeys(nestedText);
        return scanJsonForMutation(nested, depth + 1, mutationControl);
      } catch (error) {
        if (error instanceof DuplicateJsonBodyKeyError) return BLOCK_CODES.MALFORMED_JSON;
      }
    }
    return null;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanJsonForMutation(item, depth + 1, mutationControl);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyNorm = normalizeMutationFieldText(k);
      if (!keyNorm.ok) return keyNorm.code;
      if (AUTOSAVE_KEY_RE.test(keyNorm.value) || mutationShapeInText(keyNorm.value)) {
        return BLOCK_CODES.MUTATION_ACTION;
      }
      const hit = scanJsonForMutation(
        v,
        depth + 1,
        MUTATION_CONTROL_KEY_RE.test(keyNorm.value),
      );
      if (hit) return hit;
    }
  }
  return null;
}

export class FixtureRequestRecorder {
  #items: Array<{ method: string; path: string; ruleId: string }> = [];

  record(entry: { method: string; path: string; ruleId: string }): void {
    this.#items.push(entry);
  }

  requests(): Array<{ method: string; path: string; ruleId: string }> {
    return [...this.#items];
  }
}

export function contextCreationOptions(): {
  acceptDownloads: false;
  serviceWorkers: 'block';
  ignoreHTTPSErrors: true;
} {
  return {
    acceptDownloads: false,
    serviceWorkers: 'block',
    // Live hotel HMS presents a private/VPN TLS chain; without this, Chromium
    // aborts mid-session XHRs and ExtJS navigates to /web/base/loadlogin
    // (unknown_path → session teardown → false POLICY_BLOCK).
    ignoreHTTPSErrors: true,
  };
}

export function reviewedPaths(manifest: RequestPolicyManifest): Set<string> {
  return new Set(manifest.rules.map((rule) => rule.path));
}

function mediaTypeOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  return contentType.split(';', 1)[0]?.trim().toLowerCase();
}

function headerLookup(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

function hasMalformedPercentEncoding(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== '%') continue;
    if (i + 2 >= input.length) return true;
    if (!/^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) return true;
    i += 2;
  }
  return false;
}

function emptyMultimap(): Multimap {
  const map = new Map<string, string[]>() as Multimap;
  Object.defineProperty(map, KEY_SEQUENCE, {
    value: [],
    writable: false,
    enumerable: false,
  });
  return map;
}

function appendMultimap(map: Multimap, key: string, value: string): void {
  map[KEY_SEQUENCE].push(key);
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Parse query/body into a multimap while retaining exact wire key order. */
export function parseUrlEncodedMultimap(raw: string): Multimap {
  const map = emptyMultimap();
  if (!raw) return map;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const encKey = eq === -1 ? part : part.slice(0, eq);
    const encVal = eq === -1 ? '' : part.slice(eq + 1);
    const key = decodeURIComponent(encKey.replace(/\+/g, ' '));
    const value = decodeURIComponent(encVal.replace(/\+/g, ' '));
    appendMultimap(map, key, value);
  }
  return map;
}

class DuplicateJsonBodyKeyError extends Error {}

/** JSON.parse keeps only the last duplicate, which can hide a mutation value. */
function rejectDuplicateJsonBodyKeys(raw: string): void {
  const scopes: Array<{ kind: 'object'; keys: Set<string>; expectingKey: boolean } | { kind: 'array' }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < raw.length) {
        if (raw[index] === '\\') { index += 2; continue; }
        if (raw[index] === '"') break;
        index += 1;
      }
      const scope = scopes.at(-1);
      if (scope?.kind === 'object' && scope.expectingKey) {
        // The whole document was parsed first, so this is a valid JSON string.
        const key = JSON.parse(raw.slice(start, index + 1)) as string;
        if (scope.keys.has(key)) throw new DuplicateJsonBodyKeyError();
        scope.keys.add(key);
        scope.expectingKey = false;
      }
    } else if (char === '{') {
      scopes.push({ kind: 'object', keys: new Set(), expectingKey: true });
    } else if (char === '[') {
      scopes.push({ kind: 'array' });
    } else if (char === '}' || char === ']') {
      scopes.pop();
    } else if (char === ',') {
      const scope = scopes.at(-1);
      if (scope?.kind === 'object') scope.expectingKey = true;
    }
  }
}

function parseJsonObjectMultimap(raw: string): Multimap {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('json_root');
  }
  rejectDuplicateJsonBodyKeys(raw);
  const map = emptyMultimap();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') {
      appendMultimap(map, key, value);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      for (const item of value) appendMultimap(map, key, item);
    } else {
      throw new Error('json_value');
    }
  }
  return map;
}

function parseMultipartMultimap(
  raw: string,
  contentType: string,
): Multimap {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
  if (!boundary) throw new Error('multipart_boundary');

  const delimiter = `--${boundary}`;
  const parts = raw.split(delimiter);
  if (parts.length < 3) throw new Error('multipart_parts');

  const map = emptyMultimap();
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n' || part.trim() === '--') {
      continue;
    }
    let body = part;
    if (body.startsWith('\r\n')) body = body.slice(2);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    if (body === '--') continue;

    const sep = body.indexOf('\r\n\r\n');
    if (sep === -1) throw new Error('multipart_headers');
    const headerBlock = body.slice(0, sep);
    const value = body.slice(sep + 4).replace(/\r\n$/, '');
    const nameMatch = /content-disposition:\s*form-data;\s*name="([^"]+)"/i.exec(
      headerBlock,
    );
    if (!nameMatch) throw new Error('multipart_name');
    appendMultimap(map, nameMatch[1]!, value);
  }
  return map;
}

function orderedKeys(map: Multimap): string[] {
  return [...map[KEY_SEQUENCE]];
}

function expectedValues(
  spec: string | string[] | undefined,
): string[] | undefined {
  if (spec === undefined) return undefined;
  return Array.isArray(spec) ? [...spec].sort() : [spec];
}

function expectsArray(spec: string | string[] | undefined): boolean {
  return Array.isArray(spec);
}

function valuesEqual(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((value, index) => value === b[index]);
}

function anchoredRegex(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

function validateVariable(
  values: string[],
  rule: { pattern: string; maxLength: number },
): boolean {
  const re = anchoredRegex(rule.pattern);
  return values.every(
    (value) => value.length <= rule.maxLength && re.test(value),
  );
}

function buildRedactedSignature(input: {
  method: string;
  origin: string;
  path: string;
  resourceType: string;
  contentType?: string;
  queryKeys: string[];
  bodyKeys: string[];
  bodyBytes: number;
}): RedactedRequestSignature {
  return {
    method: input.method,
    origin: input.origin,
    path: input.path,
    resourceType: input.resourceType,
    contentType: input.contentType,
    queryKeys: [...input.queryKeys],
    bodyKeys: [...input.bodyKeys],
    bodyBytes: input.bodyBytes,
  };
}

function block(
  code: string,
  signature: RedactedRequestSignature,
): RequestDecision {
  return { action: 'block', code, redactedSignature: signature };
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function classifyBodyParse(
  postData: string,
  contentTypeHeader: string | undefined,
):
  | { ok: true; map: Multimap; mediaType: string | undefined }
  | { ok: false; code: BlockCode } {
  const mediaType = mediaTypeOf(contentTypeHeader);

  if (mediaType === 'application/json') {
    try {
      return {
        ok: true,
        map: parseJsonObjectMultimap(postData),
        mediaType,
      };
    } catch (error) {
      return { ok: false, code: error instanceof DuplicateJsonBodyKeyError
        ? BLOCK_CODES.DUPLICATE_BODY : BLOCK_CODES.MALFORMED_JSON };
    }
  }

  if (mediaType?.startsWith('multipart/form-data')) {
    try {
      return {
        ok: true,
        map: parseMultipartMultimap(postData, contentTypeHeader ?? ''),
        mediaType,
      };
    } catch {
      return { ok: false, code: BLOCK_CODES.MALFORMED_MULTIPART };
    }
  }

  const encoded =
    mediaType === 'application/x-www-form-urlencoded' ||
    mediaType === undefined;
  if (encoded) {
    if (hasMalformedPercentEncoding(postData)) {
      return { ok: false, code: BLOCK_CODES.MALFORMED_ENCODING };
    }
    try {
      return {
        ok: true,
        map: parseUrlEncodedMultimap(postData),
        mediaType: mediaType ?? 'application/x-www-form-urlencoded',
      };
    } catch {
      return { ok: false, code: BLOCK_CODES.MALFORMED_ENCODING };
    }
  }

  return { ok: false, code: BLOCK_CODES.UNMATCHED_REQUEST };
}

function compareMultimapAgainstRule(
  actual: Multimap,
  fixed: Record<string, string | string[]>,
  variable: Record<
    string,
    {
      pattern: string;
      maxLength: number;
    }
  >,
  kind: 'query' | 'body',
): BlockCode | null {
  const fixedKeys = new Set(Object.keys(fixed));
  const variableKeys = new Set(Object.keys(variable));
  const allowedKeys = new Set([...fixedKeys, ...variableKeys]);

  for (const key of actual.keys()) {
    if (!allowedKeys.has(key)) {
      if (kind === 'body' && SUBMIT_KEY_RE.test(key)) {
        return BLOCK_CODES.SUBMIT_BUTTON;
      }
      return kind === 'query' ? BLOCK_CODES.EXTRA_QUERY : BLOCK_CODES.EXTRA_BODY;
    }
  }

  for (const key of fixedKeys) {
    const spec = fixed[key]!;
    const values = actual.get(key);
    if (!values || values.length === 0) {
      return kind === 'query'
        ? BLOCK_CODES.MISSING_FIXED_QUERY
        : BLOCK_CODES.MISSING_FIXED_BODY;
    }
    if (values.length > 1 && !expectsArray(spec)) {
      return kind === 'query'
        ? BLOCK_CODES.DUPLICATE_QUERY
        : BLOCK_CODES.DUPLICATE_BODY;
    }
    const expected = expectedValues(spec)!;
    if (!valuesEqual(values, expected)) {
      if (kind === 'body' && key.toLowerCase() === 'tenant') {
        return BLOCK_CODES.CHANGED_TENANT;
      }
      if (kind === 'body' && key.toLowerCase() === 'property') {
        return BLOCK_CODES.CHANGED_PROPERTY;
      }
      if (kind === 'body' && key.toLowerCase() === 'action') {
        const joined = values.join('\0');
        if (MUTATION_ACTION_RE.test(joined)) {
          return BLOCK_CODES.MUTATION_ACTION;
        }
      }
      return kind === 'query'
        ? BLOCK_CODES.CHANGED_FIXED_QUERY
        : BLOCK_CODES.CHANGED_FIXED_BODY;
    }
  }

  for (const key of variableKeys) {
    const values = actual.get(key);
    if (!values || values.length === 0) {
      // variable keys are required when declared in the reviewed template
      return kind === 'query'
        ? BLOCK_CODES.INVALID_VARIABLE_QUERY
        : BLOCK_CODES.INVALID_VARIABLE_BODY;
    }
    if (values.length > 1) {
      return kind === 'query'
        ? BLOCK_CODES.DUPLICATE_QUERY
        : BLOCK_CODES.DUPLICATE_BODY;
    }
    if (!validateVariable(values, variable[key]!)) {
      return kind === 'query'
        ? BLOCK_CODES.INVALID_VARIABLE_QUERY
        : BLOCK_CODES.INVALID_VARIABLE_BODY;
    }
  }

  return null;
}

function keySequencesEqual(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function requiredHeaderHmacsMatch(
  rule: RequestRule,
  headers: Record<string, string>,
  privateDigest: RequestPolicyPrivateDigestContext | undefined,
): boolean {
  const declarations = Object.entries(rule.requiredHeaderHmacs ?? {});
  if (declarations.length === 0) return true;
  if (!privateDigest) return false;

  try {
    for (const [name, declaration] of declarations) {
      const value = headerLookup(headers, name);
      if (
        value === undefined ||
        declaration.privateDigestKeyVersion !== privateDigest.keyVersion
      ) {
        return false;
      }
      const observed = hmacSha256PrivateValue({
        key: privateDigest.key,
        keyVersion: privateDigest.keyVersion,
        purpose: declaration.purpose,
        value: `${name}\0${value}`,
      }).hmacSha256;
      if (!equalDigestHex(observed, declaration.hmacSha256)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function evaluateAgainstRule(
  rule: RequestRule,
  input: {
    method: string;
    resourceType: string;
    queryRaw: string;
    queryMap: Multimap;
    postData: string;
    bodyMap: Multimap | null;
    bodyParseError: BlockCode | null;
    contentType?: string;
    headers: Record<string, string>;
    privateDigest?: RequestPolicyPrivateDigestContext;
    bodyBytes: number;
  },
): RequestDecision | null {
  if (rule.method !== input.method) return null;
  if (!rule.resourceTypes.includes(input.resourceType)) return null;

  const signature = (): RedactedRequestSignature =>
    buildRedactedSignature({
      method: input.method,
      origin: rule.origin,
      path: rule.path,
      resourceType: input.resourceType,
      contentType: input.contentType,
      queryKeys: orderedKeys(input.queryMap),
      bodyKeys: input.bodyMap ? orderedKeys(input.bodyMap) : [],
      bodyBytes: input.bodyBytes,
    });

  if (hasMalformedPercentEncoding(input.queryRaw)) {
    return block(BLOCK_CODES.MALFORMED_ENCODING, signature());
  }

  if (input.bodyBytes > rule.maxBodyBytes) {
    return block(BLOCK_CODES.OVERSIZED_BODY, signature());
  }

  if (input.bodyParseError) {
    return block(input.bodyParseError, signature());
  }

  const requiredContentType = rule.requiredContentType ?? rule.contentType;
  if (requiredContentType) {
    const expected = mediaTypeOf(requiredContentType);
    const actual = input.contentType;
    if (!expected || !actual || expected !== actual) {
      return block(
        rule.requiredContentType
          ? BLOCK_CODES.REQUIRED_CONTENT_TYPE
          : BLOCK_CODES.UNMATCHED_REQUEST,
        signature(),
      );
    }
  }

  if (!requiredHeaderHmacsMatch(rule, input.headers, input.privateDigest)) {
    return block(BLOCK_CODES.REQUIRED_HEADER_HMAC, signature());
  }

  if (
    rule.queryKeySequence &&
    !keySequencesEqual(
      orderedKeys(input.queryMap),
      rule.queryKeySequence,
    )
  ) {
    return block(BLOCK_CODES.QUERY_KEY_SEQUENCE, signature());
  }

  const queryError = compareMultimapAgainstRule(
    input.queryMap,
    rule.fixedQuery,
    rule.variableQuery,
    'query',
  );
  if (queryError) return block(queryError, signature());

  const needsBody =
    Object.keys(rule.fixedBody).length > 0 ||
    Object.keys(rule.variableBody).length > 0 ||
    Boolean(requiredContentType);

  if (needsBody) {
    const bodyMap = input.bodyMap ?? emptyMultimap();
    const mutationHit = scanMultimapForMutation(bodyMap);
    if (mutationHit) {
      return block(mutationHit, signature());
    }
    if (
      rule.bodyKeySequence &&
      !keySequencesEqual(orderedKeys(bodyMap), rule.bodyKeySequence)
    ) {
      return block(BLOCK_CODES.BODY_KEY_SEQUENCE, signature());
    }
    // Mutation shortcuts even when fixed action differs
    const actionVals = bodyMap.get('action') ?? bodyMap.get('Action');
    if (
      actionVals &&
      actionVals.some((value) => {
        const n = normalizeMutationFieldText(value);
        return n.ok && MUTATION_ACTION_RE.test(n.value);
      }) &&
      !valuesEqual(
        actionVals,
        expectedValues(rule.fixedBody.action) ?? [],
      )
    ) {
      return block(BLOCK_CODES.MUTATION_ACTION, signature());
    }

    const bodyError = compareMultimapAgainstRule(
      bodyMap,
      rule.fixedBody,
      rule.variableBody,
      'body',
    );
    if (bodyError) return block(bodyError, signature());
  } else if (input.postData.length > 0) {
    return block(BLOCK_CODES.EXTRA_BODY, signature());
  }

  const queryMutation = scanMultimapForMutation(input.queryMap);
  if (queryMutation) return block(queryMutation, signature());

  return { action: 'allow', ruleId: rule.id };
}

export function evaluateObservedRequest(
  manifest: RequestPolicyManifest,
  observed: ObservedRequestInput,
  options?: {
    privateDigest?: RequestPolicyPrivateDigestContext;
  },
): RequestDecision {
  const method = observed.method.toUpperCase();
  const resourceType = observed.resourceType;
  const headers = observed.headers ?? {};
  const postData = observed.postData ?? '';
  const bodyBytes = Buffer.byteLength(postData);
  const contentTypeHeader = headerLookup(headers, 'content-type');
  const contentType = mediaTypeOf(contentTypeHeader);

  const lowerUrl = observed.url.toLowerCase();
  const provisional = (): RedactedRequestSignature =>
    buildRedactedSignature({
      method,
      origin: '',
      path: '',
      resourceType,
      contentType,
      queryKeys: [],
      bodyKeys: [],
      bodyBytes,
    });

  if (lowerUrl.startsWith('data:')) {
    return block(BLOCK_CODES.DATA_URL, {
      ...provisional(),
      origin: 'data:',
      path: 'data:',
    });
  }
  if (lowerUrl.startsWith('blob:')) {
    return block(BLOCK_CODES.BLOB_URL, {
      ...provisional(),
      origin: 'blob:',
      path: 'blob:',
    });
  }
  if (
    lowerUrl.startsWith('ws:') ||
    lowerUrl.startsWith('wss:') ||
    resourceType === 'websocket'
  ) {
    const wsUrl = tryParseUrl(observed.url.replace(/^ws/i, 'http'));
    return block(BLOCK_CODES.WEBSOCKET, {
      ...provisional(),
      origin: wsUrl?.origin ?? '',
      path: wsUrl?.pathname ?? '',
    });
  }
  if (resourceType === 'service_worker') {
    const swUrl = tryParseUrl(observed.url);
    return block(BLOCK_CODES.SERVICE_WORKER, {
      ...provisional(),
      origin: swUrl?.origin ?? '',
      path: swUrl?.pathname ?? '',
    });
  }

  const url = tryParseUrl(observed.url);
  if (!url) {
    return block(BLOCK_CODES.UNMATCHED_REQUEST, provisional());
  }

  const origin = url.origin;
  const path = url.pathname;
  const queryRaw = url.search.startsWith('?') ? url.search.slice(1) : url.search;

  let queryMap = emptyMultimap();
  if (!hasMalformedPercentEncoding(queryRaw)) {
    try {
      queryMap = parseUrlEncodedMultimap(queryRaw);
    } catch {
      return block(
        BLOCK_CODES.MALFORMED_ENCODING,
        buildRedactedSignature({
          method,
          origin,
          path,
          resourceType,
          contentType,
          queryKeys: [],
          bodyKeys: [],
          bodyBytes,
        }),
      );
    }
  }

  const baseSignature = (): RedactedRequestSignature =>
    buildRedactedSignature({
      method,
      origin,
      path,
      resourceType,
      contentType,
      queryKeys: orderedKeys(queryMap),
      bodyKeys: [],
      bodyBytes,
    });

  if (CRS_PATH_RE.test(path) || CRS_PATH_RE.test(observed.url)) {
    return block(BLOCK_CODES.CRS_CHECK_AVAILABILITY, baseSignature());
  }

  if (observed.redirectedFrom) {
    const fromUrl = tryParseUrl(observed.redirectedFrom);
    if (!fromUrl) {
      return block(BLOCK_CODES.UNREVIEWED_REDIRECT, baseSignature());
    }
    if (fromUrl.origin !== origin) {
      return block(BLOCK_CODES.CROSS_ORIGIN_REDIRECT, baseSignature());
    }
    const paths = reviewedPaths(manifest);
    if (!paths.has(fromUrl.pathname) || !paths.has(path)) {
      return block(BLOCK_CODES.UNREVIEWED_REDIRECT, baseSignature());
    }
  }

  const sameOrigin = manifest.rules.filter((rule) => rule.origin === origin);
  if (sameOrigin.length === 0) {
    return block(BLOCK_CODES.UNKNOWN_ORIGIN, baseSignature());
  }

  const samePath = sameOrigin.filter((rule) => rule.path === path);
  if (samePath.length === 0) {
    return block(BLOCK_CODES.UNKNOWN_PATH, baseSignature());
  }

  const sameMethod = samePath.filter((rule) => rule.method === method);
  if (sameMethod.length === 0) {
    return block(BLOCK_CODES.UNKNOWN_METHOD, baseSignature());
  }

  const sameResource = sameMethod.filter((rule) =>
    rule.resourceTypes.includes(resourceType),
  );
  if (sameResource.length === 0) {
    return block(BLOCK_CODES.UNKNOWN_RESOURCE_TYPE, baseSignature());
  }

  let bodyMap: Multimap | null = null;
  let bodyParseError: BlockCode | null = null;
  if (postData.length > 0 || contentTypeHeader) {
    if (hasMalformedPercentEncoding(queryRaw)) {
      return block(BLOCK_CODES.MALFORMED_ENCODING, baseSignature());
    }
    const parsed = classifyBodyParse(postData, contentTypeHeader);
    if (!parsed.ok) {
      bodyParseError = parsed.code;
    } else {
      bodyMap = parsed.map;
    }
  }

  if (hasMalformedPercentEncoding(queryRaw)) {
    return block(BLOCK_CODES.MALFORMED_ENCODING, {
      ...baseSignature(),
      bodyKeys: bodyMap ? orderedKeys(bodyMap) : [],
    });
  }

  let lastBlock: RequestDecision | null = null;
  for (const rule of sameResource) {
    const decision = evaluateAgainstRule(rule, {
      method,
      resourceType,
      queryRaw,
      queryMap,
      postData,
      bodyMap,
      bodyParseError,
      contentType,
      headers,
      privateDigest: options?.privateDigest,
      bodyBytes,
    });
    if (!decision) continue;
    if (decision.action === 'allow') return decision;
    lastBlock = decision;
  }

  return (
    lastBlock ??
    block(BLOCK_CODES.UNMATCHED_REQUEST, {
      ...baseSignature(),
      bodyKeys: bodyMap ? orderedKeys(bodyMap) : [],
    })
  );
}

export async function enforceRequestPolicy(
  route: PolicyRoute,
  manifest: RequestPolicyManifest,
  options?: {
    recorder?: FixtureRequestRecorder;
    onDecision?: (decision: RequestDecision) => void;
    privateDigest?: RequestPolicyPrivateDigestContext;
  },
): Promise<RequestDecision> {
  const req = route.request();
  const redirected = req.redirectedFrom();
  const decision = evaluateObservedRequest(
    manifest,
    {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      headers: req.headers(),
      postData: req.postData(),
      redirectedFrom: redirected ? redirected.url() : null,
    },
    { privateDigest: options?.privateDigest },
  );

  options?.onDecision?.(decision);

  if (decision.action === 'allow') {
    options?.recorder?.record({
      method: req.method().toUpperCase(),
      path: new URL(req.url()).pathname,
      ruleId: decision.ruleId,
    });
    await route.continue();
    return decision;
  }

  await route.abort('blockedbyclient');
  return decision;
}

/**
 * Context-wide install pattern for Playwright (or stub) browser contexts.
 * Call before page creation. Unit layer uses PolicyRoute stubs.
 */
export async function installRequestPolicyRoute(
  context: {
    route(
      url: string,
      handler: (route: PolicyRoute) => Promise<void> | void,
    ): Promise<void>;
  },
  manifest: RequestPolicyManifest,
  options?: {
    recorder?: FixtureRequestRecorder;
    onDecision?: (decision: RequestDecision) => void;
    privateDigest?: RequestPolicyPrivateDigestContext;
  },
): Promise<void> {
  await context.route('**/*', async (route) => {
    await enforceRequestPolicy(route, manifest, options);
  });
}

export function createBrowserEventGuards(manifest: RequestPolicyManifest): {
  handlePopup(page: { close(): Promise<void> }): Promise<void>;
  handleDownload(download: { cancel(): Promise<void> }): Promise<void>;
  handleWebSocket(): 'reject';
  evaluateNavigation(url: string): RequestDecision;
  lastBlock(): RequestDecision | null;
} {
  let last: RequestDecision | null = null;

  const rememberBlock = (code: BlockCode, path = ''): RequestDecision => {
    last = block(
      code,
      buildRedactedSignature({
        method: 'GET',
        origin: '',
        path,
        resourceType: code,
        queryKeys: [],
        bodyKeys: [],
        bodyBytes: 0,
      }),
    );
    return last;
  };

  return {
    async handlePopup(page) {
      rememberBlock(BLOCK_CODES.POPUP);
      await page.close();
    },
    async handleDownload(download) {
      rememberBlock(BLOCK_CODES.DOWNLOAD);
      await download.cancel();
    },
    handleWebSocket() {
      rememberBlock(BLOCK_CODES.WEBSOCKET);
      return 'reject';
    },
    evaluateNavigation(url: string) {
      const decision = evaluateObservedRequest(manifest, {
        url,
        method: 'GET',
        resourceType: 'document',
      });
      if (decision.action === 'block') last = decision;
      return decision;
    },
    lastBlock() {
      return last;
    },
  };
}
