/**
 * Connections router — thin compatibility wrappers over `mailboxTransport` +
 * `mailboxAccess` so the frontend's `useConnections` / `useActiveConnection`
 * hooks (which still call `connections.list` / `connections.getDefault` /
 * `connections.setDefault` / `connections.delete`) keep working without a
 * frontend rewrite.
 *
 * Task 9 may rewrite the frontend callers to mailbox-native route names; this
 * router exists so the backend route surface is complete now.
 *
 * Semantics mapped:
 *   connection.id        -> transport.id
 *   connection.email     -> transport.email
 *   connection.name      -> transport.displayName
 *   connection.picture   -> null (no avatar column)
 *   connection.providerId -> 'mailbox' (single provider for pilot)
 *   default connection   -> highest-role transport for the user
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import {
  mailboxTransport,
  mailboxAccess,
  type MailboxAccessRole,
} from '../../db/schema/mail.js';

const roleRank: Record<MailboxAccessRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

async function listTransportsForUser(userId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      displayName: mailboxTransport.displayName,
      mailboxType: mailboxTransport.mailboxType,
      role: mailboxAccess.role,
    })
    .from(mailboxAccess)
    .innerJoin(
      mailboxTransport,
      eq(mailboxAccess.transportId, mailboxTransport.id),
    )
    .where(eq(mailboxAccess.userId, userId));
  return rows.sort((a, b) => roleRank[a.role] - roleRank[b.role]);
}

export const connectionsRouter = tRouter({
  list: privateProcedure.query(async ({ ctx }) => {
    const transports = await listTransportsForUser(ctx.sessionUser.id);
    return {
      connections: transports.map((t) => ({
        id: t.id,
        email: t.email,
        name: t.displayName ?? t.email,
        picture: null,
        createdAt: null,
        providerId: 'mailbox',
      })),
      disconnectedIds: [] as string[],
    };
  }),

  getDefault: privateProcedure.query(async ({ ctx }) => {
    const transports = await listTransportsForUser(ctx.sessionUser.id);
    if (transports.length === 0) return null;
    const t = transports[0]!;
    return {
      id: t.id,
      email: t.email,
      name: t.displayName ?? t.email,
      picture: null,
      createdAt: null,
      providerId: 'mailbox',
    };
  }),

  setDefault: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // Verify the user has access to this transport.
      const access = await db
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .where(
          and(
            eq(mailboxAccess.userId, ctx.sessionUser.id),
            eq(mailboxAccess.transportId, input.connectionId),
          ),
        )
        .limit(1);
      if (access.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: connection not found' });
      }
      // No server-side default is persisted for pilot; the frontend stores
      // the active transport id in client state and sends it via the
      // `x-zero-active-transport` header on subsequent requests.
      return { id: input.connectionId };
    }),

  delete: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // Only an owner can remove a mailbox (and only if it's not the last
      // one — pilot guardrail).
      const access = await db
        .select({
          role: mailboxAccess.role,
          transportId: mailboxAccess.transportId,
        })
        .from(mailboxAccess)
        .where(
          and(
            eq(mailboxAccess.userId, ctx.sessionUser.id),
            eq(mailboxAccess.transportId, input.connectionId),
          ),
        )
        .limit(1);
      if (access.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: connection not found' });
      }
      if (access[0]!.role !== 'owner') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'only owners can remove a mailbox',
        });
      }
      // For pilot: refuse to delete the user's only mailbox.
      const transports = await listTransportsForUser(ctx.sessionUser.id);
      if (transports.length <= 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot delete the last mailbox',
        });
      }
      await db
        .delete(mailboxAccess)
        .where(
          and(
            eq(mailboxAccess.userId, ctx.sessionUser.id),
            eq(mailboxAccess.transportId, input.connectionId),
          ),
        );
      return { deleted: true };
    }),
});
