/**
 * Narrow, fail-closed request projection for development diagnostics.
 *
 * Values are retained only for the reviewed transport fields. Every other
 * body/query value is represented by a SHA-256 digest; headers are names only.
 * This helper must never be used as request-policy authorization.
 */
import { createHash } from 'node:crypto';

export const NARROW_TRANSPORT_FIELD_RULES: Readonly<Record<string, RegExp>> = {
  SYSTEM_FUNCTION_NAME: /^[A-Z][A-Z0-9_.-]{0,31}$/,
  USER_FUNCTION_NAME: /^[A-Z][A-Z0-9_.-]{0,31}$/,
  FUNCTION_CLASS: /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/,
  CURRENT_TAB_NAME: /^[A-Z][A-Z0-9_.-]{0,31}$/,
  MENU_MODULE_KEY: /^[A-Za-z0-9_.:-]{1,64}$/,
  removescreenflows: /^(?:0|1|true|false)$/i,
};

export type NarrowRequestProjection = {
  kind: string;
  at: string;
  origin: string;
  path: string;
  method: string;
  resourceType: string;
  contentType?: string;
  bodyFieldNames: string[];
  queryKeys: string[];
  safeTransportFields: Record<string, string>;
  otherFieldHashes: Record<string, string>;
  queryFieldHashes: Record<string, string>;
  bodyPayloadSha256: string;
  bodyByteLength: number;
  requestHeaderNames: string[];
  authorizationPresent: boolean;
};

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function collectFields(rawBody: string, contentType: string | undefined): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const add = (name: string, value: unknown): void => {
    const values = fields.get(name) ?? [];
    values.push(valueText(value));
    fields.set(name, values);
  };
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) add(name, value);
      }
    } catch {
      // Retain only the payload digest for unsupported JSON.
    }
    return fields;
  }
  if (mediaType && mediaType !== 'application/x-www-form-urlencoded') return fields;
  // The request policy treats an absent content type as form encoding, but a
  // body without a separator is not a supported form shape. Keeping only its
  // digest prevents an opaque secret from becoming a field name.
  if (!contentType && rawBody !== '' && !rawBody.includes('=')) return fields;
  for (const [name, value] of new URLSearchParams(rawBody)) add(name, value);
  return fields;
}

export function buildNarrowRequestProjection(input: {
  kind: string;
  at?: string;
  url: string | URL;
  method: string;
  resourceType: string;
  rawBody?: string | null;
  headers?: Record<string, string>;
}): NarrowRequestProjection {
  const url = typeof input.url === 'string' ? new URL(input.url) : input.url;
  const rawBody = input.rawBody ?? '';
  const headers = input.headers ?? {};
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const fields = collectFields(rawBody, contentType);
  const queryFields = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    const values = queryFields.get(name) ?? [];
    values.push(value);
    queryFields.set(name, values);
  }
  const safeTransportFields: Record<string, string> = {};
  const otherFieldHashes: Record<string, string> = {};
  for (const name of [...fields.keys()].sort()) {
    const values = fields.get(name)!;
    const rule = NARROW_TRANSPORT_FIELD_RULES[name];
    if (rule && values.length === 1 && rule.test(values[0]!))
      safeTransportFields[name] = values[0]!;
    else otherFieldHashes[name] = hash(values.join('\u0000'));
  }
  const queryFieldHashes: Record<string, string> = {};
  for (const name of [...queryFields.keys()].sort())
    queryFieldHashes[name] = hash(queryFields.get(name)!.join('\u0000'));
  const requestHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  return {
    kind: input.kind,
    at: input.at ?? new Date().toISOString(),
    origin: url.origin,
    path: url.pathname,
    method: input.method,
    resourceType: input.resourceType,
    ...(contentType ? { contentType } : {}),
    bodyFieldNames: [...fields.keys()].sort(),
    queryKeys: [...queryFields.keys()].sort(),
    safeTransportFields,
    otherFieldHashes,
    queryFieldHashes,
    bodyPayloadSha256: hash(rawBody),
    bodyByteLength: Buffer.byteLength(rawBody, 'utf8'),
    requestHeaderNames,
    authorizationPresent: requestHeaderNames.includes('authorization'),
  };
}
