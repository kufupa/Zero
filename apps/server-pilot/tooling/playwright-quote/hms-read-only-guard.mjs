// Read-only browser guard shared by the find runner and its batch CLI.

const MUTATION_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const MUTATION_PATH = /save|delete|cancel|duplicate|checkin|checkout|crs/i;
// On-prem Hotel Availability posts hotelAvail/; the Infor cloud build (HRCEN, 2026-10-27) posts rateshop/.
const AVAILABILITY_READ_PATHS = new Set([
  '/api/internalBooking/hotelAvail/inquiryForGrid',
  '/api/internalBooking/rateshop/inquiryForGrid',
]);

export function isAvailabilityReadPath(pathname) {
  return AVAILABILITY_READ_PATHS.has(pathname);
}
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function shouldAbortReadOnlyRequest({ method, url }) {
  const requestMethod = String(method ?? '').toUpperCase();
  if (!MUTATION_METHOD.test(requestMethod)) return false;
  if (requestMethod !== 'POST') return true;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  return MUTATION_PATH.test(pathname);
}

export async function installReadOnlyGuard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (shouldAbortReadOnlyRequest({ method: request.method(), url: request.url() })) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}

export async function installAvailabilityReadOnlyGuard(context, origin) {
  let allowedOrigin;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    allowedOrigin = url.origin;
  } catch {
    throw new Error('hms_availability_read_origin_invalid');
  }
  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = String(request.method() ?? '').toUpperCase();
    let allowed = SAFE_READ_METHODS.has(method);
    if (method === 'POST') {
      try {
        const url = new URL(request.url());
        allowed = url.origin === allowedOrigin && isAvailabilityReadPath(url.pathname);
      } catch {
        allowed = false;
      }
    }
    if (allowed) await route.continue();
    else await route.abort();
  });
}
