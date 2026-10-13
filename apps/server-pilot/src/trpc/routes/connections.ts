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
 *   default connection   -> is_default row, else highest-role transport
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { privateProcedure, readRequestedTransportId, router as tRouter } from '../trpc.js';
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

type TransportRow = {
  id: string;
  email: string;
  displayName: string | null;
  mailboxType: 'personal' | 'shared';
  role: MailboxAccessRole;
  isDefault: boolean;
};

function sortTransports(rows: TransportRow[]) {
  return rows.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return roleRank[a.role] - roleRank[b.role];
  });
}

async function listTransportsForUser(userId: string): Promise<TransportRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      displayName: mailboxTransport.displayName,
      mailboxType: mailboxTransport.mailboxType,
      role: mailboxAccess.role,
      isDefault: mailboxAccess.isDefault,
    })
    .from(mailboxAccess)
    .innerJoin(
      mailboxTransport,
      eq(mailboxAccess.transportId, mailboxTransport.id),
    )
    .where(eq(mailboxAccess.userId, userId));
  return sortTransports(rows);
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
    // The mailbox this request asked for (x-zero-active-transport) wins, so the pane's mailbox email matches the one
    // mailbox procedures resolve; a header for a mailbox the user cannot open falls back to the default.
    const requested = readRequestedTransportId(ctx.reqHeaders);
    const t = transports.find((row) => row.id === requested) ?? transports[0]!;
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
      const userId = ctx.sessionUser.id;
      // Verify the user has access to this transport.
      const access = await db
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .where(
          and(
            eq(mailboxAccess.userId, userId),
            eq(mailboxAccess.transportId, input.connectionId),
          ),
        )
        .limit(1);
      if (access.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: connection not found' });
      }
      await db.transaction(async (tx) => {
        await tx
          .update(mailboxAccess)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(mailboxAccess.userId, userId));
        await tx
          .update(mailboxAccess)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(mailboxAccess.userId, userId),
              eq(mailboxAccess.transportId, input.connectionId),
            ),
          );
      });
      return { id: input.connectionId };
    }),

  delete: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const userId = ctx.sessionUser.id;
      const access = await db
        .select({
          role: mailboxAccess.role,
          transportId: mailboxAccess.transportId,
          isDefault: mailboxAccess.isDefault,
        })
        .from(mailboxAccess)
        .where(
          and(
            eq(mailboxAccess.userId, userId),
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
      const transports = await listTransportsForUser(userId);
      if (transports.length <= 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot delete the last mailbox',
        });
      }
      const wasDefault = access[0]!.isDefault;
      await db
        .delete(mailboxAccess)
        .where(
          and(
            eq(mailboxAccess.userId, userId),
            eq(mailboxAccess.transportId, input.connectionId),
          ),
        );
      const remaining = (await listTransportsForUser(userId)).filter(
        (t) => t.id !== input.connectionId,
      );
      let nextDefaultId: string | null = remaining[0]?.id ?? null;
      if (wasDefault && remaining.length > 0) {
        nextDefaultId = remaining[0]!.id;
        await db
          .update(mailboxAccess)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(mailboxAccess.userId, userId),
              eq(mailboxAccess.transportId, nextDefaultId),
            ),
          );
      }
      return { deleted: true, nextDefaultId };
    }),
});
