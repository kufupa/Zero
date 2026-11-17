// Keep protected paths blocked for the page lifetime unless an active caller
// has approved this exact request after checking its payload and context.
const pages = new WeakMap();
const authorizations = new WeakMap();

// A writer context may forward only a request which passed the owning page's
// lifetime fence. Closing or quarantining the scope revokes its authorization.
export function hasPageRequestAuthorization(request, page) {
  const authorization = authorizations.get(request);
  if (!authorization || authorization.page !== page) return false;
  const { state, scope } = authorization;
  return !state.quarantined && state.active === scope;
}

export function consumePageRequestAuthorization(request, page) {
  const authorized = hasPageRequestAuthorization(request, page);
  authorizations.delete(request);
  return authorized;
}

export async function installPageRequestFence(page, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path.startsWith('/') || /[?#]/.test(path))) {
    throw new Error('REQUEST_FENCE_PATH_INVALID');
  }
  let state = pages.get(page);
  if (!state) {
    state = {paths:new Set(),active:null,quarantined:false};
    const current = state;
    current.api = {
      open() {
        if (current.quarantined) throw new Error('PAGE_ACTION_UNCERTAIN');
        if (current.active) throw new Error('PAGE_ACTION_IN_PROGRESS');
        const approved = new WeakSet();
        current.active = approved;
        return {
          allow(request) { if (current.quarantined || current.active !== approved) return false; approved.add(request); return true; },
          close() { if (current.active === approved) current.active = null; },
        };
      },
      quarantine() { current.quarantined = true; current.active = null; },
      isQuarantined() { return current.quarantined; },
    };
    pages.set(page,current);
    current.ready = Promise.resolve().then(() => page.route('**/*',async route => {
      const request = route.request();
      let pathname;
      try { pathname = new URL(request.url()).pathname; } catch { return route.abort(); }
      if (!current.paths.has(pathname.toLowerCase())) return route.fallback();
      if (current.quarantined || !current.active?.has(request)) return route.abort();
      current.active.delete(request);
      authorizations.set(request, { page, state: current, scope: current.active });
      return route.fallback();
    }));
  }
  for (const path of paths) state.paths.add(path.toLowerCase());
  try { await state.ready; } catch (error) { if (pages.get(page) === state) pages.delete(page); throw error; }
  return state.api;
}
