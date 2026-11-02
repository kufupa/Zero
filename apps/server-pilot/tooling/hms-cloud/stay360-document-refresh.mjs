// Observe, but never authorize or dispatch, the Documents-tab refresh request.
// A matching response alone does not prove that the rendered tree is fresh or complete.
const DOCUMENT_PATH = '/web/base/OSRESV.DOC';
const MAX_CANDIDATES = 100;
const unsafeIdentityText = (value) => value.includes('#') ||
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function validIdentity(identity) {
  const native = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !unsafeIdentityText(value);
  return identity && typeof identity === 'object' && !Array.isArray(identity) &&
    Object.keys(identity).length === 3 && /^[A-Z0-9]{1,12}$/.test(identity.propertyCode || '') &&
    native(identity.reservationId) && native(identity.reservationStayId);
}

export function observeDocumentRefresh(page, confirmation, identity) {
  if (!validIdentity(identity) || typeof confirmation !== 'string' || !confirmation.trim() ||
      confirmation.trim() !== confirmation || unsafeIdentityText(confirmation)) {
    throw new Error('DOCUMENT_REFRESH_IDENTITY_INVALID');
  }
  const expected = { ...identity };
  const requests = new Map();
  let overflow = false;
  const onRequest = (request) => {
    try {
      if (new URL(request.url()).pathname !== DOCUMENT_PATH) return;
      if (requests.size >= MAX_CANDIDATES) { overflow = true; return; }
      requests.set(request, { responseStatus: null, finished: false, failed: false });
    } catch { overflow = true; }
  };
  const onResponse = (response) => {
    const observed = requests.get(response.request());
    if (observed) observed.responseStatus = response.status();
  };
  const onFinished = (request) => { const observed = requests.get(request); if (observed) observed.finished = true; };
  const onFailed = (request) => { const observed = requests.get(request); if (observed) observed.failed = true; };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    result(frame) {
      try {
        if (overflow || !frame || frame.isDetached?.()) return { status: 'unverified' };
        const origin = new URL(frame.url()).origin;
        const scoped = [...requests].filter(([request]) => request.frame() === frame);
        if (scoped.length !== 1) return { status: 'unverified' };
        const [[request, observed]] = scoped;
        const url = new URL(request.url());
        const params = new URLSearchParams(request.postData() || '');
        const keys = [...params.keys()];
        if (request.method() !== 'POST' || url.origin !== origin || url.pathname !== DOCUMENT_PATH || url.search || url.hash ||
            new Set(keys).size !== keys.length || params.get('CURRENT_TAB_NAME') !== 'DOC' ||
            params.get('confirmationnumber') !== confirmation || params.get('reservationstayid') !== expected.reservationStayId ||
            params.get('propertycode') !== expected.propertyCode || params.get('daeRentity') !== 'RESV' ||
            params.get('daeCode') !== `${expected.reservationId}#${confirmation}#${expected.propertyCode}` ||
            observed.responseStatus !== 200 || !observed.finished || observed.failed) return { status: 'unverified' };
        return { status: 'matched_response' };
      } catch { return { status: 'unverified' }; }
    },
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    },
  };
}
