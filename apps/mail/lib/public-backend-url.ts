/**
 * Resolve the public API origin for browser fetches.
 *
 * Pilot SPA is served same-origin with nginx proxying `/api/*`. Deploy sets
 * `VITE_PUBLIC_BACKEND_URL=""` for that. If the env is missing at build time,
 * Vite leaves `import.meta.env.VITE_PUBLIC_BACKEND_URL` as JS `undefined`, and
 * naive concatenation becomes the literal path `"undefined/api/trpc"` — which
 * never hits the Node server (nginx 405) while auth (bare `baseURL: undefined`)
 * can still appear logged-in. Coerce missing / bogus values to same-origin `""`.
 *
 * Call with no args to read Vite env. Passing `undefined`/`null` explicitly
 * still means "missing" (does not re-read env) so unit tests stay hermetic.
 */
export function resolvePublicBackendUrl(
  ...args: [] | [string | null | undefined]
): string {
  const raw = args.length === 0 ? import.meta.env.VITE_PUBLIC_BACKEND_URL : args[0];
  if (raw == null) return '';
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
  return trimmed.replace(/\/+$/, '');
}

export function publicBackendTrpcUrl(
  ...args: [] | [string | null | undefined]
): string {
  return `${resolvePublicBackendUrl(...args)}/api/trpc`;
}

export function publicBackendPath(
  path: string,
  ...args: [] | [string | null | undefined]
): string {
  const base = resolvePublicBackendUrl(...args);
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}
