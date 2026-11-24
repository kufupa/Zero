import {createHash} from 'node:crypto';

/** Lead plan contract: exact property/scope/query read outcomes. */
export type Scope = {property: string; mailbox?: string | null};

export type ReadResult<T> =
  | {state: 'observed'; data: T; refs: string[]; queryDigest: string}
  | {state: 'no_match'; queryDigest: string; complete: true; refs: string[]}
  | {state: 'unobserved'; reason: string; queryDigest: string};

const SESSION_KEYS = new Set([
  'session', 'session_id', 'sessionId', 'page', 'page_id', 'trace', 'trace_id',
  'cookie', 'cookies', 'authorization', 'token', 'csrf', 'playwright',
]);

/** Stable JSON for digests: sort keys, drop transient session fields. */
export function orderedBusinessValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedBusinessValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SESSION_KEYS.has(key) && !/session|cookie|token|csrf/i.test(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, orderedBusinessValue(item)]),
    );
  }
  return value;
}

export function queryDigest(scope: Scope, method: string, input: unknown): string {
  const payload = JSON.stringify(orderedBusinessValue({
    property: scope.property,
    mailbox: scope.mailbox ?? null,
    method,
    input,
  }));
  return createHash('sha256').update(payload).digest('hex');
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(orderedBusinessValue(value))).digest('hex');
}

export function observedResult<T>(data: T, refs: string[], digest: string): ReadResult<T> {
  return {state: 'observed', data, refs, queryDigest: digest};
}

export function completeNoMatch(digest: string, refs: string[] = []): ReadResult<never> {
  return {state: 'no_match', queryDigest: digest, complete: true, refs};
}

export function unobservedResult(reason: string, digest: string): ReadResult<never> {
  return {state: 'unobserved', reason, queryDigest: digest};
}

/** Twin envelope coverage tag derived from ReadResult (legacy field name). */
export function twinCoverageOf(result: ReadResult<unknown>): 'observed' | 'no_match' | 'unobserved' {
  return result.state === 'no_match' ? 'no_match' : result.state;
}
