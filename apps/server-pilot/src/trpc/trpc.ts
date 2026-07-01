/**
 * tRPC base: context shape, init, procedure helpers.
 *
 * Mailbox-aware auth flow:
 *   1. `privateProcedure` — requires a Better Auth session; resolves
 *      `sessionUser` from the request cookies via `auth.api.getSession`.
 *   2. `mailboxProcedure` — extends `privateProcedure` and resolves
 *      `MailboxContext` via `resolveMailboxContext(sessionUser.id,
 *      requestedTransportId, db)`. The `requestedTransportId` is read from
 *      the `x-zero-active-transport` header (sent by the frontend mailbox
 *      switcher); absent -> picks the user's highest-role transport.
 *
 * `requireMailboxAccess(ctx.userId, ctx.activeTransportId)` is implicitly
 * satisfied by `mailboxProcedure` (it throws FORBIDDEN before the route
 * runs). Routes additionally filter every thread/message lookup by
 * `eq(...transportId, ctx.activeTransportId)` so a leaked id from another
 * mailbox returns NOT_FOUND / empty.
 *
 * Tests build a caller directly with a fabricated context (see
 * `callerFor(userId, db)` in tests/helpers/trpc-caller.ts) so the Better Auth
 * session lookup is bypassed in unit tests.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { Auth } from '../lib/auth.js';
import { getDb, type DB } from '../db/client.js';
import {
  resolveMailboxContext,
  type MailboxContext,
  MailboxForbiddenError,
} from './context.js';

/**
 * The source context Hono passes to the tRPC server adapter. `auth` is the
 * Better Auth instance; `reqHeaders` is the raw request headers so the
 * context factory can call `auth.api.getSession({ headers })` and read the
 * `x-zero-active-transport` header.
 */
export type TrpcSourceContext = {
  auth: Auth;
  reqHeaders: Headers;
};

export type TrpcPrivateContext = {
  auth: Auth;
  reqHeaders: Headers;
  sessionUser: { id: string; email: string; name: string | null };
};

export type TrpcMailboxContext = TrpcPrivateContext & MailboxContext;

const t = initTRPC.context<TrpcSourceContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Resolve the Better Auth session user from the request cookies.
 */
async function getSessionUser(
  auth: Auth,
  headers: Headers,
): Promise<{
  id: string;
  email: string;
  name: string | null;
} | null> {
  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return null;
    const u = session.user as { id: string; email: string; name?: string | null };
    return { id: u.id, email: u.email, name: u.name ?? null };
  } catch {
    return null;
  }
}

/**
 * Read the requested transport id from the `x-zero-active-transport` header.
 *
 * The frontend mailbox switcher sets this header on every tRPC request once
 * the user has selected a mailbox. Absent -> undefined -> resolver picks the
 * user's highest-role transport.
 */
function readRequestedTransportId(headers: Headers): string | undefined {
  const v = headers.get('x-zero-active-transport');
  return v && v.trim() ? v.trim() : undefined;
}

export const privateProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const sessionUser = await getSessionUser(ctx.auth, ctx.reqHeaders);
  if (!sessionUser) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'no session' });
  }
  return next({ ctx: { ...ctx, sessionUser } });
});

export const mailboxProcedure = privateProcedure.use(async ({ ctx, next }) => {
  const requestedTransportId = readRequestedTransportId(ctx.reqHeaders);
  const db = getDb();
  try {
    const mailbox = await resolveMailboxContext(
      ctx.sessionUser.id,
      requestedTransportId,
      db,
    );
    return next({ ctx: { ...ctx, ...mailbox } });
  } catch (err) {
    if (err instanceof MailboxForbiddenError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN' });
    }
    throw err;
  }
});

/**
 * Build a `requireMailboxAccess(userId, transportId)` closure bound to a
 * specific db handle. Routes use this when they need to (re)verify access
 * for an id that came from a request body (e.g. attachment lookup that takes
 * a messageId — the messageId is mapped to a transportId, then access is
 * verified).
 */
export function requireMailboxAccessFactory(db: DB) {
  return async (userId: string, transportId: string): Promise<MailboxContext> => {
    try {
      return await resolveMailboxContext(userId, transportId, db);
    } catch (err) {
      if (err instanceof MailboxForbiddenError) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN' });
      }
      throw err;
    }
  };
}
