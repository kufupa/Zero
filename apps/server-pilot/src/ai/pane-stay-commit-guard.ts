import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workItem } from '../db/schema/work.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import { PANE_STAY_ALREADY_BOOKED, stayCommitsOf, type StayCommitRecord } from './work-items.js';

const CLAIMS_KEY = 'paneStaySaveClaims';
type State = Record<string, unknown>;
type ClaimInput = { transportId: string; workItemId: string; stayId: string; parentStayId?: string };
type ClaimResult = { status: 'ready'; claimId: string; parentConfirmation?: string } | { status: 'refused'; reason: string };

function object(value: unknown): State | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as State : null;
}

/** Fence pane commits at the property until an earlier save is verified or cleared. */
export async function claimPaneStayCommit(db: DB, input: ClaimInput): Promise<ClaimResult> {
  const property = resolvePropertyTransport(input.transportId);
  if (property.kind !== 'property') return { status: 'refused', reason: 'pane_save_work_item_unavailable' };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pane-stay-commit'), hashtext(${property.property.propertyCode}))`);
    const [item] = await tx.select({ state: workItem.state }).from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1).for('update');
    if (!item) return { status: 'refused', reason: 'pane_save_work_item_unavailable' };
    const rawStays = item.state.stays === undefined ? {} : object(item.state.stays);
    const claims = item.state[CLAIMS_KEY] === undefined ? {} : object(item.state[CLAIMS_KEY]);
    const commits = stayCommitsOf(item.state);
    // A malformed receipt or claim cannot be silently treated as an empty, safe work item.
    if (!rawStays || !claims || Object.keys(rawStays).length !== Object.keys(commits).length) {
      return { status: 'refused', reason: 'pane_save_work_item_unavailable' };
    }
    const current = commits[input.stayId];
    if (current?.status === 'unknown' || (current && !current.confirmationNumber)) {
      return { status: 'refused', reason: 'pane_save_unconfirmed' };
    }
    if (current?.confirmationNumber) return { status: 'refused', reason: PANE_STAY_ALREADY_BOOKED };
    if (Object.keys(claims).length || Object.values(commits).some((record) =>
      record.status === 'unknown' || !/^\d{6,10}-\d{1,2}$/.test(record.confirmationNumber ?? ''))) {
      return { status: 'refused', reason: 'pane_save_dependency_unconfirmed' };
    }

    // Legacy receipts have no booking identity: an unresolved save holds the whole hotel, across its mailboxes.
    const [unresolved] = await tx.select({ id: workItem.id }).from(workItem).where(and(
      inArray(workItem.transportId, [...property.property.transportIds]), ne(workItem.id, input.workItemId), sql`(
        jsonb_typeof(${workItem.state}) IS DISTINCT FROM 'object' OR ${workItem.state} ? 'paneStaySaveClaims'
        OR (${workItem.state} ? 'stays' AND jsonb_typeof(${workItem.state}->'stays') IS DISTINCT FROM 'object')
        OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(${workItem.state}->'stays') = 'object'
          THEN ${workItem.state}->'stays' ELSE '{}'::jsonb END) AS s
          WHERE s.key !~ '^[A-Za-z0-9_-]{1,40}$' OR s.value->>'status' IS DISTINCT FROM 'booked'
          OR jsonb_typeof(s.value->'confirmationNumber') IS DISTINCT FROM 'string'
          OR btrim(s.value->>'confirmationNumber') !~ '^[0-9]{6,10}-[0-9]{1,2}$')
      )`,
    )).limit(1);
    if (unresolved) return { status: 'refused', reason: 'pane_save_dependency_unconfirmed' };

    let parentConfirmation: string | undefined;
    if (input.parentStayId) {
      const parent = input.parentStayId !== input.stayId ? commits[input.parentStayId] : undefined;
      if (parent?.status !== 'booked' || !parent.confirmationNumber) {
        return { status: 'refused', reason: 'pane_save_parent_not_booked' };
      }
      parentConfirmation = parent.confirmationNumber;
    }
    const claimId = randomUUID();
    const next: State = {
      ...item.state,
      stays: { ...rawStays, [input.stayId]: { status: 'unknown', confirmationNumber: null, screenshotRef: null } },
      [CLAIMS_KEY]: { ...claims, [input.stayId]: claimId },
    };
    await tx.update(workItem).set({ state: next, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    return { status: 'ready', claimId, ...(parentConfirmation ? { parentConfirmation } : {}) };
  });
}

/** Finalize only our own pending claim; never overwrite a confirmation written by another actor. */
export async function finishPaneStayCommit(
  db: DB,
  input: ClaimInput & { claimId: string; record: StayCommitRecord | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select({ state: workItem.state }).from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1).for('update');
    if (!item) return false;
    const rawStays = object(item.state.stays);
    const rawClaims = object(item.state[CLAIMS_KEY]);
    const current = stayCommitsOf(item.state)[input.stayId];
    if (!rawStays || !rawClaims || rawClaims[input.stayId] !== input.claimId ||
        current?.status !== 'unknown' || current.confirmationNumber !== null) return false;

    const stays = { ...rawStays };
    if (input.record) stays[input.stayId] = input.record;
    else delete stays[input.stayId]; // The runner proved it never reached Save.
    const claims = { ...rawClaims };
    delete claims[input.stayId];
    const next: State = { ...item.state, stays };
    if (Object.keys(claims).length) next[CLAIMS_KEY] = claims;
    else delete next[CLAIMS_KEY];
    await tx.update(workItem).set({ state: next, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    return true;
  });
}
