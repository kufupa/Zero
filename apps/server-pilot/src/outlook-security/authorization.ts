import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { session, user } from '../db/schema/auth.js';
import { resolveAuthSessionProfile } from '../lib/auth-profile.js';
import { mailboxTransport } from '../db/schema/mail.js';
import { outlookApprovedFolder, outlookBridgeTicket, outlookMoveReceipt, outlookNavigation, outlookNavigationHistory } from '../db/schema/outlook-authorization.js';
import { outlookDevice } from '../db/schema/outlook-device.js';
import { isDeviceAuthorized } from './device.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ticketExpiredDuringTransaction = Symbol('ticket expired while issuing native scope');
export class BridgeTicketDeniedError extends Error {
  constructor() { super('Bridge ticket denied'); }
}
/** Escapes the rolled-back transaction; only the signed HTTP handler exposes its response code. */
export class NativeBatchConsentRequiredError extends Error {
  constructor() { super('Native batch consent required'); }
}
const readActions = new Set(['PING', 'GET_CAPABILITIES', 'LIST_STORES', 'LIST_FOLDERS', 'LIST_ACCOUNTS',
  'GET_ACTIVE_EMAIL', 'GET_FOLDER_EMAILS', 'GET_EMAIL_BY_ENTRY_ID', 'LIST_TEMPLATES', 'GET_TEMPLATE_CONTENT',
  'LIST_SIGNATURES', 'GET_ATTACHMENT_METADATA', 'READ_ATTACHMENT_BASE64', 'GET_CONVERSATION_THREAD']);
const mutationActions = new Set(['CREATE_DRAFT', 'UPDATE_DRAFT', 'CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT',
  'SET_EMAIL_CATEGORY', 'SET_FOLLOW_UP_FLAG', 'MARK_EMAIL_READ', 'CREATE_FOLDER', 'MOVE_EMAIL', 'MOVE_TO_SPAM']);
const moveActions = new Set(['MOVE_EMAIL', 'MOVE_TO_SPAM']);
const itemReadActions = new Set(['GET_EMAIL_BY_ENTRY_ID', 'GET_ATTACHMENT_METADATA', 'READ_ATTACHMENT_BASE64',
  'GET_CONVERSATION_THREAD', 'GET_TEMPLATE_CONTENT']);
const itemMutationActions = new Set(['UPDATE_DRAFT', 'CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT',
  'SET_EMAIL_CATEGORY', 'SET_FOLLOW_UP_FLAG', 'MARK_EMAIL_READ']);
const isToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const isOp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = /^op_(\d{13})_([0-9a-f]{32})$/.exec(value);
  if (!match) return false;
  const created = Number(match[1]);
  return created <= Date.now() + 5000 && Date.now() - created <= 15 * 60_000;
};

export type TicketInput = { deviceId: string; paneChallenge: string; action: string; storeId?: string; operationId?: string;
  transportId: string; resources?: string[]; sourceFolderId?: string; destinationFolderId?: string };
export type NativeScopeInput = { ticket: string; action: string; storeId: string; transportId: string;
  operationId?: string; resources?: string[]; sourceFolderId?: string; destinationFolderId?: string;
  sourceKind?: string; destinationKind?: string; nativeBatchConsent?: boolean };

/** Server-only operator provisioning. Never expose this mutation to tRPC or public HTTP. */
export async function provisionApprovedFolder(db: DB, input: { storeId: string; transportId: string; folderId: string; kind: 'triage' | 'inbox' | 'spam' }) {
  if (![input.storeId, input.transportId, input.folderId].every(isToken)) throw new Error('Invalid folder approval');
  const [transport] = await db.select({ id: mailboxTransport.id }).from(mailboxTransport)
    .where(and(eq(mailboxTransport.id, input.transportId), eq(mailboxTransport.isActive, true))).limit(1);
  if (!transport) throw new Error('Inactive mailbox transport');
  await db.insert(outlookApprovedFolder).values(input).onConflictDoUpdate({
    target: [outlookApprovedFolder.transportId, outlookApprovedFolder.storeId, outlookApprovedFolder.folderId], set: { kind: input.kind },
  });
}

/** Signed native registration replaces the previous navigation atomically. */
export async function registerNavigation(db: DB, deviceId: string, paneChallenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(paneChallenge) || Buffer.from(paneChallenge, 'base64url').length !== 32) return false;
  return db.transaction(async (tx) => {
    const challengeHash = hash(paneChallenge);
    const [firstUse] = await tx.insert(outlookNavigationHistory).values({ deviceId, challengeHash })
      .onConflictDoNothing().returning({ deviceId: outlookNavigationHistory.deviceId });
    if (!firstUse) return false;
    await tx.insert(outlookNavigation).values({ deviceId, challengeHash,
      expiresAt: new Date(Date.now() + 60_000) }).onConflictDoUpdate({ target: outlookNavigation.deviceId,
      set: { challengeHash, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() } });
    return true;
  });
}

type AuthSession = { api: { getSession(input: { headers: Headers }): Promise<{
  user: { id: string }; session: { id: string }
} | null> } };

async function liveSession(db: DB, auth: AuthSession, headers: Headers) {
  if (resolveAuthSessionProfile() !== 'legacy') return null;
  const result = await auth.api.getSession({ headers });
  const id = result?.session?.id;
  const userId = result?.user?.id;
  if (!id || !userId) return null;
  const table = session;
  const [found] = await db.select({ id: table.id, userId: table.userId }).from(table)
    .innerJoin(user, eq(table.userId, user.id))
    .where(and(eq(table.id, id), eq(table.userId, userId), eq(user.emailVerified, true),
      gt(table.expiresAt, sql`clock_timestamp()`),
      gt(sql`${table.createdAt} + interval '24 hours'`, sql`clock_timestamp()`),
      sql`${table.createdAt} <= clock_timestamp()`)).limit(1);
  return found ?? null;
}

export async function issueBridgeTicket(db: DB, auth: AuthSession, headers: Headers, input: TicketInput): Promise<{ ticket: string; storeId: string; expiresInSeconds: 60 }> {
  const identity = await liveSession(db, auth, headers);
  if (!identity || !isToken(input.transportId) || input.storeId !== undefined && !isToken(input.storeId)
    || !/^[0-9a-f-]{36}$/i.test(input.deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(input.paneChallenge)
    || !(readActions.has(input.action) || mutationActions.has(input.action))
    || (mutationActions.has(input.action) && !isOp(input.operationId))
    || (readActions.has(input.action) && input.operationId !== undefined)) throw new BridgeTicketDeniedError();
  if (input.resources !== undefined && (!Array.isArray(input.resources) || input.resources.length > 25
    || input.resources.some((resource) => !isToken(resource)) || new Set(input.resources).size !== input.resources.length)) throw new BridgeTicketDeniedError();
  if (input.sourceFolderId !== undefined && !isToken(input.sourceFolderId)
    || input.destinationFolderId !== undefined && !isToken(input.destinationFolderId)
    || (itemReadActions.has(input.action) || itemMutationActions.has(input.action)) && !input.resources?.length
    || input.action === 'GET_FOLDER_EMAILS' && !input.sourceFolderId
    || input.action === 'CREATE_FOLDER' && !input.sourceFolderId
    || moveActions.has(input.action) && (!input.resources?.length || !input.sourceFolderId || !input.destinationFolderId)) throw new BridgeTicketDeniedError();
  return db.transaction(async (tx) => {
    const [navigation] = await tx.select({ challengeHash: outlookNavigation.challengeHash }).from(outlookNavigation)
      .where(and(eq(outlookNavigation.deviceId, input.deviceId), eq(outlookNavigation.challengeHash, hash(input.paneChallenge)),
        gt(outlookNavigation.expiresAt, sql`clock_timestamp()`))).for('update').limit(1);
    if (!navigation) throw new BridgeTicketDeniedError();
    const [device] = await tx.select({ storeId: outlookDevice.storeId }).from(outlookDevice)
      .where(and(eq(outlookDevice.deviceId, input.deviceId), isNull(outlookDevice.revokedAt))).limit(1);
    if (!device || input.storeId !== undefined && input.storeId !== device.storeId
      || !await isDeviceAuthorized(tx as DB, input.deviceId, identity.userId, input.transportId, device.storeId)) throw new BridgeTicketDeniedError();
    const storeId = device.storeId;
    // Previous session's navigation cannot be reused after logout/re-login; lock serializes races.
    const [previousSession] = await tx.select({ sessionId: outlookBridgeTicket.sessionId }).from(outlookBridgeTicket)
      .where(and(eq(outlookBridgeTicket.deviceId, input.deviceId), eq(outlookBridgeTicket.challengeHash, navigation.challengeHash),
        ne(outlookBridgeTicket.sessionId, identity.id))).limit(1);
    if (previousSession) throw new BridgeTicketDeniedError();
    if (input.storeId === undefined) {
      // The signed-in pane learns its enrolled store only on the first ticket
      // for this registered navigation. Every later request must echo it.
      const [previousTicket] = await tx.select({ ticketHash: outlookBridgeTicket.ticketHash }).from(outlookBridgeTicket)
        .where(and(eq(outlookBridgeTicket.deviceId, input.deviceId),
          eq(outlookBridgeTicket.challengeHash, navigation.challengeHash))).limit(1);
      if (previousTicket) throw new BridgeTicketDeniedError();
    }
    const ticket = randomBytes(32).toString('base64url');
    await tx.insert(outlookBridgeTicket).values({ ticketHash: hash(ticket), deviceId: input.deviceId,
      challengeHash: navigation.challengeHash, sessionId: identity.id, userId: identity.userId,
      transportId: input.transportId, storeId, action: input.action,
      operationId: input.operationId ?? null, declaredScope: JSON.stringify([
        input.resources ?? null, input.sourceFolderId ?? null, input.destinationFolderId ?? null,
      ]), expiresAt: new Date(Date.now() + 60_000) });
    return { ticket, storeId, expiresInSeconds: 60 };
  });
}

function validResourceScope(input: NativeScopeInput): boolean {
  if (!isToken(input.storeId) || !isToken(input.transportId) || !readActions.has(input.action) && !mutationActions.has(input.action)) return false;
  if (input.resources !== undefined && (!Array.isArray(input.resources) || input.resources.length > 25
    || input.resources.some((item) => !isToken(item)) || new Set(input.resources).size !== input.resources.length)) return false;
  if (mutationActions.has(input.action) && (!isOp(input.operationId)
    || input.action !== 'CREATE_DRAFT' && input.action !== 'CREATE_FOLDER' && !input.resources?.length)) return false;
  if (moveActions.has(input.action) && (!isToken(input.sourceFolderId) || !isToken(input.destinationFolderId))) return false;
  if (input.action === 'CREATE_FOLDER' && !isToken(input.sourceFolderId)) return false;
  // Native must explicitly report actual Outlook folder identities. No denylist-only shortcuts.
  if (itemReadActions.has(input.action) && !input.resources?.length) return false;
  if (input.action === 'GET_FOLDER_EMAILS' && !isToken(input.sourceFolderId)) return false;
  if (['deleted', 'outbox', 'deleted-child', 'outbox-child'].includes(input.destinationKind ?? '')) return false;
  if (input.action === 'MOVE_EMAIL' && input.destinationKind !== 'triage' && input.destinationKind !== 'inbox') return false;
  if (input.action === 'MOVE_TO_SPAM' && input.destinationKind !== 'spam') return false;
  return true;
}

/** Called only after successful independent signed-device verification. One ticket -> one scoped native response. */
export async function authorizeNative(db: DB, deviceId: string, input: NativeScopeInput): Promise<Record<string, unknown> | null> {
  if (resolveAuthSessionProfile() !== 'legacy' || !/^[A-Za-z0-9_-]{43}$/.test(input.ticket) || !validResourceScope(input)) return null;
  return db.transaction(async (tx) => {
    const [ticket] = await tx.select().from(outlookBridgeTicket)
      .where(and(eq(outlookBridgeTicket.ticketHash, hash(input.ticket)), eq(outlookBridgeTicket.deviceId, deviceId),
        isNull(outlookBridgeTicket.consumedAt), gt(outlookBridgeTicket.expiresAt, sql`clock_timestamp()`)))
      .for('update').limit(1);
    if (!ticket || ticket.storeId !== input.storeId || ticket.transportId !== input.transportId
      || ticket.action !== input.action || ticket.operationId !== (input.operationId ?? null)) return null;
    const [declaredResources, declaredSource, declaredDestination] = JSON.parse(ticket.declaredScope ?? '[null,null,null]') as [string[] | null, string | null, string | null];
    if (declaredResources !== null && JSON.stringify(declaredResources) !== JSON.stringify(input.resources ?? null)
      || declaredSource !== null && declaredSource !== input.sourceFolderId
      || declaredDestination !== null && declaredDestination !== input.destinationFolderId) return null;
    const [navigation] = await tx.select({ challengeHash: outlookNavigation.challengeHash }).from(outlookNavigation)
      .where(and(eq(outlookNavigation.deviceId, deviceId), eq(outlookNavigation.challengeHash, ticket.challengeHash),
        gt(outlookNavigation.expiresAt, sql`clock_timestamp()`))).limit(1);
    const table = session;
    const [staff] = await tx.select({ id: table.id, createdAt: table.createdAt, expiresAt: table.expiresAt })
      .from(table).innerJoin(user, eq(user.id, table.userId))
      .where(and(eq(table.id, ticket.sessionId), eq(table.userId, ticket.userId), eq(user.emailVerified, true),
        gt(table.expiresAt, sql`clock_timestamp()`),
        gt(sql`${table.createdAt} + interval '24 hours'`, sql`clock_timestamp()`),
        sql`${table.createdAt} <= clock_timestamp()`)).for('share').limit(1);
    if (!navigation || !staff || !await isDeviceAuthorized(tx as DB, deviceId, ticket.userId, ticket.transportId, input.storeId)) return null;
    const folderRows = await tx.select({ folderId: outlookApprovedFolder.folderId, kind: outlookApprovedFolder.kind })
      .from(outlookApprovedFolder).where(and(eq(outlookApprovedFolder.storeId, input.storeId),
        eq(outlookApprovedFolder.transportId, input.transportId)));
    const approved = (id: string | undefined, kind?: string) => folderRows.some((row) => row.folderId === id && (!kind || row.kind === kind));
    if (input.sourceFolderId && !approved(input.sourceFolderId)) return null;
    if (input.destinationFolderId && !approved(input.destinationFolderId, input.destinationKind)) return null;
    if (moveActions.has(input.action) && (!approved(input.sourceFolderId) || !approved(input.destinationFolderId, input.destinationKind))) return null;
    const scopeHash = hash(JSON.stringify([input.action, input.storeId, input.transportId, input.operationId,
      input.resources ?? [], input.sourceFolderId ?? null, input.destinationFolderId ?? null]));
    let retry = false;
    if (moveActions.has(input.action)) {
      // Lock the shared mailbox row; all devices serialize budget accounting across panes/restarts.
      await tx.select({ id: mailboxTransport.id }).from(mailboxTransport)
        .where(eq(mailboxTransport.id, input.transportId)).for('update');
      const [prior] = await tx.select().from(outlookMoveReceipt).where(and(eq(outlookMoveReceipt.transportId, input.transportId),
        eq(outlookMoveReceipt.deviceId, deviceId), eq(outlookMoveReceipt.operationId, input.operationId!))).limit(1);
      if (prior) {
        if (prior.scopeHash !== scopeHash || prior.count !== input.resources!.length) return null;
        retry = true;
      } else {
        const [budget] = await tx.select({ total: sql<number>`coalesce(sum(${outlookMoveReceipt.count}), 0)` })
          .from(outlookMoveReceipt).where(and(eq(outlookMoveReceipt.transportId, input.transportId),
            gt(outlookMoveReceipt.approvedAt, sql`clock_timestamp() - interval '1 minute'`)));
        const [deviceBudget] = await tx.select({ total: sql<number>`coalesce(sum(${outlookMoveReceipt.count}), 0)` })
          .from(outlookMoveReceipt).where(and(eq(outlookMoveReceipt.deviceId, deviceId),
            gt(outlookMoveReceipt.approvedAt, sql`clock_timestamp() - interval '1 minute'`)));
        if (input.nativeBatchConsent !== true && (Number(budget?.total ?? 0) + input.resources!.length > 25
          || Number(deviceBudget?.total ?? 0) + input.resources!.length > 25
          || input.resources!.length >= 10)) {
          // The mailbox lock can outlive the initial ticket/session/navigation
          // checks. Never hint for native consent after any authority expires.
          const [fresh] = await tx.select({ ticketHash: outlookBridgeTicket.ticketHash }).from(outlookBridgeTicket)
            .innerJoin(session, and(eq(session.id, outlookBridgeTicket.sessionId),
              eq(session.userId, outlookBridgeTicket.userId)))
            .where(and(eq(outlookBridgeTicket.ticketHash, ticket.ticketHash),
              isNull(outlookBridgeTicket.consumedAt), gt(outlookBridgeTicket.expiresAt, sql`clock_timestamp()`),
              gt(session.expiresAt, sql`clock_timestamp()`),
              gt(sql`${session.createdAt} + interval '24 hours'`, sql`clock_timestamp()`),
              sql`${session.createdAt} <= clock_timestamp()`)).limit(1);
          const [freshNavigation] = await tx.select({ deviceId: outlookNavigation.deviceId }).from(outlookNavigation)
            .where(and(eq(outlookNavigation.deviceId, deviceId), eq(outlookNavigation.challengeHash, ticket.challengeHash),
              gt(outlookNavigation.expiresAt, sql`clock_timestamp()`))).limit(1);
          if (!fresh || !freshNavigation
            || !await isDeviceAuthorized(tx as DB, deviceId, ticket.userId, ticket.transportId, input.storeId)) return null;
          const currentFolders = await tx.select({ folderId: outlookApprovedFolder.folderId, kind: outlookApprovedFolder.kind })
            .from(outlookApprovedFolder).where(and(eq(outlookApprovedFolder.storeId, input.storeId),
              eq(outlookApprovedFolder.transportId, input.transportId)));
          if (!currentFolders.some((row) => row.folderId === input.sourceFolderId)
            || !currentFolders.some((row) => row.folderId === input.destinationFolderId && row.kind === input.destinationKind)) return null;
          throw new NativeBatchConsentRequiredError();
        }
        await tx.insert(outlookMoveReceipt).values({ deviceId, transportId: input.transportId,
          operationId: input.operationId!, scopeHash, count: input.resources!.length,
          approvedAt: sql`clock_timestamp()` });
      }
    }
    const claimed = await tx.update(outlookBridgeTicket).set({ consumedAt: new Date() })
      .where(and(eq(outlookBridgeTicket.ticketHash, ticket.ticketHash), isNull(outlookBridgeTicket.consumedAt),
        gt(outlookBridgeTicket.expiresAt, sql`clock_timestamp()`),
        sql`exists (select 1 from "session" s where s.id = ${ticket.sessionId} and s.user_id = ${ticket.userId}
          and s.expires_at > clock_timestamp() and s.created_at + interval '24 hours' > clock_timestamp())`))
      .returning({ ticketHash: outlookBridgeTicket.ticketHash });
    // Returning null here would COMMIT a provisional move receipt. Roll back instead.
    if (claimed.length !== 1) throw ticketExpiredDuringTransaction;
    const mutation = mutationActions.has(input.action);
    const expiresAt = new Date(Math.min(Date.now() + (mutation ? 15_000 : 60_000),
      staff.expiresAt.getTime(), staff.createdAt.getTime() + 24 * 60 * 60_000));
    if (expiresAt.getTime() <= Date.now()) throw ticketExpiredDuringTransaction;
    return { kind: mutation ? 'mutation' : 'read', action: input.action, storeId: input.storeId,
      transportId: input.transportId, operationId: input.operationId ?? null, resources: input.resources ?? [],
      sourceFolderId: input.sourceFolderId ?? null, destinationFolderId: input.destinationFolderId ?? null,
      approvedFolderIds: folderRows.map((row) => ({ folderId: row.folderId, kind: row.kind })),
      retry, expiresAt: expiresAt.toISOString() };
  }).catch((error: unknown) => {
    if (error === ticketExpiredDuringTransaction) return null;
    throw error;
  });
}
