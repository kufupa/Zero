// This primitive attests WebSocket route setup, not the property's lock or browser closure.
// A trusted caller must supply a genuinely new, dedicated, unexposed context and must not
// allow page creation until setup completes or install any later overriding socket route.
const attemptedContexts = new WeakSet();
const guardedContexts = new WeakMap();
const unsafe = () => new Error('HMS_CONTEXT_UNSAFE');

function inspect(context) {
  try {
    if (!context || typeof context !== 'object' || context._options?.serviceWorkers !== 'block' ||
        typeof context.serviceWorkers !== 'function' || typeof context.pages !== 'function' ||
        typeof context.routeWebSocket !== 'function') return null;
    const workers = context.serviceWorkers();
    const pages = context.pages();
    if (!Array.isArray(workers) || workers.length !== 0 || !Array.isArray(pages)) return null;
    return { pages, routeWebSocket: context.routeWebSocket };
  } catch {
    return null;
  }
}

/** Install the fence before any page is created. A context may be attempted only once. */
export async function prepareGuardedContext(context) {
  if (!context || typeof context !== 'object' || attemptedContexts.has(context)) throw unsafe();
  attemptedContexts.add(context);
  const before = inspect(context);
  if (!before || before.pages.length !== 0) throw unsafe();
  const state = { pending: 0, failed: false, routeWebSocket: before.routeWebSocket };
  await context.routeWebSocket('**/*', async (socket) => {
    state.pending += 1;
    try {
      // Do not connect the routed socket to its server.
      await socket.close();
    } catch {
      state.failed = true;
    } finally {
      state.pending -= 1;
    }
  });
  const after = inspect(context);
  if (!after || after.pages.length !== 0 || after.routeWebSocket !== state.routeWebSocket ||
      state.pending !== 0 || state.failed) throw unsafe();
  guardedContexts.set(context, state);
}

function guardedInspection(context) {
  if (!context || typeof context !== 'object') return null;
  const state = guardedContexts.get(context);
  if (!state) return null;
  const current = inspect(context);
  if (!current || current.routeWebSocket !== state.routeWebSocket) state.failed = true;
  return state.failed || state.pending !== 0 ? null : { state, pages: current.pages };
}

/** True only while setup attestation and the observable context checks remain valid. */
export function isGuardedContext(context) {
  return Boolean(guardedInspection(context));
}

/** Additionally require that this is the only page in its guarded context. */
export function isGuardedPage(page) {
  try {
    if (!page || typeof page.context !== 'function') return false;
    const guarded = guardedInspection(page.context());
    if (!guarded) return false;
    if (guarded.pages.length > 1) {
      guarded.state.failed = true;
      return false;
    }
    return guarded.pages.length === 1 && guarded.pages[0] === page;
  } catch {
    return false;
  }
}
