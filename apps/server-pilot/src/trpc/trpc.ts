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
import {
  staffQuoteRoomAlternatives,
  type StaffQuoteRoomAlternative,
} from '../ai/staff-quote-alternatives.js';
import type { Auth } from '../lib/auth.js';
import { getDb, type DB } from '../db/client.js';
import {
  resolveMailboxContext,
  type MailboxContext,
  MailboxForbiddenError,
  MailboxNoAccessError,
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

function staffQuoteAlternativesFromError(error: TRPCError): StaffQuoteRoomAlternative[] | undefined {
  if (error.code !== 'PRECONDITION_FAILED' || !error.cause || typeof error.cause !== 'object') {
    return undefined;
  }
  const cause = error.cause as { staffQuoteRefusal?: unknown; alternatives?: unknown };
  if (cause.staffQuoteRefusal !== true) return undefined;
  const alternatives = staffQuoteRoomAlternatives(cause.alternatives);
  return alternatives.length ? alternatives : undefined;
}

const t = initTRPC.context<TrpcSourceContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => {
    const alternatives = staffQuoteAlternativesFromError(error);
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(alternatives ? { alternatives } : {}),
      },
    };
  },
});

function noMailboxTrpcError(): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: 'NO_MAILBOX',
  });
}

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
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  const u = session.user as { id: string; email: string; name?: string | null };
  return { id: u.id, email: u.email, name: u.name ?? null };
}

/**
 * Read the requested transport id from the `x-zero-active-transport` header.
 *
 * The frontend mailbox switcher sets this header on every tRPC request once
 * the user has selected a mailbox. Absent -> undefined -> resolver picks the
 * user's highest-role transport.
 */
export function readRequestedTransportId(headers: Headers): string | undefined {
  const v = headers.get('x-zero-active-transport');
  return v && v.trim() ? v.trim() : undefined;
}

const isTest = process.env.NODE_ENV === 'test';

export const privateProcedure = publicProcedure.use(async ({ ctx, next }) => {
  // Tests inject `sessionUser` directly (see tests/helpers/trpc-caller.ts) to
  // bypass Better Auth; short-circuit only in test env.
  const injected = isTest
    ? (ctx as Partial<TrpcPrivateContext>).sessionUser
    : undefined;
  if (injected) {
    return next({ ctx: { ...ctx, sessionUser: injected } });
  }
  const sessionUser = await getSessionUser(ctx.auth, ctx.reqHeaders);
  if (!sessionUser) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'no session' });
  }
  return next({ ctx: { ...ctx, sessionUser } });
});

export const mailboxProcedure = privateProcedure.use(async ({ ctx, next }) => {
  // Tests inject a pre-resolved MailboxContext (activeTransportId, accessRole,
  // transportEmail) directly; short-circuit only in test env.
  const injected = isTest ? (ctx as Partial<MailboxContext>) : {};
  if (injected.activeTransportId && injected.accessRole) {
    const mailbox: MailboxContext = {
      userId: ctx.sessionUser.id,
      activeTransportId: injected.activeTransportId,
      transportEmail: injected.transportEmail ?? '',
      accessRole: injected.accessRole,
    };
    return next({ ctx: { ...ctx, ...mailbox } });
  }
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
    if (err instanceof MailboxNoAccessError) {
      throw noMailboxTrpcError();
    }
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
      if (err instanceof MailboxNoAccessError) {
        throw noMailboxTrpcError();
      }
      if (err instanceof MailboxForbiddenError) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN' });
      }
      throw err;
    }
  };
}

/**
 * Standalone 2-arg facade matching the spec's literal API surface:
 *
 *   await requireMailboxAccess(ctx.userId, ctx.activeTransportId);
 *
 * Wraps `resolveMailboxContext(userId, transportId, getDb())` and maps
 * `MailboxForbiddenError` -> `TRPCError({ code: 'FORBIDDEN' })`. This is the
 * call shape the brief documents; the `mailboxProcedure` middleware still
 * does the same check upstream (so routes that go through it are already
 * guarded), but this export exists so callers that hold a (userId,
 * transportId) pair outside a tRPC procedure — or routes that re-verify
 * access for a body-supplied id — can use the exact name the spec describes
 * without having to thread a `db` handle themselves.
 *
 * The `requireMailboxAccessFactory(db)` variant remains for code paths that
 * already hold a transaction-scoped db handle (e.g. attachment re-verification
 * inside a route that opened its own tx). Both share `resolveMailboxContext`
 * as the single source of truth for the access check.
 */
export async function requireMailboxAccess(
  userId: string,
  transportId: string,
): Promise<MailboxContext> {
  try {
    return await resolveMailboxContext(userId, transportId, getDb());
  } catch (err) {
    if (err instanceof MailboxNoAccessError) {
      throw noMailboxTrpcError();
    }
    if (err instanceof MailboxForbiddenError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN' });
    }
    throw err;
  }
}
