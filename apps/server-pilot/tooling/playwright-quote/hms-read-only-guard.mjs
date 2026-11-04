// Read-only browser guard shared by the find runner and its batch CLI.

const MUTATION_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const MUTATION_PATH = /save|delete|cancel|duplicate|checkin|checkout|crs/i;
const MUTATION_ACTION = /^(save|delete|cancel|duplicate|checkin|checkout|crs|insert|update|commit|create|submit|autosave|amend|post)$/i;
const GUEST_STAY_CHECK_AVAILABILITY_PATH = '/web/base/osresv.hdr.getcheckavailability';
const HMS_WEB_ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const hasWriteAction = (params) => [...params].some(([key, value]) =>
  key.toLowerCase() === 'pageaction' && MUTATION_ACTION.test(value.trim()));
const AVAILABILITY_WRITE_SWITCHES = new Set([
  'newprofileclick', 'createinactiveprofileflag', 'savecctoprofile', 'savesettlementcctoprofile',
]);
const hasAvailabilityWriteIntent = (params) => [...params].some(([rawKey, rawValue]) => {
  const key = rawKey.toLowerCase();
  const value = rawValue.trim().toLowerCase();
  if ((key === 'pageaction' || key === 'action') && MUTATION_ACTION.test(value)) return true;
  return AVAILABILITY_WRITE_SWITCHES.has(key) && !['', '0', 'false'].includes(value);
});
const CLOUD_VAULT_ORIGIN = 'https://hmsvault.hms.eu1.inforcloudsuite.com';
const CLOUD_CARD_ENTRY_PATH = '/Vault/servlets/showCardEntryHandler';
// Every generic guard on a context checks the same one-shot approval. The
// earliest guard consumes it, so other guards and independent fences still run.
const readOnlyGuardState = new WeakMap();
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
  // Guest Stay Check Availability re-rates and temporarily holds a rate on the open form;
  // it is not a read-only availability inquiry, even though its path starts with get.
  if (target.pathname.toLowerCase() === GUEST_STAY_CHECK_AVAILABILITY_PATH) return true;
  // Cloud Guest Stay saves via OSRESV.HDR?pageaction=SAVE; the pathname alone
  // looks like an ordinary record read. The same switch can appear in a form.
  if (hasWriteAction(target.searchParams)) return true;
  if (!MUTATION_METHOD.test(requestMethod)) return false;
  if (requestMethod !== 'POST') return true;
  return (target.origin === CLOUD_VAULT_ORIGIN && target.pathname === CLOUD_CARD_ENTRY_PATH) ||
    MUTATION_PATH.test(target.pathname) ||
    (typeof postData === 'string' && hasWriteAction(new URLSearchParams(postData)));
}

export async function installReadOnlyGuard(context, { approvedCreateAvailabilityRequests } = {}) {
  if (approvedCreateAvailabilityRequests !== undefined && !(approvedCreateAvailabilityRequests instanceof WeakSet)) {
    throw new Error('CREATE_AVAILABILITY_APPROVALS_INVALID');
  }
  let state = readOnlyGuardState.get(context);
  const firstGuard = !state;
  if (!state) {
    state = { approvals: undefined };
    readOnlyGuardState.set(context, state);
  }
  if (approvedCreateAvailabilityRequests && state.approvals && approvedCreateAvailabilityRequests !== state.approvals) {
    throw new Error('CREATE_AVAILABILITY_APPROVALS_INVALID');
  }
  const addedApprovals = Boolean(approvedCreateAvailabilityRequests && !state.approvals);
  if (addedApprovals) state.approvals = approvedCreateAvailabilityRequests;
  try { await context.route('**/*', async (route) => {
    const request = route.request();
    let target;
    try { target = new URL(request.url()); } catch { /* The default guard handles malformed targets. */ }
    const approvals = state.approvals;
    if (approvals && String(request.method()).toUpperCase() === 'POST' &&
        target?.origin === HMS_WEB_ORIGIN && target.pathname.toLowerCase() === GUEST_STAY_CHECK_AVAILABILITY_PATH &&
        !target.search && !target.hash && !hasAvailabilityWriteIntent(new URLSearchParams(request.postData?.() || '')) &&
        (firstGuard ? approvals.delete(request) : approvals.has(request))) {
      await route.fallback();
      return;
    }
    if (shouldAbortReadOnlyRequest({ method: request.method(), url: request.url(), postData: request.postData?.() })) {
      await route.abort();
      return;
    }
    // Readers can install this guard more than once. Preserve any stricter
    // context fence installed earlier instead of bypassing it.
    await route.fallback();
  }); } catch (error) {
    if (addedApprovals && state.approvals === approvedCreateAvailabilityRequests) state.approvals = undefined;
    if (firstGuard && readOnlyGuardState.get(context) === state) readOnlyGuardState.delete(context);
    throw error;
  }
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
