/**
 * Resolve the public API origin for browser fetches.
 *
 * Pilot SPA is served same-origin with nginx proxying `/api/*`. Deploy sets
 * `VITE_PUBLIC_BACKEND_URL=""` for that. If the env is missing at build time,
 * Vite leaves `import.meta.env.VITE_PUBLIC_BACKEND_URL` as JS `undefined`, and
 * naive concatenation becomes the literal path `"undefined/api/trpc"` — which
 * never hits the Node server (nginx 405) while auth (bare `baseURL: undefined`)
 * can still appear logged-in. Coerce missing / bogus values to same-origin `""`.
 */
export function resolvePublicBackendUrl(
  raw: string | undefined | null = import.meta.env.VITE_PUBLIC_BACKEND_URL,
): string {
  if (raw == null) return '';
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
  return trimmed.replace(/\/+$/, '');
}

export function publicBackendTrpcUrl(
  raw?: string | undefined | null,
): string {
  return `${resolvePublicBackendUrl(raw)}/api/trpc`;
}

export function publicBackendPath(
  path: string,
  raw?: string | undefined | null,
): string {
  const base = resolvePublicBackendUrl(raw);
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}
