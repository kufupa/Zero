/**
 * Safety rails shared by the live-proof drivers (nava-ae4-override-proof.ts, nava-ae1-rates-proof.ts,
 * nava-ae2-find-proof.ts):
 *
 *   - the active mailbox. The pane binds its mailbox (and the PDF/Excel identity check, workstation.ts emailsMatch) to
 *     connections.getDefault, not to the x-zero-active-transport header the driver sends. When the run's transport is not
 *     the account's default, the driver makes it the default with the app's own connections.setDefault, from the signed-in
 *     browser context, and always puts the previous default back afterwards (withActiveMailbox).
 *   - edits to a real thread. A driver fills only fields the pane is missing, and only with NAVA_PROOF_ALLOW_EDITS=1;
 *     without it the run stops with the blocker "needs_edits:<fields>" (needsEditsMessage).
 *
 * This module imports nothing from the drivers, so every driver (and nava-proof-kit.ts) can use it.
 */
import type { BrowserContext, Page } from 'playwright';

// ---------------------------------------------------------------------------------------------------------------------
// Edits to a real thread

/** NAVA_PROOF_ALLOW_EDITS=1 lets a driver fill fields the pane is missing. Off by default. */
export function allowEditsFrom(env: NodeJS.ProcessEnv): boolean {
  return env.NAVA_PROOF_ALLOW_EDITS?.trim() === '1';
}

/** The blocker for a run that would have to edit a real thread without NAVA_PROOF_ALLOW_EDITS=1. */
export function needsEditsMessage(fields: readonly string[]): string {
  return `needs_edits:${fields.join(',')}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Active mailbox

export const SET_DEFAULT_PROCEDURE = 'connections.setDefault';

/** What the run did to the account's default mailbox. Goes into the driver's summary. */
export type MailboxRecord = {
  /** The driver changed (or tried to change) the account's default mailbox for the run. */
  activeMailboxSwitched: boolean;
  /** The previous default is back. False when nothing was switched (nothing to restore) or when the restore failed. */
  restored: boolean;
};

/** What the run did, with the transport ids and the restore problem. The ids are not secret (transport-…). */
export type MailboxSwitch = MailboxRecord & {
  target: string | null;
  previousDefault: string | null;
  /** Why the restore failed, null when it did not. */
  restoreError: string | null;
};

/** The three connections calls the switch makes, as transport ids. */
export type MailboxApi = {
  getDefault(): Promise<string | null>;
  list(): Promise<string[]>;
  setDefault(connectionId: string): Promise<void>;
};

/** The switch could not be made. The driver reports it as its blocker. */
export class MailboxSwitchError extends Error {}

/**
 * The one connections.setDefault the driver is about to send. The request guard lets a setDefault through only when it
 * is the whole request and names this connection, and then clears the permit. The pane never gets one.
 */
export type MailboxPermit = { connectionId: string | null; used: number };

export function newMailboxPermit(): MailboxPermit {
  return { connectionId: null, used: 0 };
}

/** At most three driver calls ever pass: the switch, the restore and one retry of the restore. */
const MAX_DRIVER_SET_DEFAULTS = 3;

/** Whether this request is the driver's own armed connections.setDefault. Consumes the permit when it is. */
export function takeMailboxPermit(url: string, postData: string | null, permit: MailboxPermit): boolean {
  if (!permit.connectionId || permit.used >= MAX_DRIVER_SET_DEFAULTS) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (pathname !== `/api/trpc/${SET_DEFAULT_PROCEDURE}`) return false;
  let input: unknown;
  try {
    const body = JSON.parse(postData ?? '') as Record<string, { json?: unknown } | undefined>;
    input = body?.['0']?.json;
  } catch {
    return false;
  }
  if ((input as { connectionId?: unknown } | undefined)?.connectionId !== permit.connectionId) return false;
  permit.connectionId = null;
  permit.used += 1;
  return true;
}

/**
 * Wraps a driver's request guard: the driver's armed setDefault passes, every other request (a setDefault from the pane
 * among them) goes to the driver's own guard, which blocks connections.setDefault as a write.
 */
export function withMailboxPermit<D extends { allowed: boolean; procedures: string[]; blocked: unknown[] }>(
  classify: (url: string, postData: string | null) => D,
  permit: MailboxPermit,
): (url: string, postData: string | null) => D {
  return (url, postData) =>
    takeMailboxPermit(url, postData, permit)
      ? ({ allowed: true, procedures: [SET_DEFAULT_PROCEDURE], blocked: [] } as unknown as D)
      : classify(url, postData);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 240);

/**
 * Runs `body` with `target` as the account's default mailbox. When the default is already the target (or there is no
 * target), nothing is switched. Otherwise the default is switched before `body` and the previous one is put back in a
 * finally block, after a blocker, a timeout or a crash alike, and checked with getDefault. `record` is filled as the run
 * goes, so a summary written after a failure still says what happened. A failed switch throws MailboxSwitchError; a
 * failed restore sets restored false (the driver fails the run) and is logged.
 */
export async function withActiveMailbox<T>(
  api: MailboxApi,
  target: string | null,
  record: MailboxSwitch,
  log: (line: string) => void,
  body: () => Promise<T>,
): Promise<T> {
  record.target = target;
  if (!target) return body();
  let previous: string | null;
  try {
    previous = await api.getDefault();
  } catch (error) {
    throw new MailboxSwitchError(`mailbox_read_failed: ${message(error)}`);
  }
  record.previousDefault = previous;
  if (previous === target) {
    log('mailbox: the run transport is already the default');
    return body();
  }
  if (!previous) throw new MailboxSwitchError('mailbox_read_failed: the account has no default mailbox');
  let linked: string[];
  try {
    linked = await api.list();
  } catch (error) {
    throw new MailboxSwitchError(`mailbox_read_failed: ${message(error)}`);
  }
  if (!linked.includes(target)) {
    throw new MailboxSwitchError(`mailbox_not_linked: the account has no access to ${target}`);
  }

  const restore = async (): Promise<void> => {
    let lastError = 'the default did not change back';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if ((await api.getDefault()) !== previous) await api.setDefault(previous);
        if ((await api.getDefault()) === previous) {
          record.restored = true;
          record.restoreError = null;
          log(`mailbox: default restored to ${previous}`);
          return;
        }
      } catch (error) {
        lastError = message(error);
      }
    }
    record.restored = false;
    record.restoreError = lastError;
    log(`mailbox: RESTORE FAILED, the default is not back to ${previous} (${lastError}); set it back by hand`);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void restore().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  record.activeMailboxSwitched = true;
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    try {
      await api.setDefault(target);
      if ((await api.getDefault()) !== target) throw new Error('the default did not change');
    } catch (error) {
      throw new MailboxSwitchError(`mailbox_switch_failed: ${message(error)}`);
    }
    log(`mailbox: default switched from ${previous} to ${target} for the run`);
    return await body();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await restore();
  }
}

export function newMailboxSwitch(): MailboxSwitch {
  return { activeMailboxSwitched: false, restored: false, target: null, previousDefault: null, restoreError: null };
}

/** The failure a summary carries when the switched default was not put back (the log line says why). */
export function mailboxFailures(record: MailboxRecord): string[] {
  return record.activeMailboxSwitched && !record.restored ? ['the default mailbox was not restored after the run'] : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser side

const CALL_TIMEOUT_MS = 30_000;

/** Browser-side: one tRPC call as the app's client sends it (POST, superjson batch). Plain JS, no DOM types. */
const TRPC_CALL_JS = `async ([procedure, input, timeoutMs]) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/trpc/' + procedure + '?batch=1', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 0: { json: input === undefined ? null : input } }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { return { error: 'HTTP ' + response.status }; }
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || item.error) {
      const raw = item && item.error ? (item.error.json || item.error) : null;
      const code = raw && raw.data && raw.data.code ? raw.data.code : 'HTTP ' + response.status;
      return { error: code };
    }
    const data = item.result ? item.result.data : undefined;
    return { data: data && typeof data === 'object' && 'json' in data ? data.json : data };
  } catch (error) {
    return { error: controller.signal.aborted ? 'timed out' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}`;

/**
 * MailboxApi over the signed-in browser context: a page of its own (never the pane's), on the app's origin, so the calls
 * carry the session cookie and the run's headers and go through the context's request guard. setDefault arms the
 * permit for exactly its own request and clears it afterwards. Only error codes are kept, never response text.
 */
export function browserMailboxApi(context: BrowserContext, baseUrl: string, permit: MailboxPermit): MailboxApi {
  let page: Page | null = null;
  const ready = async (): Promise<Page> => {
    if (page && !page.isClosed()) return page;
    page = await context.newPage();
    // Any same-origin document will do; this read is small and the guard lets it through.
    await page.goto(new URL('/api/trpc/connections.getDefault', baseUrl).href, { waitUntil: 'domcontentloaded' });
    return page;
  };
  const call = async (procedure: string, input?: unknown): Promise<unknown> => {
    const args = JSON.stringify([procedure, input === undefined ? null : input, CALL_TIMEOUT_MS]);
    const out = (await (await ready()).evaluate(`(${TRPC_CALL_JS})(${args})`)) as
      | { data?: unknown; error?: string }
      | null;
    if (!out || out.error) throw new Error(`${procedure}: ${out?.error ?? 'no response'}`);
    return out.data;
  };
  return {
    async getDefault() {
      const data = (await call('connections.getDefault')) as { id?: unknown } | null;
      return typeof data?.id === 'string' ? data.id : null;
    },
    async list() {
      const data = (await call('connections.list')) as { connections?: Array<{ id?: unknown }> } | null;
      return (data?.connections ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string');
    },
    async setDefault(connectionId: string) {
      permit.connectionId = connectionId;
      try {
        await call(SET_DEFAULT_PROCEDURE, { connectionId });
      } finally {
        permit.connectionId = null;
      }
    },
  };
}
