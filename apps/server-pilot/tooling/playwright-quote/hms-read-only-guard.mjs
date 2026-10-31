// Read-only browser guard shared by the find runner and its batch CLI.

const MUTATION_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const MUTATION_PATH = /save|delete|cancel|duplicate|checkin|checkout|crs/i;
const MUTATION_ACTION = /^(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|create|submit|autosave|amend|post)$/i;
const hasWriteAction = (params) => [...params].some(([key, value]) =>
  key.toLowerCase() === 'pageaction' && MUTATION_ACTION.test(value.trim()));
const CLOUD_VAULT_ORIGIN = 'https://hmsvault.hms.eu1.inforcloudsuite.com';
const CLOUD_CARD_ENTRY_PATH = '/Vault/servlets/showCardEntryHandler';
// On-prem Hotel Availability posts hotelAvail/; the Infor cloud build (HRCEN, 2026-10-27) posts rateshop/.
const AVAILABILITY_READ_PATHS = new Set([
  '/api/internalBooking/hotelAvail/inquiryForGrid',
  '/api/internalBooking/rateshop/inquiryForGrid',
]);

export function isAvailabilityReadPath(pathname) {
  return AVAILABILITY_READ_PATHS.has(pathname);
}

export function isAvailabilityReadRequest({ method, url }, origin) {
  try {
    const parsed = new URL(url);
    return String(method ?? '').toUpperCase() === 'POST' && parsed.origin === origin && isAvailabilityReadPath(parsed.pathname);
  } catch {
    return false;
  }
}
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function shouldAbortReadOnlyRequest({ method, url, postData }) {
  const requestMethod = String(method ?? '').toUpperCase();
  let target;
  try {
    target = new URL(url);
  } catch {
    return MUTATION_METHOD.test(requestMethod);
  }
  // Cloud Guest Stay saves via OSRESV.HDR?pageaction=SAVE; the pathname alone
  // looks like an ordinary record read. The same switch can appear in a form.
  if (hasWriteAction(target.searchParams)) return true;
  if (!MUTATION_METHOD.test(requestMethod)) return false;
  if (requestMethod !== 'POST') return true;
  return (target.origin === CLOUD_VAULT_ORIGIN && target.pathname === CLOUD_CARD_ENTRY_PATH) ||
    MUTATION_PATH.test(target.pathname) ||
    (typeof postData === 'string' && hasWriteAction(new URLSearchParams(postData)));
}

export async function installReadOnlyGuard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (shouldAbortReadOnlyRequest({ method: request.method(), url: request.url(), postData: request.postData?.() })) {
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
      allowed = isAvailabilityReadRequest({ method, url: request.url() }, allowedOrigin);
    }
    if (allowed) await route.continue();
    else await route.abort();
  });
}
