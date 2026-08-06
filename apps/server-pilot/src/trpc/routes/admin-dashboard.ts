import { and, inArray, sql } from 'drizzle-orm';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailThread, mailboxTransport, message } from '../../db/schema/mail.js';
import { assertAdminDashboardAccess } from '../../metrics/admin-dashboard-access.js';
import {
  aggregateAdminDashboardMetrics,
  type AdminDashboardAggregateResult,
} from '../../metrics/admin-dashboard-aggregates.js';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function resolveAdminDashboardWindow(now: Date = new Date()): {
  windowStart: Date;
  windowEnd: Date;
} {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  return { windowStart, windowEnd };
}

export async function loadAdminDashboardMetrics(
  now: Date = new Date(),
): Promise<AdminDashboardAggregateResult> {
  const db = getDb();
  const { windowStart, windowEnd } = resolveAdminDashboardWindow(now);

  const transports = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      displayName: mailboxTransport.displayName,
    })
    .from(mailboxTransport)
    .where(sql`${mailboxTransport.isActive} = true`);

  const transportIds = transports.map((row) => row.id);
  if (transportIds.length === 0) {
    return aggregateAdminDashboardMetrics({
      threads: [],
      messages: [],
      transports: [],
      windowStart,
      windowEnd,
    });
  }

  // Window-bounded message pull first; sargable so message_transport_received_idx applies.
  const messageColumns = {
    id: message.id,
    threadId: message.threadId,
    transportId: message.transportId,
    direction: message.direction,
    receivedAt: message.receivedAt,
    sentAt: message.sentAt,
    createdAt: message.createdAt,
  };
  const inWindow = (start: Date, end: Date) =>
    sql`((${message.receivedAt} >= ${start} AND ${message.receivedAt} < ${end})
      OR (${message.receivedAt} IS NULL AND ${message.createdAt} >= ${start} AND ${message.createdAt} < ${end}))`;

  const messages = await db
    .select(messageColumns)
    .from(message)
    .where(and(inArray(message.transportId, transportIds), inWindow(windowStart, windowEnd)));

  const threadIds = [...new Set(messages.map((row) => row.threadId))];
  if (threadIds.length === 0) {
    return aggregateAdminDashboardMetrics({
      threads: [],
      messages: [],
      transports,
      windowStart,
      windowEnd,
    });
  }

  // Only threads touched in-window; spam/trash eligibility filtered in the pure aggregate.
  const threads = await db
    .select({
      id: mailThread.id,
      transportId: mailThread.transportId,
      spamAt: mailThread.spamAt,
      trashedAt: mailThread.trashedAt,
    })
    .from(mailThread)
    .where(inArray(mailThread.id, threadIds));

  // Replies can land after windowEnd, so extend the outbound pull forward only.
  const outboundExtras = await db
    .select(messageColumns)
    .from(message)
    .where(
      and(
        inArray(message.threadId, threadIds),
        sql`${message.direction} = 'outbound'`,
        sql`coalesce(${message.sentAt}, ${message.receivedAt}, ${message.createdAt}) >= ${windowStart}`,
      ),
    );

  const byId = new Map<string, (typeof messages)[number]>();
  for (const row of [...messages, ...outboundExtras]) {
    byId.set(row.id, row);
  }

  return aggregateAdminDashboardMetrics({
    threads,
    messages: [...byId.values()],
    transports,
    windowStart,
    windowEnd,
  });
}

export const adminDashboardRouter = tRouter({
  getMetrics: privateProcedure.query(async ({ ctx }) => {
    assertAdminDashboardAccess(ctx.sessionUser.email);
    return loadAdminDashboardMetrics();
  }),
});
