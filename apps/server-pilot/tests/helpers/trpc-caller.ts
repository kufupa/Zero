/**
 * Test helper: build a tRPC caller with a fabricated session + mailbox
 * context for a given seeded user id.
 *
 * Bypasses Better Auth session lookup (the test injects `sessionUser`
 * directly) and resolves the mailbox context via `resolveMailboxContext`
 * against the seeded db so the caller's `activeTransportId` matches the
 * user's highest-role transport (or the requested one).
 *
 * Used by `mail-router-isolation.test.ts` and `attachment-access.test.ts`.
 */
import type { DB } from '../../src/db/client.js';
import { appRouter } from '../../src/trpc/router.js';
import {
  resolveMailboxContext,
  type MailboxContext,
} from '../../src/trpc/context.js';

export type CallerForOptions = {
  /** DB handle (usually a transaction-scoped handle from withSeededTestDb). */
  db: DB;
  /** Override the active transport; default = user's highest-role transport. */
  requestedTransportId?: string;
};

/** The full root caller produced by `appRouter.createCaller(ctx)`. */
type RootCaller = ReturnType<typeof appRouter.createCaller>;

/**
 * Build a tRPC caller whose context mimics what `mailboxProcedure` would
 * produce for a real request: `sessionUser` + resolved `MailboxContext`.
 *
 * Throws (via `resolveMailboxContext`) if the user has no access to the
 * requested transport — matching production behavior, so isolation tests can
 * assert FORBIDDEN at the context layer too.
 */
export async function callerFor(
  userId: string,
  opts: CallerForOptions,
): Promise<{
  mail: RootCaller['mail'];
  drafts: RootCaller['drafts'];
  labels: RootCaller['labels'];
  rates: RootCaller['rates'];
  settings: RootCaller['settings'];
  connections: RootCaller['connections'];
  user: RootCaller['user'];
  ctx: MailboxContext & { sessionUser: { id: string; email: string; name: string | null } };
}> {
  const mailbox = await resolveMailboxContext(
    userId,
    opts.requestedTransportId,
    opts.db,
  );
  const sessionUser = { id: userId, email: '', name: null };
  const ctx = {
    auth: null as never, // tests bypass auth.api.getSession
    reqHeaders: new Headers(),
    sessionUser,
    ...mailbox,
  };
  // Point the routes' `getDb()` calls at the transaction-scoped handle.
  // ESM exports are live bindings (getter-only), so we can't reassign
  // `getDb`; instead we set the module-internal cache via the test-only
  // setter on the db client.
  const dbClientModule = await import('../../src/db/client.js');
  dbClientModule.__setDbForTests({ db: opts.db, conn: null as never });
  void dbClientModule;

  const caller = appRouter.createCaller(ctx);
  return {
    mail: caller.mail,
    drafts: caller.drafts,
    labels: caller.labels,
    rates: caller.rates,
    settings: caller.settings,
    connections: caller.connections,
    user: caller.user,
    ctx: { ...mailbox, sessionUser },
  };
}

/**
 * Variant for routes that only need `privateProcedure` (settings, connections,
 * user) — does not resolve a mailbox context.
 */
export async function callerForPrivate(
  userId: string,
  opts: { db: DB },
): Promise<{
  settings: RootCaller['settings'];
  connections: RootCaller['connections'];
  user: RootCaller['user'];
  workstation: RootCaller['workstation'];
}> {
  const sessionUser = { id: userId, email: '', name: null };
  const ctx = {
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser,
  };
  const dbClientModule = await import('../../src/db/client.js');
  dbClientModule.__setDbForTests({ db: opts.db, conn: null as never });
  void dbClientModule;
  const caller = appRouter.createCaller(ctx);
  return {
    settings: caller.settings,
    connections: caller.connections,
    user: caller.user,
    workstation: caller.workstation,
  };
}
