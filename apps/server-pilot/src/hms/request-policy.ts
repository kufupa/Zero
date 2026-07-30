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

type Multimap = Map<string, string[]>;

const SUBMIT_KEY_RE =
  /^(submit|btn(save|delete|create|amend|cancel|ok|yes)|.*\.action)$/i;
const MUTATION_ACTION_RE =
  /^(delete|save|create|amend|cancel|checkavailability|check.?availability)$/i;
const CRS_PATH_RE = /\/crs\/check-availability|checkavailability/i;

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
} {
  return {
    acceptDownloads: false,
    serviceWorkers: 'block',
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
  return new Map();
}

function appendMultimap(map: Multimap, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Parse query/body into a multimap. Caller sorts for compare. */
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

function parseJsonObjectMultimap(raw: string): Multimap {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('json_root');
  }
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

function sortedKeys(map: Multimap): string[] {
  return [...map.keys()].sort();
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
    queryKeys: [...input.queryKeys].sort(),
    bodyKeys: [...input.bodyKeys].sort(),
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
    } catch {
      return { ok: false, code: BLOCK_CODES.MALFORMED_JSON };
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
      queryKeys: sortedKeys(input.queryMap),
      bodyKeys: input.bodyMap ? sortedKeys(input.bodyMap) : [],
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

  if (rule.contentType) {
    const expected = mediaTypeOf(rule.contentType);
    const actual = input.contentType;
    if (expected && actual && expected !== actual) {
      // Prefer specific malform codes already handled; otherwise unmatched shape.
      return block(BLOCK_CODES.UNMATCHED_REQUEST, signature());
    }
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
    Boolean(rule.contentType);

  if (needsBody) {
    const bodyMap = input.bodyMap ?? emptyMultimap();
    // Mutation shortcuts even when fixed action differs
    const actionVals = bodyMap.get('action') ?? bodyMap.get('Action');
    if (
      actionVals &&
      actionVals.some((value) => MUTATION_ACTION_RE.test(value)) &&
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

  return { action: 'allow', ruleId: rule.id };
}

export function evaluateObservedRequest(
  manifest: RequestPolicyManifest,
  observed: ObservedRequestInput,
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
      queryKeys: sortedKeys(queryMap),
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
      bodyKeys: bodyMap ? sortedKeys(bodyMap) : [],
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
      bodyKeys: bodyMap ? sortedKeys(bodyMap) : [],
    })
  );
}

export async function enforceRequestPolicy(
  route: PolicyRoute,
  manifest: RequestPolicyManifest,
  options?: {
    recorder?: FixtureRequestRecorder;
    onDecision?: (decision: RequestDecision) => void;
  },
): Promise<RequestDecision> {
  const req = route.request();
  const redirected = req.redirectedFrom();
  const decision = evaluateObservedRequest(manifest, {
    url: req.url(),
    method: req.method(),
    resourceType: req.resourceType(),
    headers: req.headers(),
    postData: req.postData(),
    redirectedFrom: redirected ? redirected.url() : null,
  });

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
