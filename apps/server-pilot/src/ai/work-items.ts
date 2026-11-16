import { failedReadFingerprint } from './extraction/retry-binding.js';
import { randomUUID } from 'node:crypto';
import { MANUAL_CREATE_KEY, manualCreateMarker, manualCreatePayload } from './manual-create-source.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, attachment, mailActionLabel, mailboxAccess, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { sqlList } from '../db/schema/hitl.js';
import { MESSAGE_ARRIVED_AT, MESSAGE_DELIVERED_AT, OUTLOOK_SYNCED } from './message-arrival-time.js';
export { MESSAGE_ARRIVED_AT, MESSAGE_DELIVERED_AT, OUTLOOK_SYNCED } from './message-arrival-time.js';
import {
  FOLLOW_UP_DRAFT_FIELD_PATH,
  MAIL_KINDS,
  mailExtraction,
  TELEMETRY_EVENT_TYPES,
  workEvent,
  workItem,
} from '../db/schema/work.js';
import type { AttachmentRead } from './extraction/extract.js';
import { safeParseStoredMailExtraction } from './extraction/stored-mail-extraction.js';
import { hydrateStoredFieldPath, hydrateStoredWorkState, storedFieldPathAliases } from './stored-work-state.js';
import {
  rowContentKey,
  stayContentKey,
  type ExtractionStay,
  type MailExtractionPayload,
  type MailKind,
} from './extraction/schema.js';
import {
  canonicalInternetMessageId,
  currentSourceText,
  documentFailureItems,
  hmsTodoCardFromLuna,
  numberGroupReviewItems,
  questionItems,
} from './quote-workflow-analyse-selection.js';
import { amendmentFromAnalysis, mapLlmDecision, validIsoDate } from './quote-workflow-llm.js';
import {
  isHmsConfirmation,
  loadSyncedQuoteSelectionFromMailbox,
  overlayHmsConfirmation,
  type ThreadConfirmationResolution,
} from './quote-workflow-synced-selection.js';
import { aopQuoteChannelFromSender } from './aop-playbook.js';
import { matchRoomType } from './room-types.js';
import { normalizeEmailAddress, PUBLIC_MAIL_DOMAINS } from './never-spam.js';
import { isSelfSentPreStaySubject, preStaySourceText, selfSentPreStayAskVerdict } from './existing-stay-information.js';
import { collectNeedsYouPages, type NeedsYouCursor } from './work-items-list-pages.js';
import { isNoReplyAddress } from '../mail/conversation-signals.js';
import { paneSourceSelectionCondition, type PaneSourceSelection } from '../mail/pane-source-selection.js';
import {
  getPropertyTransportIds,
  resolvePropertyTransport,
} from '../../tooling/hms-cloud/property-registry.mjs';
import {
  COARSE_TO_AGENT,
  parseStoredClassifier,
  shouldAttachWorkflowHint,
  type ClassifierResult,
} from './workflow-classifier/index.js';
import type { LunaAnalysis } from './reservationist-decision.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import {
  amendEmailValue,
  type AmendField, type DraftSource,
} from './pane-amend-draft.js';
import { parseRequestField, requestFieldApplies, requestIdFor, sourceRequests, validRequestValue } from './work-item-fields.js';
import { createRequestSourceValue, effectiveActions, projectEffectiveWork, type EffectiveRequest } from './work-item-effective.js';
import { projectCancelRequests } from './pane-cancel-draft.js';
import { enqueueReplyCheckIfNeeded, REPLY_NEEDS_ACTION } from './reply-check.js';
import { advancePaneRevision } from './work-item-revision.js';
import { assertCreateDispatchFenceOwner, assertNoCreateDispatchFence, CreateFenceError,
  type CreateFenceIdentity } from './pane-create-dispatch-fence.js';
import { stayPreviewsOf, type StayPreviewRecord } from './pane-stay-preview-persist.js';
import { handledRequestKeys, handledRequestStates, hasOutstandingRequestHistory } from './reservationist-task-completion.js';
import { confirmedVoucherKey, voucherReviewFiles } from './voucher-pending.js';
import { hydrateStoredReservationWorkflowV2 } from './reservation-workflow-v2-stored-draft.js';
import { reservationArrivalEvidenceBatch } from './reservation-workflow-v2-evidence.js';
import {
  reservationWorkflowV2DraftSchema,
  reservationWorkflowV2IntakeSchema,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2Intake,
} from './reservation-workflow-v2-contract.js';
import { canonicalSourceBodyText, classifyMailSource } from './mail-source.js';
import { fileAttachmentPresence } from '../mail/ingest/attachment-evidence.js';
import type { CloudCreateHoldProjection } from './pane-cloud-preview.js';

/**
 * Work items for the Nava pane (U4). One work item is one person's job on one mail. Its `state` holds only the field
 * paths a person has touched, so a re-extraction never overwrites a person's value: every other value reads through
 * from the latest succeeded extraction. Paths use the extraction's stable ids (`stays[s_x].requested.arrival`,
 * `stays[s_x].rows[r_y].count`), so deleting one stay never shifts another stay's AI value. A path on an id the
 * extraction does not have is a stay or row the person added, and `stays[s_x].removed` / `...rows[r_y].removed`
 * (true) is one she deleted. Both come back on reopen.
 *
 * The contact block uses `contact.name`, `contact.bookingAgency`, `contact.organization`, `contact.email` and `contact.phone`.
 */

export const ROW_FIELDS = ['count', 'adults', 'roomType', 'childAges', 'mealPlan'] as const;
export type RowField = (typeof ROW_FIELDS)[number];
export type FieldPath =
  | { stayId: string; rowId: null; field: 'arrival' | 'departure' | 'totalAdults' | 'totalChildren' | 'removed' }
  | { stayId: string; rowId: string; field: RowField | 'removed' };
export type WorkState = Record<string, unknown>;

const ID = '[A-Za-z0-9_-]{1,40}';
const PATH = new RegExp(
  `^stays\\[(${ID})\\]\\.(?:requested\\.(arrival|departure)|(totalAdults|totalChildren)|(removed)|rows\\[(${ID})\\]\\.(${ROW_FIELDS.join('|')}|removed))$`,
);
/** Row field to the extraction's key. The path names the form's word, the payload the model's. */
const ROW_KEYS = {
  count: 'rooms',
  adults: 'adultsPerRoom',
  roomType: 'roomType',
  childAges: 'childAges',
  mealPlan: 'mealPlan',
} as const;
const BOARDS = new Set(['room_only', 'bb', 'dbb']);

export function parseFieldPath(path: string): FieldPath | null {
  const match = PATH.exec(path);
  if (!match) return null;
  const [, stayId = '', dateField, stayTotal, stayRemoved, rowId, rowField] = match;
  if (dateField) return { stayId, rowId: null, field: dateField as 'arrival' | 'departure' };
  if (stayTotal) return { stayId, rowId: null, field: stayTotal as 'totalAdults' | 'totalChildren' };
  if (stayRemoved) return { stayId, rowId: null, field: 'removed' };
  return { stayId, rowId: rowId ?? '', field: rowField as RowField | 'removed' };
}

/** Nested `state.stays[stayId]` holds the last HMS commit for that stay. Field-path keys stay siblings. */
export const STAY_COMMITS_KEY = 'stays';
export const PANE_STAY_ALREADY_BOOKED = 'pane_stay_already_booked';
const STAY_ID_PATTERN = new RegExp(`^${ID}$`);
const STAY_COMMIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const STAY_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAY_SHOT_NAME = /^[a-z][a-z0-9-]{0,40}\.png$/;
const STAY_SHOT_SHA256 = /^[a-f0-9]{64}$/;
const STAY_SHOT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type StayCommitStatus = 'booked' | 'unknown';
export type StayCommitScreenshotRef = { runId: string; name: string };
export type StayCommitShot = { name: string; sha256: string; at: string };
export type StayCommitRecord = {
  confirmationNumber: string | null;
  status: StayCommitStatus;
  screenshotRef: StayCommitScreenshotRef | null;
  runId?: string;
  shots?: StayCommitShot[];
  cmsReason?: 'saved_cms_mismatch';
  cmsMismatches?: Array<{ field: string; expected: unknown; actual: unknown }>;
  /** Read-only projection; the server's dispatch and approval checks remain authoritative. */
  cloudCreateHold?: CloudCreateHoldProjection;
  cloudCreateTarget?: CloudCreateHoldProjection['target'];
};
type StayCommitWriteRecord = Omit<StayCommitRecord, 'cloudCreateTarget'> & {
  /** Hold targets remain opaque in stored state; readers schema-validate before projecting them. */
  cloudCreateTarget?: unknown;
};
export type StayCommitGuard =
  | { action: 'commit' }
  | { action: 'refuse'; reason: typeof PANE_STAY_ALREADY_BOOKED }
  | { action: 'read_hms' };

function parseStayCommit(value: unknown): StayCommitRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status === 'booked' || row.status === 'unknown' ? row.status : null;
  if (!status) return null;
  const confirmation =
    typeof row.confirmationNumber === 'string' && row.confirmationNumber.trim()
      ? row.confirmationNumber.trim()
      : null;
  const shot = row.screenshotRef;
  let screenshotRef: StayCommitScreenshotRef | null = null;
  if (shot && typeof shot === 'object' && !Array.isArray(shot)) {
    const ref = shot as Record<string, unknown>;
    if (
      typeof ref.runId === 'string' &&
      STAY_RUN_ID.test(ref.runId) &&
      typeof ref.name === 'string' &&
      STAY_SHOT_NAME.test(ref.name)
    ) {
      screenshotRef = { runId: ref.runId, name: ref.name };
    }
  }
  const runId =
    typeof row.runId === 'string' && STAY_RUN_ID.test(row.runId) ? row.runId : undefined;
  const shots = parseStayCommitShots(row.shots);
  const cmsReason = row.cmsReason === 'saved_cms_mismatch' ? row.cmsReason : undefined;
  const cmsMismatches = parseCmsMismatches(row.cmsMismatches);
  return {
    confirmationNumber: confirmation,
    status,
    screenshotRef,
    ...(runId ? { runId } : {}),
    ...(shots ? { shots } : {}),
    ...(cmsReason ? { cmsReason, ...(cmsMismatches ? { cmsMismatches } : {}) } : {}),
  };
}

function parseCmsMismatches(value: unknown): StayCommitRecord['cmsMismatches'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.field !== 'string' || !['udfchar09', 'udfchar13', 'send'].includes(row.field)) return [];
    const scalar = (v: unknown) => v === null || typeof v === 'string' || typeof v === 'boolean';
    if (!scalar(row.expected) || !scalar(row.actual)) return [];
    return [{ field: row.field, expected: row.expected, actual: row.actual }];
  });
}

function parseStayCommitShots(value: unknown): StayCommitShot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const shots: StayCommitShot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.name === 'string' &&
      STAY_SHOT_NAME.test(row.name) &&
      typeof row.sha256 === 'string' &&
      STAY_SHOT_SHA256.test(row.sha256) &&
      typeof row.at === 'string' &&
      STAY_SHOT_AT.test(row.at)
    ) {
      shots.push({ name: row.name, sha256: row.sha256, at: row.at });
    }
  }
  return shots.length > 0 ? shots : undefined;
}

export function stayCommitsOf(state: WorkState): Record<string, StayCommitRecord> {
  const raw = state[STAY_COMMITS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StayCommitRecord> = {};
  for (const [stayId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAY_COMMIT_ID_PATTERN.test(stayId)) continue;
    const parsed = parseStayCommit(value);
    if (parsed) out[stayId] = parsed;
  }
  return out;
}

/** Project held Create identities only for pane reads; never write the projection back to state. */
export async function paneStayCommitsOf(state: WorkState): Promise<Record<string, StayCommitRecord>> {
  const commits = stayCommitsOf(state);
  const rows = state[STAY_COMMITS_KEY];
  const recovered = rows && typeof rows === 'object' && !Array.isArray(rows) &&
    Object.values(rows).some((row) => row && typeof row === 'object' && !Array.isArray(row) &&
      ((row as Record<string, unknown>).cloudCreateRecovered === true ||
        (row as Record<string, unknown>).cloudCreateVerified === true));
  if (state.cloudCreateBatchHolds === undefined && !recovered &&
      !Object.values(commits).some((commit) => commit.status === 'unknown')) return commits;
  // Load after work-items has initialized (Create imports its scope helpers).
  const { cloudCreateHoldOf, cloudCreateBookedTargetOf } = await import('./pane-cloud-preview.js');
  for (const [stayId, commit] of Object.entries(commits)) {
    const hold = cloudCreateHoldOf(state, stayId);
    const target = cloudCreateBookedTargetOf(state, stayId);
    if (hold || target) commits[stayId] = { ...commit, ...(hold ? { cloudCreateHold: hold } : {}),
      ...(target ? { cloudCreateTarget: target } : {}) };
  }
  return commits;
}

export function stayCommitOf(state: WorkState, stayId: string): StayCommitRecord | undefined {
  return stayCommitsOf(state)[stayId];
}

export function withStayCommit(state: WorkState, stayId: string, record: StayCommitWriteRecord): WorkState {
  const raw = state[STAY_COMMITS_KEY];
  const rows = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  // Validate the visible entries but retain their server-owned evidence when another stay changes.
  const siblings = Object.fromEntries(Object.keys(stayCommitsOf(state)).map((id) => [id, rows[id]]));
  const previous = rows[stayId];
  const evidence = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown> : {};
  const held = evidence.status === 'unknown' || evidence.cloudCreateVerified === true;
  return { ...state, [STAY_COMMITS_KEY]: { ...siblings, [stayId]: { ...record,
    ...(held && Object.hasOwn(evidence, 'cloudCreateTarget') ? { cloudCreateTarget: evidence.cloudCreateTarget } : {}),
    ...(held && Object.hasOwn(evidence, 'cloudCreateGrantId') ? { cloudCreateGrantId: evidence.cloudCreateGrantId } : {}),
    ...(evidence.cloudCreateVerified === true ? { cloudCreateVerified: true } : {}),
    ...(evidence.cloudCreateRecovered === true ? { cloudCreateRecovered: true } : {}),
    ...(Object.hasOwn(evidence, 'cloudCreateRecoveredBatchId') ? { cloudCreateRecoveredBatchId: evidence.cloudCreateRecoveredBatchId } : {}),
  } } };
}

export function stayCommitGuard(record: StayCommitRecord | undefined): StayCommitGuard {
  if (record?.confirmationNumber) return { action: 'refuse', reason: PANE_STAY_ALREADY_BOOKED };
  if (record?.status === 'unknown') return { action: 'read_hms' };
  return { action: 'commit' };
}

export type SavedStayPick = {
  stayId: string;
  confirmationNumber: string;
  status: StayCommitStatus;
};

/** Stays that already have an HMS confirmation. Amend/cancel picks from this list. */
export function savedStayPicksOf(state: WorkState): SavedStayPick[] {
  const picks: SavedStayPick[] = [];
  for (const [stayId, record] of Object.entries(stayCommitsOf(state))) {
    if (!record.confirmationNumber) continue;
    picks.push({
      stayId,
      confirmationNumber: record.confirmationNumber,
      status: record.status,
    });
  }
  return picks;
}

/** Named stay, the only saved confirmation, or null until staff choose among several. */
export function pickSavedStay(
  picks: readonly SavedStayPick[],
  stayId: string | null | undefined,
): SavedStayPick | null {
  if (picks.length === 0) return null;
  if (stayId) return picks.find((pick) => pick.stayId === stayId) ?? null;
  return picks.length === 1 ? picks[0]! : null;
}

/** Writes an amend/cancel outcome onto one stay. Other stays are left as they are. */
export function withStayActionResult(
  state: WorkState,
  stayId: string,
  result: {
    confirmationNumber: string;
    screenshotRef: StayCommitScreenshotRef | null;
  },
): WorkState {
  if (!STAY_COMMIT_ID_PATTERN.test(stayId)) return state;
  const existing = stayCommitOf(state, stayId);
  const stays = state[STAY_COMMITS_KEY];
  const raw = stays && typeof stays === 'object' && !Array.isArray(stays)
    ? (stays as Record<string, unknown>)[stayId] : null;
  const held: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) &&
    (existing?.status === 'unknown' || (raw as Record<string, unknown>).cloudCreateRecovered === true)
    ? raw as Record<string, unknown> : {};
  return withStayCommit(state, stayId, {
    confirmationNumber: result.confirmationNumber,
    status: existing?.status ?? 'booked',
    screenshotRef: result.screenshotRef,
    ...(existing?.runId ? { runId: existing.runId } : {}),
    ...(existing?.shots ? { shots: existing.shots } : {}),
    ...(existing?.cmsReason ? { cmsReason: existing.cmsReason, cmsMismatches: existing.cmsMismatches } : {}),
    ...(Object.hasOwn(held, 'cloudCreateTarget') ? { cloudCreateTarget: held.cloudCreateTarget } : {}),
    ...(Object.hasOwn(held, 'cloudCreateGrantId') ? { cloudCreateGrantId: held.cloudCreateGrantId } : {}),
    ...(held.cloudCreateRecovered === true ? { cloudCreateRecovered: true } : {}),
  });
}

function screenshotRefFromPane(result: {
  runId?: string;
  screenshots?: string[];
}): StayCommitScreenshotRef | null {
  const runId = result.runId;
  if (!runId || !STAY_RUN_ID.test(runId)) return null;
  const names = result.screenshots ?? [];
  const name = names.includes('saved.png') ? 'saved.png' : names.at(-1);
  return name && STAY_SHOT_NAME.test(name) ? { runId, name } : null;
}

/** Maps a pane commit/preview result onto a stay record. Unverified or unconfirmed saves are unknown. */
export function stayCommitFromPaneResult(result: {
  status: string;
  reason?: string;
  outcome?: string;
  confirmationNumber?: string;
  runId?: string;
  screenshots?: string[];
  shots?: StayCommitShot[];
  cmsReason?: 'saved_cms_mismatch';
  cmsMismatches?: Array<{ field: string; expected: unknown; actual: unknown }>;
}): StayCommitRecord | null {
  const screenshotRef = screenshotRefFromPane(result);
  const confirmationNumber =
    typeof result.confirmationNumber === 'string' && result.confirmationNumber.trim()
      ? result.confirmationNumber.trim()
      : null;
  const runId =
    typeof result.runId === 'string' && STAY_RUN_ID.test(result.runId) ? result.runId : undefined;
  const shots = parseStayCommitShots(result.shots);
  const cmsReason = result.cmsReason === 'saved_cms_mismatch' ? result.cmsReason : undefined;
  const cmsMismatches = parseCmsMismatches(result.cmsMismatches);
  const extras = {
    ...(cmsReason ? { cmsReason, ...(cmsMismatches ? { cmsMismatches } : {}) } : {}),
    ...(runId ? { runId } : {}),
    ...(shots ? { shots } : {}),
  };
  if (result.status === 'ok' && confirmationNumber) {
    return {
      confirmationNumber,
      status: result.outcome === 'committed_unverified' ? 'unknown' : 'booked',
      screenshotRef,
      ...extras,
    };
  }
  if (result.reason === 'pane_save_unconfirmed' || result.outcome === 'committed_unverified') {
    return { confirmationNumber, status: 'unknown', screenshotRef, ...extras };
  }
  return null;
}

function stayIdFromCommitKey(key: string): string {
  return key.replace(/_\d+$/, '');
}

/**
 * The contact block's fields (U16). Paths are `contact.<field>`.
 */
export const CONTACT_FIELDS = ['name', 'bookingAgency', 'organization', 'email', 'phone'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
export type StoredContact = Record<ContactField, string | null>;
const CONTACT_PATH = new RegExp(`^contact\\.(${CONTACT_FIELDS.join('|')})$`);

export function contactFieldOf(path: string): ContactField | null {
  const match = CONTACT_PATH.exec(path);
  return match ? (match[1] as ContactField) : null;
}

function contactAiValue(payload: MailExtractionPayload | null | undefined, field: ContactField): string | null {
  if (!payload) return null;
  switch (field) {
    case 'name':
      return payload.contact.name;
    case 'bookingAgency':
      return payload.bookingAgency;
    case 'organization':
      return payload.organization;
    case 'email':
      return payload.contact.email;
    case 'phone':
      return payload.contact.phone;
  }
}

/** A contact value is text up to the extraction's cap, or null to clear it. */
function validContactValue(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 200);
}

/** The contact block's values: her value where she has set one, else the read's. */
export function storedContact(payload: MailExtractionPayload, state: WorkState): StoredContact {
  const valueOf = (field: ContactField): string | null => {
    const key = `contact.${field}`;
    return Object.hasOwn(state, key) ? (state[key] as string | null) : contactAiValue(payload, field);
  };
  return {
    name: valueOf('name'),
    bookingAgency: valueOf('bookingAgency'),
    organization: valueOf('organization'),
    email: valueOf('email'),
    phone: valueOf('phone'),
  };
}

function isInt(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether a person's value fits the field. Null is always allowed (cleared). */
export function validFieldValue(field: FieldPath['field'], value: unknown): boolean {
  if (value === null) return true;
  switch (field) {
    case 'arrival':
    case 'departure':
      return typeof value === 'string' && validIsoDate(value) !== undefined;
    case 'count':
      return isInt(value, 1, 999);
    case 'adults':
      return isInt(value, 1, 9);
    case 'totalAdults':
    case 'totalChildren':
      return isInt(value, 0, 999);
    case 'roomType':
      return typeof value === 'string' && value.length > 0 && value.length <= 120;
    case 'childAges':
      return Array.isArray(value) && value.length <= 9 && value.every((age) => isInt(age, 0, 17));
    case 'mealPlan':
      return typeof value === 'string' && BOARDS.has(value);
    case 'removed':
      return value === true;
  }
}

/**
 * The extraction's value at a path, found by stable id. Null when the read has no such id (a user-made stay or row).
 * The extraction never removes, so `removed` on a stay or row it has reads false.
 */
export function aiValueAt(payload: MailExtractionPayload | null | undefined, path: string): unknown {
  const contact = contactFieldOf(path);
  if (contact) return contactAiValue(payload, contact);
  const parsed = parseFieldPath(path);
  const stay = parsed ? payload?.stays.find((item) => item.id === parsed.stayId) : undefined;
  if (!parsed || !stay) return null;
  if (parsed.rowId === null) {
    if (parsed.field === 'removed') return false;
    if (parsed.field === 'totalAdults' || parsed.field === 'totalChildren') return stay[parsed.field] ?? null;
    return stay.requested[parsed.field];
  }
  const row = stay.rows.find((item) => item.id === parsed.rowId);
  if (!row) return null;
  return parsed.field === 'removed' ? false : row[ROW_KEYS[parsed.field]];
}

type FormStay = Pick<ExtractionStay, 'id' | 'requested' | 'rows' | 'totalRooms' | 'totalAdults' | 'totalChildren'>;

/**
 * The stays and rows the form shows: the extraction's, then any the person added (ids only in `state`), less any she
 * removed. Added ones start empty; their values come from `state` like every other field.
 */
export function formStays(payload: MailExtractionPayload, state: WorkState): FormStay[] {
  const stays: FormStay[] = payload.stays.map((stay) => ({ ...stay, rows: [...stay.rows] }));
  const removed = new Set<string>();
  for (const key of Object.keys(state)) {
    const path = parseFieldPath(key);
    if (!path) continue;
    let stay = stays.find((item) => item.id === path.stayId);
    if (!stay) {
      stay = { id: path.stayId, requested: { arrival: null, departure: null }, totalRooms: null, rows: [] };
      stays.push(stay);
    }
    if (path.rowId !== null && !stay.rows.some((row) => row.id === path.rowId)) {
      stay.rows.push({ id: path.rowId, roomType: null, rooms: null, adultsPerRoom: null, childAges: null, mealPlan: null });
    }
    if (path.field === 'removed' && state[key] === true) removed.add(path.rowId ?? path.stayId);
  }
  return stays.flatMap((stay) => {
    if (removed.has(stay.id)) return [];
    const rows = stay.rows.filter((row) => !removed.has(row.id));
    // A stay whose every row she removed is gone too.
    if (stay.rows.length > 0 && rows.length === 0) return [];
    const projectedRows = rows.map((row) => {
      const countPath = `stays[${stay.id}].rows[${row.id}].count`;
      if (
        rows.length === 1 &&
        row.rooms === null &&
        stay.totalRooms !== null &&
        !Object.hasOwn(state, countPath)
      ) {
        return { ...row, rooms: stay.totalRooms };
      }
      return row;
    });
    const totalAdultsPath = `stays[${stay.id}].totalAdults`;
    const totalAdults = Object.hasOwn(state, totalAdultsPath)
      ? (state[totalAdultsPath] as number | null)
      : stay.totalAdults;
    const totalChildrenPath = `stays[${stay.id}].totalChildren`;
    const totalChildren = Object.hasOwn(state, totalChildrenPath)
      ? (state[totalChildrenPath] as number | null)
      : stay.totalChildren;
    return [{ ...stay, totalAdults, totalChildren, rows: projectedRows }];
  });
}

/** Include staff-added stays and rows in the source-bound draft without losing removed source identities. */
export function requestPayload(payload: MailExtractionPayload, state: WorkState, kind: string): MailExtractionPayload {
  const stays = payload.stays.map((stay) => ({ ...stay, rows: [...stay.rows] }));
  const sourceAction = payload.stays.length === 1
    ? payload.stays[0]?.action ?? payload.action ?? (kind === 'booking' ? 'new_booking' : kind === 'quote' ? 'quote_availability' : null)
    : null;
  for (const form of formStays(payload, state)) {
    let stay = stays.find((candidate) => candidate.id === form.id);
    if (!stay) {
      if (sourceAction !== 'new_booking' && sourceAction !== 'quote_availability') continue;
      stay = { ...form, hotel: null, booked: null, action: sourceAction };
      stays.push(stay);
    }
    for (const row of form.rows) if (!stay.rows.some((candidate) => candidate.id === row.id)) stay.rows.push(row);
  }
  return { ...payload, stays };
}

const WORKFLOW_BY_KIND: Partial<Record<MailKind, LunaAnalysis['workflow']>> = {
  quote: 'quote',
  booking: 'create_booking',
  amendment: 'amend',
  cancellation: 'cancel',
};

// voucher_pop covers agency vouchers as well as payments. Only payment cues in the subject, the start of the body
// or a file name make it payment_ack; a voucher alone stays other.
const PAYMENT_WORDS = /\bremittance\b|proof of payment|\bpayment (?:advice|confirmation|notification)\b/i;
const POP_CAPS = /\bPOP\b/;
const VOUCHER_WORD = /\bvouchers?\b/i;
const NOT_SETTLED = /\bnon[-\s]?guaranteed\b|\bprovisional\b/i;

const ASK_FOR_PAYMENT =
  /\b(?:please|kindly)\s+(?:send|provide|attach|forward)\b[\s\S]{0,40}\b(?:proof of payment|POP|voucher|remittance)\b/i;
const GUARANTEED_STATE = /\bis guaranteed\b|\bguaranteed reservation\b/i;

/** Paid, voucher, or guaranteed evidence. A request for payment proof is not settled. */
export function mailLooksPaidVoucherOrGuaranteed(text: string | null | undefined): boolean {
  if (!text) return false;
  const plain = text.replace(/<[^>]+>/g, ' ');
  if (ASK_FOR_PAYMENT.test(plain)) return false;
  if (PAYMENT_WORDS.test(plain) || POP_CAPS.test(plain) || VOUCHER_WORD.test(plain)) return true;
  if (NOT_SETTLED.test(plain)) return false;
  return GUARANTEED_STATE.test(plain);
}

function storedWorkflow(read: StoredRead): LunaAnalysis['workflow'] {
  if (read.kind !== 'voucher_pop') return WORKFLOW_BY_KIND[read.kind] ?? 'other';
  const text = [
    read.subject ?? '',
    (read.bodyText ?? '').slice(0, 2000),
    ...(read.attachments ?? []).map((item) => item.filename ?? ''),
  ].join('\n');
  return PAYMENT_WORDS.test(text) || POP_CAPS.test(text) ? 'payment_ack' : 'other';
}

function workflowForStoredRead(read: StoredRead): LunaAnalysis['workflow'] {
  const classifier = read.classifier;
  if (classifier && shouldAttachWorkflowHint(classifier.confidence)) {
    const agent = COARSE_TO_AGENT[classifier.workflow];
    return agent === 'create' ? 'create_booking' : agent;
  }
  return storedWorkflow(read);
}

const FAILURE_COPY: Record<string, string> = {
  timeout: 'Nava ran out of time reading this email.',
  invalid_output: 'Nava read this email but could not use the result.',
  not_found: 'Nava could not load this email to read it.',
  no_message_id: 'This email has no Message-ID, so Nava cannot read it.',
};

export type StoredRead = {
  kind: MailKind;
  payload: MailExtractionPayload;
  attachments: AttachmentRead[] | null;
  fromAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  classifier?: ClassifierResult | null;
};
/** Where one pane group's values live: its stay, and its row when it has one. */
export type GroupRef = { stayId: string; rowId: string | null };

function trimmedConfirmation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stayGuestConfirmations(stay: ExtractionStay | undefined): string[] {
  if (!stay?.guests) return [];
  return stay.guests.flatMap((guest) => {
    const confirmation = trimmedConfirmation(guest.confirmationNumber);
    return confirmation ? [confirmation] : [];
  });
}

/** Guest confs first, then top-level. Cards keep every conf; prefetch uses the first. */
function payloadConfirmationNumbers(payload: MailExtractionPayload): string[] {
  const fromGuests = payload.stays.flatMap((stay) => stayGuestConfirmations(stay));
  const fromTop = payload.confirmationNumbers.flatMap((value) => {
    const confirmation = trimmedConfirmation(value);
    return confirmation ? [confirmation] : [];
  });
  return [...new Set([...fromGuests, ...fromTop])];
}

function confirmationForStay(stay: ExtractionStay | undefined, payload: MailExtractionPayload): string | null {
  return stayGuestConfirmations(stay)[0] ?? trimmedConfirmation(payload.confirmationNumbers[0] ?? null);
}

function guestNamesForStay(stay: ExtractionStay | undefined): string[] {
  return (stay?.guests ?? []).map((guest) => guest.name).filter((name) => name.trim().length > 0);
}

function stayOwningConfirmation(
  payload: MailExtractionPayload,
  confirmation: string | null,
): ExtractionStay | undefined {
  if (!confirmation) return undefined;
  return payload.stays.find((stay) => stayGuestConfirmations(stay).includes(confirmation));
}

/**
 * The pane's analysis for a stored read, built by the same mapping a live Luna read uses (mapLlmDecision, the
 * amendment fields, the review items). No model call. A value a person set in `state` wins over the extraction.
 * A group's id is its row id, or its stay id for a stay with dates and no rows.
 */
export function storedAnalysis(
  read: StoredRead,
  state: WorkState,
  threadConfirmation?: ThreadConfirmationResolution,
  propertyCode?: string,
) {
  const { kind, payload } = read;
  const pick = <T>(path: string, fallback: T): T =>
    Object.hasOwn(state, path) ? (state[path] as T) : fallback;
  const failures = documentFailureItems(
    (read.attachments ?? [])
      .filter((item) => item.status === 'not_read')
      .map((item) => ({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        bytesPresent: false,
        readFailure: item.reason,
      })),
    'text',
  );
  const numberReviews = numberGroupReviewItems(
    (read.attachments ?? [])
      .filter((item) => item.status === 'read' && item.reviewReason !== undefined)
      .map((item) => ({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        reviewReason: item.reviewReason,
      })),
  );
  const flags: LunaAnalysis['flags'] = [];
  if (failures.length) flags.push('attachment_unread');
  const hasChildAgeWarning = payload.missing.some((item) => /child/i.test(`${item.field} ${item.question}`));
  const stays = formStays(payload, state);
  const totalRoomsDefaultRowIds = new Set(
    stays.flatMap((stay) => {
      if (stay.rows.length !== 1 || stay.totalRooms === null) return [];
      const row = stay.rows[0]!;
      const sourceRow = payload.stays.find((item) => item.id === stay.id)?.rows.find((item) => item.id === row.id);
      const countPath = `stays[${stay.id}].rows[${row.id}].count`;
      const countWasDefaulted = sourceRow ? sourceRow.rooms === null : row.rooms === stay.totalRooms;
      return countWasDefaulted && !Object.hasOwn(state, countPath) ? [row.id] : [];
    }),
  );
  const requestedRoomsByStay = Object.fromEntries(
    stays.flatMap((stay) => {
      return stay.totalRooms !== null ? [[stay.id, stay.totalRooms]] : [];
    }),
  );
  const roomTotalByStay = new Map(stays.map((stay) => {
    const counts = stay.rows.map((row) => pick(`stays[${stay.id}].rows[${row.id}].count`, row.rooms));
    const staffReconciled = counts.every((count) => isInt(count, 1, 999)) && stay.rows.some((row) =>
      Object.hasOwn(state, `stays[${stay.id}].rows[${row.id}].count`),
    );
    return [stay.id, staffReconciled ? counts.reduce<number>((sum, count) => sum + Number(count), 0) : stay.totalRooms] as const;
  }));
  const roomTotalNeedsReview = new Set(stays.flatMap((stay) => {
    const clearedCount = stay.rows.some((row) => {
      const path = `stays[${stay.id}].rows[${row.id}].count`;
      return Object.hasOwn(state, path) && state[path] === null;
    });
    if (stay.totalRooms === null && stay.rows.length <= 1 && !clearedCount) return [];
    const counts = stay.rows.map((row) => pick(`stays[${stay.id}].rows[${row.id}].count`, row.rooms));
    const totalWasReconciledByStaff = roomTotalByStay.get(stay.id) !== stay.totalRooms;
    return counts.some((count) => !isInt(count, 1, 999)) || (!totalWasReconciledByStaff && stay.totalRooms !== null && counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) !== stay.totalRooms) ? [stay.id] : [];
  }));
  const dateKeys = new Set(
    stays.map((stay) => {
      const arrival = pick(`stays[${stay.id}].requested.arrival`, stay.requested.arrival);
      const departure = pick(`stays[${stay.id}].requested.departure`, stay.requested.departure);
      return `${arrival ?? ''}\0${departure ?? ''}`;
    }),
  );
  if (dateKeys.size > 1) flags.push('multi_date');
  if (kind === 'amendment' || kind === 'cancellation') flags.push('amendment_or_cancel');

  const order: Array<GroupRef & { groupId: string }> = [];
  const groups: Array<LunaAnalysis['groups'][number] & { stayId?: string }> = [];
  for (const stay of stays) {
    const sourceStay = payload.stays.find((item) => item.id === stay.id);
    const guestNames = guestNamesForStay(sourceStay);
    const dates = {
      arrival: pick(`stays[${stay.id}].requested.arrival`, stay.requested.arrival),
      departure: pick(`stays[${stay.id}].requested.departure`, stay.requested.departure),
    };
    if (stay.rows.length === 0) {
      order.push({ groupId: stay.id, stayId: stay.id, rowId: null });
      groups.push({
        ...dates,
        dateEvidence: null,
        rooms: null,
        ...(stay.totalAdults !== undefined ? { adultsTotal: stay.totalAdults } : {}),
        adultsPerRoom: null,
        ...(stay.totalChildren !== undefined ? { childrenTotal: stay.totalChildren } : {}),
        childAges: null,
        mealPlan: null,
        roomPreference: null,
        guestNames,
        stayId: stay.id,
      });
      continue;
    }
    let guestAt = 0;
    for (const row of stay.rows) {
      const at = (field: RowField) => `stays[${stay.id}].rows[${row.id}].${field}`;
      const rooms = pick(at('count'), row.rooms);
      const take = typeof rooms === 'number' && rooms > 0 ? rooms : 1;
      const rowNames = guestNames.slice(guestAt, guestAt + take);
      guestAt += take;
      order.push({ groupId: row.id, stayId: stay.id, rowId: row.id });
      const childAgesPath = at('childAges');
      const childAges = pick<number[] | null>(childAgesPath, row.childAges);
      const totalChildrenPath = `stays[${stay.id}].totalChildren`;
      const totalChildren = Object.hasOwn(state, totalChildrenPath) ? state[totalChildrenPath] : sourceStay?.totalChildren;
      const unresolvedLegacyEmptyAges = Boolean(
        hasChildAgeWarning && sourceStay && sourceStay.totalChildren == null &&
        typeof totalChildren !== 'number' && childAges?.length === 0 && !Object.hasOwn(state, childAgesPath),
      );
      groups.push({
        ...dates,
        dateEvidence: null,
        rooms,
        ...(stay.totalAdults !== undefined ? { adultsTotal: stay.totalAdults } : {}),
        adultsPerRoom: pick(at('adults'), row.adultsPerRoom),
        ...(stay.totalChildren !== undefined ? { childrenTotal: stay.totalChildren } : {}),
        childAges: unresolvedLegacyEmptyAges ? null : childAges,
        mealPlan: pick(at('mealPlan'), row.mealPlan),
        roomPreference: pick(at('roomType'), row.roomType),
        guestNames: rowNames,
        stayId: stay.id,
      });
    }
  }
  const selectedConfirmation = payloadConfirmationNumbers(payload)[0] ?? null;
  const overlaid = overlayHmsConfirmation(selectedConfirmation, threadConfirmation);
  const bookedStay = stayOwningConfirmation(payload, overlaid.confirmation) ?? payload.stays[0];
  const booked = bookedStay?.booked;
  const requested = bookedStay?.requested;
  const luna: LunaAnalysis = {
    workflow: workflowForStoredRead(read),
    flags,
    groups,
    party: {
      kind: payload.bookingAgency ? 'bookingAgency' : payload.organization ? 'organization' : null,
      name: payload.bookingAgency ?? payload.organization,
      reference: null,
    },
    rateClaims: [],
    missing: overlaid.reason
      ? [...payload.missing, { field: 'confirmationNumber', question: overlaid.reason }]
      : payload.missing,
    evidence: [],
    tasks: [],
    confirmationNumber: overlaid.confirmation,
    guestLastName: null,
    // The booking as it stands comes from the booked dates only. A missing booked date stays null: the requested
    // stay never stands in for it, so the HMS lookup cannot match on the wrong day (AE2).
    arrival: validIsoDate(booked?.arrival ?? null) ?? null,
    departure: validIsoDate(booked?.departure ?? null) ?? null,
    requestedArrival: validIsoDate(requested?.arrival ?? null) ?? null,
    requestedDeparture: validIsoDate(requested?.departure ?? null) ?? null,
    requestedChange: null,
  };
  const everyRowKnown = (field: 'adults' | 'childAges') =>
    order.length > 0 && order.every((slot, index) => {
      if (!slot.rowId) return false;
      const group = groups[index];
      return field === 'adults'
        ? typeof group?.adultsPerRoom === 'number'
        : Array.isArray(group?.childAges);
    });
  const adultsResolved = everyRowKnown('adults');
  const childAgesResolved = everyRowKnown('childAges');
  if (stays.length > 1) {
    luna.missing = luna.missing.filter((item) =>
      !/child/i.test(`${item.field} ${item.question}`) ||
      Boolean((item as typeof item & { stayId?: string }).stayId),
    );
  }
  if (adultsResolved || childAgesResolved) {
    luna.missing = luna.missing.filter((item) => {
      const field = `${item.field} ${item.question}`;
      return Boolean((item as typeof item & { stayId?: string }).stayId) || !(
        (childAgesResolved && /child/i.test(field)) ||
        (adultsResolved && /adult|occupancy/i.test(field) && !/total/i.test(item.field))
      );
    });
  }
  const mapped = mapLlmDecision(luna, {
    channel: aopQuoteChannelFromSender({
      fromAddress: read.fromAddress,
      subject: read.subject,
      bodyText: read.bodyText,
    }),
    ...(propertyCode ? { propertyCode } : {}),
  });
  mapped.groups.forEach((group, index) => {
    const slot = order[index];
    if (!slot) return;
    group.id = slot.groupId;
    if (slot.rowId && roomTotalNeedsReview.has(slot.stayId)) {
      const row = stays.find((stay) => stay.id === slot.stayId)?.rows.find((item) => item.id === slot.rowId);
      group.fields.quantity = 'missing';
      if (row && pick(`stays[${slot.stayId}].rows[${row.id}].count`, row.rooms) == null) delete group.quantity;
    }
    if (slot.rowId && totalRoomsDefaultRowIds.has(slot.rowId)) group.fields.quantity = 'defaulted';
    const stayPath = `stays[${slot.stayId}].requested`;
    const corrected: Array<[string, string]> = [
      ['arrivalDate', `${stayPath}.arrival`],
      ['departureDate', `${stayPath}.departure`],
      ['adultsTotal', `stays[${slot.stayId}].totalAdults`],
      ['childrenTotal', `stays[${slot.stayId}].totalChildren`],
    ];
    if (slot.rowId) {
      const rowPath = `stays[${slot.stayId}].rows[${slot.rowId}]`;
      corrected.push(
        ['quantity', `${rowPath}.count`],
        ['adults', `${rowPath}.adults`],
        ['childAges', `${rowPath}.childAges`],
        ['mealPlan', `${rowPath}.mealPlan`],
      );
      // "Not stated yet" saves null. Mapping fills a null board with the default, so her cleared choice is put back.
      if (Object.hasOwn(state, `${rowPath}.mealPlan`) && state[`${rowPath}.mealPlan`] === null) group.mealPlan = 'unknown';
    }
    for (const [key, path] of corrected) {
      if (!Object.hasOwn(state, path) || (key === 'quantity' && state[path] === null) || (key === 'childAges' && !Array.isArray(state[path])) || (key === 'adults' && typeof state[path] !== 'number')) continue;
      group.fields[key] = 'staff_corrected';
    }
  });
  const childAgesUnresolved = mapped.groups.some((group) => group.fields.childAges === 'missing');
  const mappedMissing = mapped.missing.filter((item) => childAgesUnresolved || !/child/i.test(item.field));
  const missingQuoteReplyFields = mapped.missingQuoteReplyFields.filter(
    (field) => childAgesUnresolved || !/child/i.test(field),
  );
  const refs: Record<string, GroupRef> = Object.fromEntries(
    order.map((slot) => [slot.groupId, { stayId: slot.stayId, rowId: slot.rowId }]),
  );
  return {
    analysis: {
      intent: mapped.intent,
      // Each group names its stay, so the pane groups rows by the read's stays and logs edits to the stay's id.
      groups: mapped.groups.map((group, index) => {
        const roomType = matchRoomType(group.roomPreference, propertyCode);
        const stayId = order[index]?.stayId;
        const sourceStay = stayId ? payload.stays.find((item) => item.id === stayId) : undefined;
        const confirmationNumber = confirmationForStay(sourceStay, payload);
        return {
          ...group,
          ...(stayId && roomTotalByStay.get(stayId) != null ? { roomsTotal: roomTotalByStay.get(stayId)! } : {}),
          ...(roomType.code ? { roomTypeCode: roomType.code } : {}),
          roomTypeSuggestions: roomType.suggestions,
          stayId,
          ...(confirmationNumber ? { confirmationNumber } : {}),
        };
      }),
      missingQuoteReplyFields,
      secondaryAsks: mapped.secondaryAsks,
      alternatives: mapped.alternatives,
      reviewItems: [...failures, ...numberReviews, ...questionItems(mappedMissing)],
      requestedRoomsByStay,
      source: 'luna' as const,
      aiUnavailable: false as const,
      luna,
      amendment: amendmentFromAnalysis(luna),
      ratePlan: mapped.ratePlan,
      delivery: mapped.delivery,
    },
    refs,
  };
}

export type StoredAnalysis = Omit<ReturnType<typeof storedAnalysis>['analysis'], 'source' | 'aiUnavailable'> &
  { source: 'luna' | 'staff_manual'; aiUnavailable: boolean };

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export type WorkItemRef = { id: string; status: string; state: WorkState; extractionId: string | null };
/** Revision and extraction link belong to the same row read as the displayed saved state. */
type WorkItemSnapshot = WorkItemRef & { revision: number; revisionHead: number; revisionSeq: number };

function contentKeepsId<T extends { id: string }>(
  id: string,
  before: T[],
  after: T[],
  keyOf: (item: T, among: T[]) => string | null,
): boolean {
  const was = before.find((item) => item.id === id);
  if (!was) return true; // staff-added stay: id is hers
  if (!after.some((item) => item.id === id)) return false; // extraction stay vanished
  const key = keyOf(was, before);
  if (!key) return true;
  const hits = after.filter((item) => keyOf(item, after) === key);
  return hits.length === 1 && hits[0]!.id === id;
}

/**
 * Whether her saved stay and row values still land on the same stays and rows in the next read. When a read drops or
 * reorders entries they would land on another stay, so the work item stays on the read she corrected. Ids must already
 * match the unique content key — this never rewrites `state` paths.
 */
export function correctionsCarryTo(
  before: MailExtractionPayload,
  after: MailExtractionPayload,
  state: WorkState,
): boolean {
  if (before.stays === after.stays) return true;
  // Request ids incorporate the extraction stay id. Never carry a person's
  // request edits onto an independently re-extracted, different stay.
  if (Object.keys(state).some((key) => parseRequestField(key)) &&
      (before.stays.length !== after.stays.length ||
        before.stays.some((stay) => !after.stays.some((next) => next.id === stay.id)))) return false;
  for (const key of Object.keys(state)) {
    const path = parseFieldPath(key);
    if (!path) continue;
    if (!contentKeepsId(path.stayId, before.stays, after.stays, stayContentKey)) return false;
    if (path.rowId === null) continue;
    const rowsBefore = before.stays.find((stay) => stay.id === path.stayId)?.rows ?? [];
    const rowsAfter = after.stays.find((stay) => stay.id === path.stayId)?.rows ?? [];
    if (!contentKeepsId(path.rowId, rowsBefore, rowsAfter, rowContentKey)) return false;
  }
  for (const key of Object.keys(stayCommitsOf(state))) {
    if (!contentKeepsId(stayIdFromCommitKey(key), before.stays, after.stays, stayContentKey)) return false;
  }
  return true;
}

/**
 * Whether the item moves from its read to `nextId`. Never to an older read (a slow caller can hold an old one), and
 * never when her saved values would land on other stays or rows in the next read.
 */
async function shouldRelink(db: WorkTx, fromId: string | null, nextId: string, state: WorkState): Promise<boolean> {
  if (Object.hasOwn(state, MANUAL_CREATE_KEY)) return false;
  if (!fromId) return true;
  const reads = await db
    .select({ id: mailExtraction.id, createdAt: mailExtraction.createdAt, payload: mailExtraction.payload })
    .from(mailExtraction)
    .where(inArray(mailExtraction.id, [fromId, nextId]));
  const from = reads.find((read) => read.id === fromId);
  const next = reads.find((read) => read.id === nextId);
  if (!next) return false;
  if (!from) return true;
  if (next.createdAt < from.createdAt) return false;
  if (!from.payload || !next.payload) return true;
  const previous = safeParseStoredMailExtraction(from.payload);
  const upcoming = safeParseStoredMailExtraction(next.payload);
  return previous.success && upcoming.success && correctionsCarryTo(previous.data, upcoming.data, state);
}

/**
 * Upserts the work item for (thread, kind, source message) and points it at this extraction when it is newer and her
 * saved values still fit it (see shouldRelink). A relink advances the concurrency sequence without changing edit history.
 * `state` is never written here, so a person's values survive a re-read. Returns the read the item is on.
 */
export async function ensureWorkItem(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    messageId: string;
    kind: MailKind;
    extractionId: string;
  },
): Promise<WorkItemSnapshot> {
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as DB;
    await lockCanonicalMailbox(transaction, input.transportId);
    const [pane] = await tx.select({ id: workItem.id, status: workItem.status, state: workItem.state,
      extractionId: workItem.extractionId, revision: workItem.revision, revisionHead: workItem.revisionHead,
      revisionSeq: workItem.revisionSeq }).from(workItem)
      .where(and(eq(workItem.transportId, input.transportId), eq(workItem.threadId, input.threadId),
        eq(workItem.sourceMessageId, input.messageId), sql`${workItem.state} ? 'reservationWorkflowV2'`))
      .orderBy(desc(workItem.updatedAt), desc(workItem.id)).limit(1).for('update');
    if (pane) return pane;
    await tx
      .insert(workItem)
      .values({
        transportId: input.transportId,
        threadId: input.threadId,
        sourceMessageId: input.messageId,
        kind: input.kind,
        extractionId: input.extractionId,
      })
      .onConflictDoNothing({ target: [workItem.threadId, workItem.kind, workItem.sourceMessageId] });
    const [row] = await tx
      .select({
        id: workItem.id,
        status: workItem.status,
        state: workItem.state,
        extractionId: workItem.extractionId,
        revision: workItem.revision,
        revisionHead: workItem.revisionHead,
        revisionSeq: workItem.revisionSeq,
      })
      .from(workItem)
      .where(and(eq(workItem.transportId, input.transportId), eq(workItem.threadId, input.threadId),
        eq(workItem.kind, input.kind), eq(workItem.sourceMessageId, input.messageId)))
      .limit(1).for('update');
    if (!row) throw new Error('work item missing after upsert');
    if (row.extractionId === input.extractionId) return row;
    // The row lock holds off a field save (recordFieldEvent locks the same row) between the check and the move, so a
    // value she saves meanwhile is never carried onto a read it was not checked against.
    if (!(await shouldRelink(tx, row.extractionId, input.extractionId, hydrateStoredWorkState(row.state)))) return row;
    await tx
      .update(workItem)
      .set({ extractionId: input.extractionId, revisionSeq: row.revisionSeq + 1, updatedAt: new Date() })
      .where(eq(workItem.id, row.id));
    return { ...row, extractionId: input.extractionId, revisionSeq: row.revisionSeq + 1 };
  });
}

/**
 * An outbound message sent after `at`. A Nava send has no sentAt until delivery is confirmed, so a queued or failed send
 * is not a reply. Imported Outlook history keeps its sent time in receivedAt when sentAt is missing.
 */
export function outboundSentAfter(at: Date) {
  return or(
    gt(message.sentAt, at),
    and(isNull(message.sentAt), eq(message.historyOnly, true), gt(message.receivedAt, at)),
  );
}

const DELIVERY_TIME_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DELIVERY_TIME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * When an inbound message reached the mailbox. A non-Outlook POP3 row uses the top Received stamp when it is within
 * five minutes after or thirty days before createdAt; otherwise it uses createdAt. The sender's Date header in
 * receivedAt is not a delivery clock. Outlook-synced and non-POP3 rows keep receivedAt ?? createdAt.
 */
export function messageArrivedAt(m: {
  receivedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  pop3Uidl: string | null;
  outlookSynced: boolean;
}): Date {
  if (m.pop3Uidl === null || m.outlookSynced) return m.receivedAt ?? m.createdAt;
  const deliveredAt = m.deliveredAt?.getTime();
  const createdAt = m.createdAt.getTime();
  return Number.isFinite(deliveredAt) &&
    deliveredAt! <= createdAt + DELIVERY_TIME_FUTURE_TOLERANCE_MS &&
    deliveredAt! >= createdAt - DELIVERY_TIME_MAX_AGE_MS
    ? m.deliveredAt!
    : m.createdAt;
}

/** The message's latest succeeded read, or the one with `id` when given. */
async function succeededRead(db: DB, messageId: string, id?: string) {
  const [row] = await db
    .select()
    .from(mailExtraction)
    .where(
      and(
        eq(mailExtraction.messageId, messageId),
        eq(mailExtraction.status, 'succeeded'),
        id ? eq(mailExtraction.id, id) : undefined,
      ),
    )
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id))
    .limit(1);
  if (!row?.kind || !row.payload) return null;
  const payload = safeParseStoredMailExtraction(row.payload);
  if (!payload.success) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    kind: row.kind as MailKind,
    payload: payload.data,
    attachments: row.attachments as AttachmentRead[] | null,
    language: row.language,
    translation: row.translation,
    classifier: parseStoredClassifier(row.usage),
  };
}

/**
 * Points the message's work item at its latest succeeded read. A message with no succeeded read has none, and spam
 * never gets one (nobody has work to do on it). A thread with a staff reply sent after this message arrived is already
 * answered, so a new item starts done, not needs_you. Both sides use mail event times (see messageArrivedAt), not
 * import order.
 */
export async function ensureWorkItemForMessage(
  db: DB,
  input: { transportId: string; messageId: string },
): Promise<WorkItemRef | null> {
  // A later model read must never transplant a staff-owned draft or its receipts to different stay IDs.
  const existingItems = await db.select({ id: workItem.id, status: workItem.status, state: workItem.state,
    extractionId: workItem.extractionId }).from(workItem).where(and(eq(workItem.transportId, input.transportId),
      eq(workItem.sourceMessageId, input.messageId)));
  const manual = existingItems.find((item) => Object.hasOwn(item.state, MANUAL_CREATE_KEY));
  if (manual) return manual;
  const [msg] = await db
    .select({
      threadId: message.threadId,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
      pop3Uidl: message.pop3Uidl,
      outlookSynced: OUTLOOK_SYNCED,
    })
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, input.transportId)))
    .limit(1);
  if (!msg) return null;
  return db.transaction(async tx => {
    const transaction = tx as unknown as DB;
    await lockCanonicalMailbox(transaction, input.transportId);
    if (msg.threadId) await tx.select({ id: mailThread.id }).from(mailThread)
      .where(and(eq(mailThread.id, msg.threadId), eq(mailThread.transportId, input.transportId)))
      .limit(1).for('no key update');
    // A reread can relink or restore one item before refreshing the whole thread.
    // Take thread items in the same order as the refresh before touching any one,
    // including dismissed items that the reread may restore.
    await tx.select({ id: workItem.id }).from(workItem)
      .where(and(eq(workItem.transportId, input.transportId), eq(workItem.threadId, msg.threadId)))
      .orderBy(workItem.id).for('update');
    const [staffDraft] = await tx.select({ id: workItem.id, status: workItem.status, state: workItem.state,
      extractionId: workItem.extractionId }).from(workItem).where(and(eq(workItem.transportId, input.transportId),
      eq(workItem.sourceMessageId, input.messageId), sql`${workItem.state} ? ${MANUAL_CREATE_KEY}`)).limit(1);
    if (staffDraft) return staffDraft;
    const latest = await succeededRead(transaction, input.messageId);
    if (!latest || latest.kind === 'spam') return null;
    const item = await ensureWorkItem(transaction, {
      transportId: input.transportId,
      threadId: msg.threadId,
      messageId: input.messageId,
      kind: latest.kind,
      extractionId: latest.id,
    });
    const current =
      item.status === 'dismissed'
        ? await restoreSupersededItem(transaction, { workItemId: item.id, status: 'needs_you', latestId: latest.id })
        : item;
    await dismissSupersededItems(transaction, {
      transportId: input.transportId,
      threadId: msg.threadId,
      messageId: input.messageId,
      latest,
    });
    // A reply already on the thread closes the item here, and a newer request supersedes it (see refreshThreadWork).
    if (msg.threadId) await refreshThreadWork(transaction, { transportId: input.transportId, threadId: msg.threadId });
    const [fresh] = await tx
      .select({ id: workItem.id, status: workItem.status, state: workItem.state, extractionId: workItem.extractionId })
      .from(workItem)
      .where(eq(workItem.id, current.id))
      .limit(1);
    return fresh ?? current;
  });
}

/** The reason on a system dismissal of an item a kind-changing re-read replaced. */
const SUPERSEDED_READ = 'superseded_read';
/** The reason on a system dismissal of an older item a newer needs-you item on the same thread superseded (C3). */
const SUPERSEDED_BY_THREAD = 'superseded_by_thread';
/** The reasons on the thread's system status changes (refreshThreadWork). */
const HOTEL_REPLIED = 'hotel_replied';
const NEW_INBOUND = 'new_inbound';
const REQUESTS_OUTSTANDING = 'requests_outstanding';
const STAFF_SENT_OTHER = 'staff_sent_other';

/**
 * A later read can come back to a kind an earlier re-read moved away from (quote, other, quote). The item for that kind
 * was dismissed as superseded, so it is put back, with a system event, unless its last status change was someone's
 * own: a person's dismissal stands. An item the thread collapse dismissed (superseded_by_thread) comes back the same way;
 * refreshThreadWork dismisses it again straight away while a newer needs-you item is still on the thread.
 */
async function restoreSupersededItem(
  db: DB,
  input: { workItemId: string; status: 'needs_you' | 'done'; latestId: string },
): Promise<WorkItemRef> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: workItem.id, status: workItem.status, state: workItem.state, extractionId: workItem.extractionId })
      .from(workItem)
      .where(eq(workItem.id, input.workItemId))
      .limit(1)
      .for('update');
    if (!row) throw new Error('work item missing');
    if (row.status !== 'dismissed') return row;
    const [last] = await tx
      .select({ actorKind: workEvent.actorKind, value: workEvent.value })
      .from(workEvent)
      .where(and(eq(workEvent.workItemId, row.id), eq(workEvent.type, 'status.changed')))
      .orderBy(desc(workEvent.at), desc(workEvent.id))
      .limit(1);
    const reason = (last?.value as { reason?: unknown } | null | undefined)?.reason;
    const superseded =
      last?.actorKind === 'system' && (reason === SUPERSEDED_READ || reason === SUPERSEDED_BY_THREAD);
    if (!superseded) return row;
    await tx
      .update(workItem)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(workItem.id, row.id));
    await tx.insert(workEvent).values({
      workItemId: row.id,
      actorKind: 'system',
      type: 'status.changed',
      value: { from: 'dismissed', to: input.status, reason: 'kind_returned', extractionId: input.latestId },
    });
    return { ...row, status: input.status };
  });
}

/**
 * A newer read that changes the kind gets its own work item, so the item made from the older read would stay in Needs
 * you beside it. That older item is dismissed, with a system event, only while nobody has touched it: still needs_you,
 * no saved values, no decision from a person (see personTouchSql), and on a read older than the latest.
 * Anything else is left as it is.
 */
async function dismissSupersededItems(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    messageId: string;
    latest: { id: string; kind: MailKind; createdAt: Date };
  },
): Promise<void> {
  const staleItems = (tx: WorkTx) =>
    tx
      .select({ id: workItem.id })
      .from(workItem)
      .innerJoin(mailExtraction, eq(mailExtraction.id, workItem.extractionId))
      .where(
        and(
          eq(workItem.transportId, input.transportId),
          eq(workItem.threadId, input.threadId),
          eq(workItem.sourceMessageId, input.messageId),
          ne(workItem.kind, input.latest.kind),
          eq(workItem.status, 'needs_you'),
          sql`${workItem.state} = '{}'::jsonb`,
          lt(mailExtraction.createdAt, input.latest.createdAt),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workEvent)
              .where(
                and(eq(workEvent.workItemId, workItem.id), personTouchSql('work_event')),
              ),
          ),
        ),
      );
  // Most calls find nothing, so the lock is only taken when there is something to dismiss.
  if (!(await staleItems(db)).length) return;
  await db.transaction(async (tx) => {
    // The row lock holds off a field save (recordFieldEvent locks the same row) between this check and the update.
    const stale = await staleItems(tx).for('update', { of: workItem });
    if (!stale.length) return;
    const ids = stale.map((row) => row.id);
    await tx
      .update(workItem)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(inArray(workItem.id, ids));
    await tx.insert(workEvent).values(
      ids.map((workItemId) => ({
        workItemId,
        actorKind: 'system' as const,
        type: 'status.changed' as const,
        value: { from: 'needs_you', to: 'dismissed', reason: SUPERSEDED_READ, extractionId: input.latest.id },
      })),
    );
  });
}

/** One mail on a thread, with the fields the thread rules read. */
type ThreadMail = {
  id: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: Date | null;
  deliveredAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  historyOnly: boolean;
  pop3Uidl: string | null;
  outlookSynced: boolean;
};

/** When an inbound mail reached the mailbox, by the rule every work item order uses (messageArrivedAt). */
function arrivedAt(m: ThreadMail): number {
  return messageArrivedAt(m).getTime();
}

/**
 * When a hotel mail left, counted as outboundSentAfter counts it: its sent time, or a history row's received time. A
 * queued or failed Nava send has neither, so it is not a reply.
 */
function leftAt(m: ThreadMail): number | null {
  const at = m.sentAt ?? (m.historyOnly ? m.receivedAt : null);
  return at ? at.getTime() : null;
}

/**
 * From the mailbox's own address, or from its domain when that domain is the hotel's. On a public provider (gmail.com,
 * outlook.com, ...) the domain is shared by every sender, so only the exact mailbox address counts there.
 * ponytail: aliases are not checked.
 */
export function isStaffSender(fromAddress: string, mailboxEmail: string): boolean {
  const from = normalizeEmailAddress(fromAddress);
  const mailbox = normalizeEmailAddress(mailboxEmail);
  if (!from.includes('@') || !mailbox.includes('@')) return false;
  if (from === mailbox) return true;
  const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
  const domain = domainOf(mailbox);
  return !PUBLIC_MAIL_DOMAINS.has(domain) && domainOf(from) === domain;
}

/**
 * The given addresses that any mailbox for the same property has sent from: an outbound message on one of its transports
 * has that From. The From can carry a display name ("Ops <ops@x>"), so both sides are reduced to the bare address by
 * normalizeEmailAddress. Nothing stores an authentication result, so this is the only evidence that a same-domain mail is
 * the hotel's own. Not limited in time, so a rerun, or a backfill, plans what the live rules plan whatever order the mail
 * landed in. The final set comparison is exact; the SQL substring is only a candidate prefilter.
 */
export async function knownSenders(db: WorkTx, transportId: string, fromAddresses: string[]): Promise<Set<string>> {
  const wanted = [...new Set(fromAddresses.map((address) => normalizeEmailAddress(address)).filter(Boolean))];
  if (!wanted.length) return new Set();
  const resolved = resolvePropertyTransport(transportId);
  if (resolved.kind !== 'property') return new Set();
  const propertyTransportIds = getPropertyTransportIds(resolved.property.propertyCode);
  if (!propertyTransportIds.length) return new Set();
  // The bare address is a substring of its lower-cased From, so this prefilter drops no match.
  const rows = await db
    .selectDistinct({ from: message.fromAddress })
    .from(message)
    .where(
      and(
        inArray(message.transportId, propertyTransportIds),
        eq(message.direction, 'outbound'),
        or(...wanted.map((address) => sql`strpos(lower(${message.fromAddress}), ${address}) > 0`)),
      ),
    );
  const sent = new Set(rows.map((row) => normalizeEmailAddress(row.from)));
  return new Set(wanted.filter((address) => sent.has(address)));
}

/**
 * SQL for "a person touched this work item", over the work_event alias the caller's query uses. The planner, the
 * dismissal sweep and the quote follow-up's close check all read it. A person's user event counts, except pane telemetry
 * and a plain field.accept (an AI value confirmed as read). The follow-up suggestion's accept is the exception: using it
 * from the Outlook reminder is the person's decision to send the follow-up.
 */
export function personTouchSql(alias: string): SQL {
  const e = sql.raw(alias);
  return sql`(${e}.actor_kind = 'user' and ${e}.type not in (${sqlList(TELEMETRY_EVENT_TYPES)})
    and (${e}.type <> 'field.accept' or ${e}.field_path = ${FOLLOW_UP_DRAFT_FIELD_PATH}))`;
}

/**
 * One status change the thread's work makes. `repoint` moves the reply link of an item a reply already closed to the
 * hotel's latest answer, and changes no status.
 */
export type ThreadWorkChange =
  | { workItemId: string; kind: MailKind; to: 'done'; reason: typeof HOTEL_REPLIED; sentAt: Date; sentMessageId: string }
  | { workItemId: string; kind: MailKind; to: 'done'; reason: typeof STAFF_SENT_OTHER }
  | { workItemId: string; kind: MailKind; to: 'needs_you'; reason: typeof NEW_INBOUND | typeof REQUESTS_OUTSTANDING; previousSentMessageId: string | null; from?: 'dismissed' }
  | { workItemId: string; kind: MailKind; to: 'dismissed'; reason: typeof SUPERSEDED_BY_THREAD; supersededBy: string }
  | { workItemId: string; kind: MailKind; repoint: { sentAt: Date; sentMessageId: string } };

/**
 * The status changes the thread's work needs, read from its mail and items. A hotel answer can close a needs-you item even
 * after a person touched it, unless the latest hms_write still needs review.ok. A later guest mail reopens a done one a
 * hotel answer closed, touched or not. Other automatic changes only touch an untouched item (no decision from a person,
 * see personTouchSql, and no saved values). Rules, on the source mail's time (arrivedAt):
 * - Reply link (C2): a needs-you item is done (hotel_replied, sent_at and sent_message_id set) when the hotel's latest
 *   mail after it is later than the guest's latest mail after it. The hotel's mail is an outbound one, or an inbound one
 *   from the mailbox's own domain at an exact address the transport has sent from (a copy of its reply, counted by when it
 *   left; a forged own-domain From is neither). A guest mail is any other inbound one, counted by when it arrived, so an
 *   own-domain copy never reopens an item. A done item a later guest mail reopens goes back to needs-you (new_inbound). For
 *   an untouched one its reply link moves to the hotel's next answer. A done item with no reply link (closed before the
 *   link existed) gets the same treatment, with the hotel's latest answer as its link, if no person touched it. A person's
 *   close, with no link, stays.
 * - Same-thread collapse (C3): an older needs-you item is dismissed (superseded_by_thread) when a newer needs-you item of
 *   any kind but other is on the thread and is human-written. An automated one never supersedes a request: listWorkItems
 *   hides it from Needs You, so the older request would show in neither list. A newer "other" mail never supersedes
 *   a request.
 * - Staff-sent other: an "other" mail the hotel sent (an outbound one, or a copy as above) gets no needs-you (done,
 *   staff_sent_other).
 * Makes no writes. Items of kind spam are left out.
 */
export async function planThreadWork(
  db: WorkTx,
  input: { transportId: string; threadId: string },
  opts: { lock?: boolean } = {},
): Promise<ThreadWorkChange[]> {
  // Match hms-approval's latestWriteRun and reviewForRun: the newest hms_write (created_at, then id) needs a review whose
  // newest review.ok or review.flag (at, then id) is review.ok. Explicit table names, as with `touched` below.
  const latestHmsWriteId = sql`(
    select latest_hms_run.id
    from ${aiWorkflowRun} as latest_hms_run
    where latest_hms_run.work_item_id = ${workItem}.id
      and latest_hms_run.run_kind = 'hms_write'
    order by latest_hms_run.created_at desc, latest_hms_run.id desc
    limit 1
  )`;
  const latestHmsReview = sql<string | null>`(
    select latest_review.type
    from ${workEvent} as latest_review
    where latest_review.work_item_id = ${workItem}.id
      and latest_review.type in ('review.ok', 'review.flag')
      and latest_review.value->>'runId' = ${latestHmsWriteId}
    order by latest_review.at desc, latest_review.id desc
    limit 1
  )`;
  const hmsOpen = sql<boolean>`(${latestHmsWriteId} is not null and coalesce(${latestHmsReview}, '') <> 'review.ok')`;
  // Stored origin 'person' means human-written, 'system_notice' means automated. A missing extraction or origin counts
  // as human-written, as listWorkItems reads it.
  const origin = sql<string>`coalesce(${mailExtraction.payload}->>'origin', 'person')`;
  const threadItems = and(
    eq(workItem.transportId, input.transportId),
    eq(workItem.threadId, input.threadId),
    inArray(workItem.status, ['needs_you', 'done', 'dismissed']),
    ne(workItem.kind, 'spam'),
  );
  let lockedIds: string[] | undefined;
  if (opts.lock) {
    // Use a separate statement: SELECT FOR UPDATE can wait for a reply, while
    // its correlated event subqueries still use the snapshot from before that wait.
    const locked = await db.select({ id: workItem.id }).from(workItem)
      .where(threadItems).orderBy(workItem.id).for('update');
    lockedIds = locked.map(item => item.id);
    if (!lockedIds.length) return [];
  }
  // Read events and mail after taking the locks. Restrict the locked plan to
  // those same rows; a newly admitted item gets its own subsequent refresh.
  const itemQuery = db
    .select({
      id: workItem.id,
      kind: workItem.kind,
      status: workItem.status,
      sourceMessageId: workItem.sourceMessageId,
      sentAt: workItem.sentAt,
      sentMessageId: workItem.sentMessageId,
      state: workItem.state,
      hmsOpen,
      rejectedReplyId: sql<string | null>`(
        select we.value->>'replyMessageId'
        from ${workEvent} as we
        where we.work_item_id = ${workItem}.id
          and we.type = 'status.changed'
          and we.value->>'reason' = ${REPLY_NEEDS_ACTION}
        order by we.at desc, we.id desc
        limit 1
      )`,
      lastStatusActor: sql<string | null>`(select we.actor_kind from ${workEvent} as we
        where we.work_item_id = ${workItem}.id and we.type = 'status.changed'
        order by we.at desc, we.id desc limit 1)`,
      lastStatusReason: sql<string | null>`(select we.value->>'reason' from ${workEvent} as we
        where we.work_item_id = ${workItem}.id and we.type = 'status.changed'
        order by we.at desc, we.id desc limit 1)`,
      // Written with explicit table names: drizzle leaves the columns of a select-list subquery unqualified, and then
      // "id" binds to the subquery's own table and the check is always false.
      touched: sql<boolean>`exists (select 1 from ${workEvent} as we where we.work_item_id = ${workItem}.id and ${personTouchSql('we')})`,
      extractionPayload: mailExtraction.payload,
      origin,
    })
    .from(workItem)
    .leftJoin(mailExtraction, eq(mailExtraction.id, workItem.extractionId))
    .where(and(threadItems, lockedIds ? inArray(workItem.id, lockedIds) : undefined));
  const items = await itemQuery;
  const sourceIds = [...new Set(items.flatMap(item => item.sourceMessageId ? [item.sourceMessageId] : []))];
  const requestStates = await handledRequestStates(db, { transportId: input.transportId, threadId: input.threadId, sourceIds });
  const runs = sourceIds.length ? await db.select({
    id: aiWorkflowRun.id, sourceMessageId: aiWorkflowRun.triggerMessageId, metrics: aiWorkflowRun.metrics,
  }).from(aiWorkflowRun).where(and(eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.threadId, input.threadId),
    inArray(aiWorkflowRun.triggerMessageId, sourceIds), eq(aiWorkflowRun.runKind, 'candidate_draft'),
    eq(aiWorkflowRun.executorLane, 'default'), eq(aiWorkflowRun.state, 'succeeded')))
    .orderBy(aiWorkflowRun.triggerMessageId, desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id)) : [];
  const runsBySource = new Map<string, typeof runs>();
  for (const run of runs) {
    if (!run.sourceMessageId) continue;
    const sourceRuns = runsBySource.get(run.sourceMessageId) ?? [];
    sourceRuns.push(run);
    runsBySource.set(run.sourceMessageId, sourceRuns);
  }
  // The pane edits the item for the latest successful classification. Older
  // kinds for the same email must not reopen with a second copy of its tasks.
  const reads = sourceIds.length ? await db.selectDistinctOn([mailExtraction.messageId], {
    messageId: mailExtraction.messageId, kind: mailExtraction.kind,
  }).from(mailExtraction).where(and(inArray(mailExtraction.messageId, sourceIds), eq(mailExtraction.status, 'succeeded')))
    .orderBy(mailExtraction.messageId, desc(mailExtraction.createdAt), desc(mailExtraction.id)) : [];
  const latestKindBySource = new Map(reads.map(read => [read.messageId, read.kind]));
  const [mailbox] = await db
    .select({ email: mailboxTransport.email })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.id, input.transportId))
    .limit(1);
  const mail: ThreadMail[] = await db
    .select({
      id: message.id,
      direction: message.direction,
      fromAddress: message.fromAddress,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      receivedAt: message.receivedAt,
      deliveredAt: MESSAGE_DELIVERED_AT,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
      historyOnly: message.historyOnly,
      pop3Uidl: message.pop3Uidl,
      outlookSynced: OUTLOOK_SYNCED,
    })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.threadId, input.threadId)));

  const byId = new Map(mail.map((m) => [m.id, m]));
  const voucherFiles = sourceIds.length ? await db.select({ id: attachment.id, messageId: attachment.messageId,
    filename: attachment.filename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
    isInline: attachment.isInline, sha256: attachment.sha256, s3Key: attachment.s3Key })
    .from(attachment).where(inArray(attachment.messageId, sourceIds)) : [];
  // The hotel's own mail lands as inbound too (a sent-item copy or a CC), so it is the hotel's answer, not a guest's. But
  // a forged From on the hotel's domain is neither: only an exact address the transport has sent from counts as the hotel.
  const mailboxEmail = mailbox?.email ?? '';
  const ownDomain = (m: ThreadMail) => isStaffSender(m.fromAddress, mailboxEmail);
  const sentFrom = await knownSenders(
    db,
    input.transportId,
    mail.flatMap((m) => (m.direction === 'inbound' && ownDomain(m) ? [m.fromAddress] : [])),
  );
  const ownSent = (m: ThreadMail) =>
    ownDomain(m) && (m.direction === 'outbound' || sentFrom.has(normalizeEmailAddress(m.fromAddress)));
  const guest = mail.flatMap((m) => (m.direction === 'inbound' && !ownDomain(m) ? [{ m, at: arrivedAt(m) }] : []));
  const hotel = mail.flatMap((m) => {
    const at = m.direction === 'outbound' || ownSent(m) ? leftAt(m) : null;
    return at === null ? [] : [{ m, at }];
  });
  // A tie (a copy has the reply's sent time) goes to the outbound row, then the lower id, so a rerun never moves a link.
  const later = <T extends { at: number; m: ThreadMail }>(a: T, b: T) =>
    a.at !== b.at ? a.at > b.at : a.m.direction !== b.m.direction ? a.m.direction === 'outbound' : a.m.id < b.m.id;
  const latest = <T extends { at: number; m: ThreadMail }>(rows: T[]) =>
    rows.reduce<T | undefined>((best, row) => (!best || later(row, best) ? row : best), undefined);
  const changes: ThreadWorkChange[] = [];
  // The items that are needs-you once these changes land. Only untouched ones can be superseded.
  const open: Array<{ id: string; kind: MailKind; at: number; untouched: boolean; humanWritten: boolean }> = [];
  for (const item of items) {
    const source = item.sourceMessageId ? byId.get(item.sourceMessageId) : undefined;
    if (!source) continue;
    const kind = item.kind as MailKind;
    const at = arrivedAt(source);
    const currentKind = !latestKindBySource.has(source.id) || latestKindBySource.get(source.id) === item.kind;
    const handled = handledRequestKeys(requestStates.get(source.id));
    const parsedPayload = safeParseStoredMailExtraction(item.extractionPayload);
    const payload = parsedPayload.success ? parsedPayload.data : null;
    const files = source.direction === 'inbound' && !source.historyOnly
      ? voucherReviewFiles(input.transportId, kind, payload, source, voucherFiles) : [];
    const confirmed = currentKind && files.some(file => !handled.has(file.key))
      ? await confirmedVoucherKey(db, { transportId: input.transportId, workItemId: item.id,
        source: { threadId: input.threadId, messageId: source.id, sourceHash: staffQuoteSourceHash(source) },
        state: item.state, files: voucherFiles, candidates: files }) : null;
    const pendingVoucher = files.some(file => !handled.has(file.key) && file.key !== confirmed);
    const outstanding = Object.hasOwn(item.state, MANUAL_CREATE_KEY) || currentKind && (pendingVoucher || hasOutstandingRequestHistory((runsBySource.get(source.id) ?? [])
      .map(run => ({ id: run.id, result: run.metrics?.reservationistResult, source: run.metrics?.reservationistDraftSource })), requestStates.get(source.id)));
    const untouched = !outstanding && !item.touched && Object.keys(item.state ?? {}).length === 0;
    const humanWritten = item.origin !== 'system_notice';
    const preStayAsk = currentKind ? selfSentPreStayAskVerdict({
      fromAddress: source.fromAddress, mailboxAddress: mailboxEmail, subject: source.subject,
      textBody: source.textBody, htmlBody: source.htmlBody,
      confirmationNumbers: Array.isArray(payload?.confirmationNumbers) ? payload.confirmationNumbers : [],
      payload,
    }) : null;
    const lastGuest = latest(guest.filter((x) => x.at > at));
    const lastHotel = latest(hotel.filter((x) => x.at > at));
    // Outbound/ownSent messages lack stored Auto-Submitted provenance, verified human authorship, or substantive-answer
    // evidence, and outbound_send_queue.status='sent' is not recipient delivery proof. Never auto-close unfinished or
    // unproven work merely because an outbound reply was sent; without verifiable current complete source+task
    // evidence, reopen current-kind system/HOTEL_REPLIED closures on touched-thread refresh for staff review.
    // A prior pure-information read may have been automatically closed as staff-sent. A pre-stay the read could not
    // clear also reopens: it may still carry a current ask, so it is never auto-done on a missing verdict.
    if (preStayAsk && item.status === 'done' && item.lastStatusActor === 'system' && item.lastStatusReason === STAFF_SENT_OTHER) {
      changes.push({ workItemId: item.id, kind, to: 'needs_you', reason: REQUESTS_OUTSTANDING, previousSentMessageId: null });
      open.push({ id: item.id, kind, at, untouched: false, humanWritten });
      continue;
    }
    if (item.status === 'dismissed') {
      if (outstanding && item.lastStatusActor === 'system' && item.lastStatusReason === SUPERSEDED_BY_THREAD) {
        changes.push({ workItemId: item.id, kind, to: 'needs_you', reason: REQUESTS_OUTSTANDING, previousSentMessageId: null, from: 'dismissed' });
        open.push({ id: item.id, kind, at, untouched: false, humanWritten });
      }
      continue;
    }
    if (item.status === 'done' && item.lastStatusActor === 'system' && item.lastStatusReason === HOTEL_REPLIED) {
      if (!currentKind) continue;
      changes.push({ workItemId: item.id, kind, to: 'needs_you', reason: REQUESTS_OUTSTANDING, previousSentMessageId: item.sentMessageId });
      open.push({ id: item.id, kind, at, untouched: false, humanWritten });
      continue;
    }
    // A done `other` mail from this domain stays as it is (#172); only an exact sent-from match closes a needs-you `other`.
    const domainOther = kind === 'other' && ownDomain(source);
    if (!untouched) {
      if (item.status === 'needs_you') {
        open.push({ id: item.id, kind, at, untouched: false, humanWritten });
      } else if (item.sentAt && !domainOther && lastGuest && lastGuest.at > item.sentAt.getTime()) {
        // A hotel reply closed it, then a person touched it: a later guest mail still reopens it. A person's close has no
        // reply link, so it stays.
        changes.push({
          workItemId: item.id,
          kind,
          to: 'needs_you',
          reason: NEW_INBOUND,
          previousSentMessageId: item.sentMessageId,
        });
        open.push({ id: item.id, kind, at, untouched: false, humanWritten });
      }
      continue;
    }
    const staffOther = kind === 'other' && ownSent(source) && !preStayAsk;
    if (item.status === 'needs_you') {
      if (staffOther) {
        changes.push({ workItemId: item.id, kind, to: 'done', reason: STAFF_SENT_OTHER });
      } else {
        open.push({ id: item.id, kind, at, untouched: true, humanWritten });
      }
    } else if (!domainOther) {
      // Closed by a hotel reply: reopened by a later guest mail. Touched rows are handled above, so this branch sees untouched rows only.
      const linkedAt = item.sentAt ? item.sentAt.getTime() : lastHotel?.at;
      if (lastGuest && linkedAt !== undefined && lastGuest.at > linkedAt) {
        changes.push({
          workItemId: item.id,
          kind,
          to: 'needs_you',
          reason: NEW_INBOUND,
          previousSentMessageId: item.sentMessageId,
        });
        open.push({ id: item.id, kind, at, untouched: true, humanWritten });
      }
    }
  }
  for (const older of open.filter((x) => x.untouched)) {
    // Only a human-written item supersedes a request: an automated one is hidden from Needs You, so it would leave the
    // older request in neither list.
    const newer = open.find((x) => x.id !== older.id && x.at > older.at && x.kind !== 'other' && x.humanWritten);
    if (newer) {
      changes.push({
        workItemId: older.id,
        kind: older.kind,
        to: 'dismissed',
        reason: SUPERSEDED_BY_THREAD,
        supersededBy: newer.id,
      });
    }
  }
  return changes;
}

async function applyThreadWorkChange(tx: WorkTx, change: ThreadWorkChange): Promise<void> {
  const now = new Date();
  // A changed reply link clears the follow-up clock: the sweep (quote-followup) starts it again from the new link.
  if ('repoint' in change) {
    await tx
      .update(workItem)
      .set({
        sentAt: change.repoint.sentAt,
        sentMessageId: change.repoint.sentMessageId,
        followUpDueAt: null,
        updatedAt: now,
      })
      .where(eq(workItem.id, change.workItemId));
    // The follow-up clock keys on a recorded hotel_replied close (CLOSED_BY_HOTEL_REPLY). A done item closed before the reply
    // link existed has none, so its link records one, as the other close does. A link that moves on a close already
    // recorded needs no second event.
    const [recorded] = await tx
      .select({ id: workEvent.id })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, change.workItemId),
          eq(workEvent.type, 'status.changed'),
          sql`${workEvent.value}->>'reason' = ${HOTEL_REPLIED}`,
        ),
      )
      .limit(1);
    if (!recorded) {
      await tx.insert(workEvent).values({
        workItemId: change.workItemId,
        actorKind: 'system',
        type: 'status.changed',
        value: { from: 'done', to: 'done', reason: HOTEL_REPLIED, sentMessageId: change.repoint.sentMessageId },
      });
    }
    await enqueueReplyCheckForItem(tx, change.workItemId, change.repoint.sentMessageId);
    return;
  }
  const from = change.to === 'needs_you' ? change.from ?? 'done' : 'needs_you';
  const link =
    change.to === 'done' && change.reason === HOTEL_REPLIED
      ? { sentAt: change.sentAt, sentMessageId: change.sentMessageId, followUpDueAt: null }
      : change.to === 'needs_you'
        ? { sentAt: null, sentMessageId: null, followUpDueAt: null }
        : {};
  await tx
    .update(workItem)
    .set({ status: change.to, ...link, updatedAt: now })
    .where(eq(workItem.id, change.workItemId));
  const detail =
    change.to === 'needs_you'
      ? { sentMessageId: change.previousSentMessageId }
      : change.to === 'dismissed'
        ? { supersededBy: change.supersededBy }
        : change.to === 'done' && change.reason === HOTEL_REPLIED
          ? { sentMessageId: change.sentMessageId }
          : {};
  await tx.insert(workEvent).values({
    workItemId: change.workItemId,
    actorKind: 'system',
    type: 'status.changed',
    value: { from, to: change.to, reason: change.reason, ...detail },
  });
  if (change.to === 'done' && change.reason === HOTEL_REPLIED) {
    await enqueueReplyCheckForItem(tx, change.workItemId, change.sentMessageId);
  }
}

async function enqueueReplyCheckForItem(tx: WorkTx, workItemId: string, replyMessageId: string): Promise<void> {
  const [row] = await tx
    .select({ transportId: workItem.transportId, threadId: workItem.threadId })
    .from(workItem)
    .where(eq(workItem.id, workItemId))
    .limit(1);
  if (!row?.threadId) return;
  await enqueueReplyCheckIfNeeded(tx as unknown as DB, {
    transportId: row.transportId,
    threadId: row.threadId,
    workItemId,
    replyMessageId,
  });
}

/**
 * Applies planThreadWork for one thread: the reply link (C2), the same-thread collapse (C3) and the staff-sent other rule.
 * A hotel reply only closes an item after its latest hms_write has review.ok. The plan is read again under the item row
 * locks, the same lock a field save or a dismissal takes, so nothing a person touched after the first read is changed.
 * Normally takes the lock only when there is something to change. A newly completed
 * analysis must lock even on a no-op to serialize with an in-flight reply refresh.
 */
export async function refreshThreadWork(
  db: DB,
  input: { transportId: string; threadId: string },
  opts: { lockEvenIfUnchanged?: boolean } = {},
): Promise<ThreadWorkChange[]> {
  if (!opts.lockEvenIfUnchanged && !(await planThreadWork(db, input)).length) return [];
  return db.transaction(async (tx) => {
    const changes = await planThreadWork(tx, input, { lock: true });
    for (const change of changes) await applyThreadWorkChange(tx, change);
    return changes;
  });
}

/** What the pane shows of a stored translation (U16). A translation that is neither succeeded nor failed reads as none. */
export type StoredTranslation =
  | { status: 'succeeded'; segments: Array<{ clean: string; literal: string }>; truncated: boolean }
  | { status: 'failed' }
  | null;

export function storedTranslation(raw: unknown): StoredTranslation {
  const stored = raw as { status?: unknown; segments?: unknown; truncated?: unknown } | null;
  if (stored?.status === 'failed') return { status: 'failed' };
  if (stored?.status !== 'succeeded' || !Array.isArray(stored.segments)) return null;
  const segments = stored.segments.flatMap((item: { clean?: unknown; literal?: unknown } | null) =>
    typeof item?.clean === 'string' && typeof item.literal === 'string'
      ? [{ clean: item.clean, literal: item.literal }]
      : [],
  );
  return { status: 'succeeded', segments, truncated: stored.truncated === true };
}

export type FieldProvenanceSource = 'ai' | 'staff' | 'unknown';
export type FieldProvenance = Record<string, { source: FieldProvenanceSource; value: unknown }>;

export type StoredWork =
  | { status: 'none' }
  | { status: 'failed'; reason: string; extractionId?: string; extractorVersion?: string; fingerprint?: string; source?: { threadId: string; messageId: string; sourceHash: string } }
  | {
      status: 'ready';
      /** The stored extraction kind, for the pane's shared reservation-staff vocabulary. */
      kind: string;
      staffManual?: boolean;
      /** A self-sent pre-stay confirmation is information about an existing stay, not booking work. */
      existingStayInformation: boolean;
      separateAsk: string | null;
      /** True when the stored read could not verify there is no other ask; staff review the current mail. */
      separateAskReview: boolean;
      /** Confirmation numbers stay available to staff even when the extraction kind is shown as `other`. */
      confirmationNumbers: string[];
      /** Null when the read has no work item yet. The pane then opens one (openStoredWork) before it logs edits. */
      workItemId: string | null;
      workItemStatus: string | null;
      /** The work-item row's revision and extraction link, read with its saved state; null without an item. */
      revision: number | null;
      revisionHead: number | null;
      revisionSeq: number | null;
      workItemExtractionId: string | null;
      extractionId: string;
      refs: Record<string, GroupRef>;
      /** noReplySender: the sender is an automated mailbox, so the pane shows no reply controls (as the live read). */
      analysis: StoredAnalysis & {
        noReplySender: boolean;
        hmsTodoCard: Awaited<ReturnType<typeof hmsTodoCardFromLuna>>;
      };
      contact: StoredContact;
      /** Last HMS commit per stay, keyed by extraction stay id. Empty until a stay is booked. */
      stays: Record<string, StayCommitRecord>;
      /** Last Book preview grant per stay. Digest-bound status, never a reusable token. */
      stayPreviews: Record<string, StayPreviewRecord>;
      /** Latest append-only field event per path, scoped to this transport and work item. */
      fieldProvenance: FieldProvenance;
      /** Additive first-Amend draft; existing workflow reads stay backwards compatible. */
      draftContractVersion?: 1;
      source?: DraftSource & { extractionId: string };
      draftStays?: FormStay[];
      workflowRequests?: EffectiveRequest[];
      draftFieldMeta?: ReturnType<typeof projectEffectiveWork>['meta'];
      unappliedEdits?: ReturnType<typeof projectEffectiveWork>['unappliedEdits'];
      /** The read's source language (ISO 639-1), or null when unclear. */
      language: string | null;
      translation: StoredTranslation;
    };

async function failureFor(db: DB, msg: { id: string; threadId: string; subject: string | null; textBody: string | null; htmlBody: string | null }): Promise<StoredWork> {
  const [latest] = await db
    .select({ id: mailExtraction.id, extractorVersion: mailExtraction.extractorVersion, status: mailExtraction.status, usage: mailExtraction.usage, attachments: mailExtraction.attachments })
    .from(mailExtraction)
    .where(eq(mailExtraction.messageId, msg.id))
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!latest || latest.status !== 'failed') return { status: 'none' };
  const code = latest.usage?.failureReason;
  const copy =
    typeof code === 'string' && Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined;
  return { status: 'failed', reason: copy ?? 'Nava could not read this email.', extractionId: latest.id, extractorVersion: latest.extractorVersion, fingerprint: failedReadFingerprint(latest), source: { threadId: msg.threadId, messageId: msg.id, sourceHash: staffQuoteSourceHash(msg) } };
}

/** The exact selected message, or the unique RFC-only match for legacy callers. */
export async function messageFor(db: DB, input: { transportId: string; internetMessageId: string;
  selection?: PaneSourceSelection; expectedMessageId?: string }) {
  const internetMessageId = canonicalInternetMessageId(input.internetMessageId);
  if (!internetMessageId) return null;
  const found = await db
    .select({
      id: message.id,
      threadId: message.threadId,
      fromAddress: message.fromAddress,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      mailboxAddress: mailboxTransport.email,
    })
    .from(message)
    .leftJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
    .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, internetMessageId),
      paneSourceSelectionCondition(input.selection)))
    .limit(2);
  const result = found.length === 1 ? found[0]! : null;
  return result && (!input.expectedMessageId || result.id === input.expectedMessageId) ? result : null;
}

/** Explicit staff choice, bound to the selected inbound email and its actual failed observation. */
export async function startManualCreate(db: DB, input: {
  transportId: string; actorId: string; internetMessageId: string; selection: PaneSourceSelection;
  extractionId: string; fingerprint: string; source: DraftSource;
}): Promise<{ status: 'started' | 'blocked' }> {
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as DB;
    await lockCanonicalMailbox(transaction, input.transportId);
    const [thread] = await tx.select({ id: mailThread.id }).from(mailThread).where(and(
      eq(mailThread.id, input.source.threadId), eq(mailThread.transportId, input.transportId),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('no key update');
    if (!thread) return { status: 'blocked' as const };
    const selected = await messageFor(transaction, { ...input, expectedMessageId: input.source.messageId });
    if (!selected || selected.threadId !== thread.id || staffQuoteSourceHash(selected) !== input.source.sourceHash ||
        isSelfSentPreStaySubject({ fromAddress: selected.fromAddress, mailboxAddress: selected.mailboxAddress, subject: selected.subject })) {
      return { status: 'blocked' as const };
    }
    const [mail] = await tx.select().from(message).where(and(eq(message.id, selected.id), eq(message.transportId, input.transportId),
      eq(message.threadId, thread.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false))).limit(1).for('no key update');
    if (!mail || mail.sourceProvenance?.attention != null || staffQuoteSourceHash(mail) !== input.source.sourceHash) {
      return { status: 'blocked' as const };
    }
    const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess).where(and(
      eq(mailboxAccess.userId, input.actorId), eq(mailboxAccess.transportId, input.transportId))).limit(1).for('share');
    const [read] = await tx.select().from(mailExtraction).where(and(eq(mailExtraction.id, input.extractionId),
      eq(mailExtraction.messageId, mail.id))).limit(1).for('update');
    if (!access || !read || read.status !== 'failed' || failedReadFingerprint(read) !== input.fingerprint) return { status: 'blocked' as const };
    const [existing] = await tx.select({ id: workItem.id }).from(workItem).where(and(
      eq(workItem.transportId, input.transportId), eq(workItem.sourceMessageId, mail.id))).limit(1);
    const [success] = await tx.select({ id: mailExtraction.id }).from(mailExtraction).where(and(
      eq(mailExtraction.messageId, mail.id), eq(mailExtraction.status, 'succeeded'))).limit(1);
    if (existing || success) return { status: 'blocked' as const };
    const marker = { version: 1 as const, extractionId: read.id, sourceHash: input.source.sourceHash,
      messageId: mail.id, threadId: thread.id, actorId: input.actorId,
      stayId: `s_m${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      rowId: `r_m${randomUUID().replaceAll('-', '').slice(0, 24)}` };
    const [item] = await tx.insert(workItem).values({ transportId: input.transportId, threadId: thread.id,
      sourceMessageId: mail.id, kind: 'booking', extractionId: read.id, state: { [MANUAL_CREATE_KEY]: marker } })
      .onConflictDoNothing().returning({ id: workItem.id });
    if (!item) return { status: 'blocked' as const };
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: input.actorId,
      type: 'note.staff', value: { action: 'manual_create_started', extractionId: read.id, sourceHash: input.source.sourceHash } });
    return { status: 'started' as const };
  });
}

type ReadyRead = NonNullable<Awaited<ReturnType<typeof succeededRead>>>;

const FIELD_PROVENANCE_EVENT_TYPES = ['field.seed', 'field.edit', 'field.accept', 'field.reject', 'field.reset'] as const;

function fieldProvenanceSource(event: {
  actorKind: string;
  type: string;
  aiSource: string | null;
}): FieldProvenanceSource {
  if (event.actorKind === 'ai') return 'ai';
  if (event.actorKind !== 'user') return 'unknown';
  if (event.type === 'field.accept') return event.aiSource?.trim() ? 'ai' : 'unknown';
  if (event.type === 'field.reset') return event.aiSource?.trim() ? 'ai' : 'unknown';
  if (event.type === 'field.edit' || event.type === 'field.reject') return 'staff';
  return 'unknown';
}

async function latestFieldProvenance(
  db: DB,
  input: { transportId: string; workItemId: string | null },
): Promise<FieldProvenance> {
  if (!input.workItemId) return {};
  const events = await db
    .select({
      actorKind: workEvent.actorKind,
      type: workEvent.type,
      fieldPath: workEvent.fieldPath,
      value: workEvent.value,
      aiSource: workEvent.aiSource,
    })
    .from(workEvent)
    .innerJoin(workItem, eq(workItem.id, workEvent.workItemId))
    .where(
      and(
        eq(workItem.id, input.workItemId),
        eq(workItem.transportId, input.transportId),
        isNotNull(workEvent.fieldPath),
        inArray(workEvent.type, FIELD_PROVENANCE_EVENT_TYPES),
      ),
    )
    .orderBy(desc(workEvent.at), desc(workEvent.id));
  const provenance: FieldProvenance = {};
  for (const event of events) {
    if (event.fieldPath === null) continue;
    const path = hydrateStoredFieldPath(event.fieldPath);
    if (!Object.hasOwn(provenance, path)) provenance[path] = { source: fieldProvenanceSource(event), value: event.value };
  }
  return provenance;
}

/** The pane's ready view of a read with her saved values. The item can stay on an earlier read (see ensureWorkItem). */
async function readyView(
  db: DB,
  msg: {
    id: string;
    threadId: string;
    fromAddress: string | null;
    subject: string | null;
    textBody: string | null;
    htmlBody: string | null;
    mailboxAddress: string | null;
  },
  latest: ReadyRead,
  item: WorkItemSnapshot | null,
  transportId: string,
  staffManual = false,
): Promise<StoredWork> {
  const messageId = msg.id;
  const read =
    item?.extractionId && item.extractionId !== latest.id
      ? ((await succeededRead(db, messageId, item.extractionId)) ?? latest)
      : latest;
  const confirmationNumbers = payloadConfirmationNumbers(read.payload);
  const preStayAsk = selfSentPreStayAskVerdict({
    fromAddress: msg.fromAddress,
    mailboxAddress: msg.mailboxAddress,
    subject: msg.subject,
    textBody: msg.textBody,
    htmlBody: msg.htmlBody,
    confirmationNumbers,
    payload: read.payload,
  });
  const existingStayInformation = preStayAsk !== null;
  const separateAsk = preStayAsk?.status === 'ask' ? preStayAsk.excerpt : null;
  const paneItem = existingStayInformation && !separateAsk ? null : item;
  const state = hydrateStoredWorkState(paneItem?.state ?? {});
  const selectedConfirmation = confirmationNumbers[0] ?? '';
  const synced = existingStayInformation
    ? null
    : await loadSyncedQuoteSelectionFromMailbox({ transportId, messageId: msg.id });
  const threadConfirmation = isHmsConfirmation(selectedConfirmation)
    ? undefined
    : synced?.threadConfirmation;
  const resolvedProperty = resolvePropertyTransport(transportId);
  const stored = storedAnalysis(
    {
      ...read,
      fromAddress: msg.fromAddress,
      subject: msg.subject,
      bodyText: msg.textBody,
    },
    state,
    threadConfirmation,
    resolvedProperty.kind === 'property' ? resolvedProperty.property.propertyCode : undefined,
  );
  const sourceText = synced
    ? currentSourceText(synced)
    : [msg.subject ?? '', msg.textBody ?? ''].join('\n');
  const draftSource = { threadId: msg.threadId, messageId: msg.id, sourceHash: staffQuoteSourceHash(msg), extractionId: read.id };
  const [ownerLabel] = await db.select({ action: mailActionLabel.action }).from(mailActionLabel)
    .where(and(eq(mailActionLabel.transportId, transportId), eq(mailActionLabel.messageId, msg.id),
      eq(mailActionLabel.source, 'owner'), eq(mailActionLabel.version, 'owner')))
    .orderBy(desc(mailActionLabel.updatedAt), desc(mailActionLabel.id)).limit(1);
  const effectiveDraft = !existingStayInformation && read.payload.stays.length > 0
    ? projectEffectiveWork(draftSource, requestPayload(read.payload, state, read.kind), state, staffManual ? undefined : ownerLabel?.action, read.kind, read.attachments, read.payload.stays.length) : null;
  if (effectiveDraft && (read.kind === 'cancellation' || read.kind === 'amendment')) {
    const cancel = projectCancelRequests(draftSource, read.payload, state, ownerLabel?.action, read.kind);
    effectiveDraft.requests = effectiveDraft.requests.map((request) =>
      request.action === 'cancel' ? cancel.requests.find((item) => item.requestId === request.requestId) ?? request : request);
    Object.assign(effectiveDraft.meta, cancel.meta);
  }
  const draftStays = effectiveDraft ? formStays(read.payload, state).map((stay) => {
    const value = <T>(path: string, fallback: T): T => Object.hasOwn(state, path) ? state[path] as T : fallback;
    return {
      ...stay,
      requested: {
        arrival: value(`stays[${stay.id}].requested.arrival`, stay.requested.arrival),
        departure: value(`stays[${stay.id}].requested.departure`, stay.requested.departure),
      },
      rows: stay.rows.map((row) => ({
        ...row,
        rooms: value(`stays[${stay.id}].rows[${row.id}].count`, row.rooms),
        adultsPerRoom: value(`stays[${stay.id}].rows[${row.id}].adults`, row.adultsPerRoom),
        roomType: value(`stays[${stay.id}].rows[${row.id}].roomType`, row.roomType),
        childAges: value(`stays[${stay.id}].rows[${row.id}].childAges`, row.childAges),
        mealPlan: value(`stays[${stay.id}].rows[${row.id}].mealPlan`, row.mealPlan),
      })),
    };
  }) : undefined;
  return {
    status: 'ready',
    kind: existingStayInformation ? 'other' : read.kind,
    ...(staffManual ? { staffManual: true } : {}),
    existingStayInformation,
    separateAsk,
    separateAskReview: preStayAsk?.status === 'review',
    confirmationNumbers,
    workItemId: paneItem?.id ?? null,
    workItemStatus: paneItem?.status ?? null,
    revision: paneItem?.revision ?? null,
    revisionHead: paneItem?.revisionHead ?? null,
    revisionSeq: paneItem?.revisionSeq ?? null,
    workItemExtractionId: paneItem?.extractionId ?? null,
    extractionId: read.id,
    refs: stored.refs,
    // As the live read does (quote-workflow route): a do-not-reply sender gets no reply controls.
    analysis: {
      ...stored.analysis,
      ...(staffManual ? { source: 'staff_manual' as const, aiUnavailable: true } : {}),
      noReplySender: isNoReplyAddress(msg.fromAddress),
      hmsTodoCard: existingStayInformation
        ? null
        : await hmsTodoCardFromLuna(
            stored.analysis.luna,
            synced?.attachments ?? [],
            sourceText,
            resolvedProperty.kind === 'property' ? resolvedProperty.property.propertyCode : undefined,
          ),
    },
    contact: storedContact(read.payload, state),
    stays: await paneStayCommitsOf(state),
    stayPreviews: stayPreviewsOf(state),
    fieldProvenance: await latestFieldProvenance(db, {
      transportId,
      workItemId: paneItem?.id ?? null,
    }),
    ...(effectiveDraft ? {
      draftContractVersion: 1 as const,
      source: { ...draftSource, extractionId: read.id },
      draftStays,
      workflowRequests: effectiveDraft.requests,
      draftFieldMeta: effectiveDraft.meta,
      unappliedEdits: effectiveDraft.unappliedEdits,
    } : {}),
    language: read.language,
    translation: storedTranslation(read.translation),
  };
}

/** A staff-owned draft remains on the exact failed read even if a later model read appears. */
async function manualViewFor(db: DB, msg: NonNullable<Awaited<ReturnType<typeof messageFor>>>, transportId: string): Promise<StoredWork | null> {
  const items = await db.select({ id: workItem.id, status: workItem.status, state: workItem.state,
    extractionId: workItem.extractionId, revision: workItem.revision, revisionHead: workItem.revisionHead,
    revisionSeq: workItem.revisionSeq, kind: workItem.kind, sourceMessageId: workItem.sourceMessageId,
    threadId: workItem.threadId }).from(workItem).where(and(eq(workItem.transportId, transportId),
      eq(workItem.sourceMessageId, msg.id), eq(workItem.kind, 'booking'))).limit(1);
  const item = items[0];
  if (!item || !Object.hasOwn(item.state, MANUAL_CREATE_KEY)) return null;
  if (!manualCreateMarker(item.state) || !item.extractionId) return { status: 'failed', reason: 'This staff-entered booking changed. Reopen the email for review.' };
  const [extraction] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, item.extractionId)).limit(1);
  const payload = extraction && manualCreatePayload({ item, extraction, source: msg });
  if (!extraction || !payload) return { status: 'failed', reason: 'This staff-entered booking changed. Reopen the email for review.' };
  const read: ReadyRead = { id: extraction.id, createdAt: extraction.createdAt, kind: 'booking', payload,
    attachments: null, language: null, translation: null, classifier: null };
  return readyView(db, msg, read, item, transportId, true);
}

/**
 * What the pane shows for one mail: the latest succeeded read with its work item, the latest failed read as a reason,
 * or nothing (the pane then reads the mail live). A read only: no model call, and no row is written. The inbound run
 * makes the work item when it stores the read; a read without one comes back with a null workItemId.
 */
export async function storedWorkFor(
  db: DB,
  input: { transportId: string; internetMessageId: string; selection?: PaneSourceSelection },
): Promise<StoredWork> {
  const msg = await messageFor(db, input);
  if (!msg) return { status: 'none' };
  const manual = await manualViewFor(db, msg, input.transportId);
  if (manual) return manual;
  const latest = await succeededRead(db, msg.id);
  if (!latest) return failureFor(db, msg);
  const preStayAsk = selfSentPreStayAskVerdict({
    fromAddress: msg.fromAddress,
    mailboxAddress: msg.mailboxAddress,
    subject: msg.subject,
    textBody: msg.textBody,
    htmlBody: msg.htmlBody,
    confirmationNumbers: payloadConfirmationNumbers(latest.payload),
    payload: latest.payload,
  });
  if (preStayAsk && preStayAsk.status !== 'ask') {
    return readyView(db, msg, latest, null, input.transportId);
  }
  const [item] = await db
    .select({
      id: workItem.id,
      status: workItem.status,
      state: workItem.state,
      extractionId: workItem.extractionId,
      revision: workItem.revision,
      revisionHead: workItem.revisionHead,
      revisionSeq: workItem.revisionSeq,
    })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        eq(workItem.threadId, msg.threadId),
        eq(workItem.kind, latest.kind),
        eq(workItem.sourceMessageId, msg.id),
      ),
    )
    .limit(1);
  if (item && Object.hasOwn(item.state, 'reservationWorkflowV2')) return { status: 'none' };
  return readyView(db, msg, latest, item ?? null, input.transportId);
}

/**
 * The same view, after making sure the read has its work item and points it at the latest read it can (ensureWorkItem).
 * The pane calls this once, only when storedWorkFor found a read with no work item, so her edits have an item to land on.
 */
export async function openStoredWork(
  db: DB,
  input: { transportId: string; internetMessageId: string; selection?: PaneSourceSelection },
): Promise<StoredWork> {
  const msg = await messageFor(db, input);
  if (!msg) return { status: 'none' };
  const manual = await manualViewFor(db, msg, input.transportId);
  if (manual) return manual;
  const latest = await succeededRead(db, msg.id);
  if (!latest) return failureFor(db, msg);
  const preStayAsk = selfSentPreStayAskVerdict({
    fromAddress: msg.fromAddress,
    mailboxAddress: msg.mailboxAddress,
    subject: msg.subject,
    textBody: msg.textBody,
    htmlBody: msg.htmlBody,
    confirmationNumbers: payloadConfirmationNumbers(latest.payload),
    payload: latest.payload,
  });
  if (preStayAsk && preStayAsk.status !== 'ask') {
    return readyView(db, msg, latest, null, input.transportId);
  }
  const [v2Item] = await db.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.transportId, input.transportId), eq(workItem.threadId, msg.threadId),
      eq(workItem.sourceMessageId, msg.id))).limit(1);
  if (v2Item && Object.hasOwn(v2Item.state, 'reservationWorkflowV2')) return { status: 'none' };
  const item = await ensureWorkItem(db, {
    transportId: input.transportId,
    threadId: msg.threadId,
    messageId: msg.id,
    kind: latest.kind,
    extractionId: latest.id,
  });
  return readyView(db, msg, latest, item, input.transportId);
}

export type FieldEventResult =
  | { status: 'not_found' }
  | { status: 'invalid_path' }
  | { status: 'invalid_value' }
  | { status: 'stale_source' }
  | { status: 'stale_revision' }
  | {
      status: 'recorded';
      aiValue: unknown;
      value: unknown;
      previousSeq: number;
      seq: number;
      revision: number;
      revisionHead: number;
      workItemExtractionId: string | null;
    };

/**
 * Appends one field event and updates that field in the work item's state, in one transaction. ai_value is read from the
 * item's extraction by stable id. Edit and reject store the person's value in state (null clears). Accept stores the AI
 * value in the event only: it removes any person value on the path, so the field reads as the extraction again and is
 * never shown as a staff correction. An item in another transport reads as not found, the same as a missing one.
 */
export async function recordFieldEvent(
  db: DB,
  input: {
    transportId: string;
    workItemId: string;
    userId: string;
    type: 'field.edit' | 'field.accept' | 'field.reject';
    fieldPath: string;
    value?: unknown;
    msSinceOpen?: number;
    source?: DraftSource;
    expectedSeq?: number;
    expectedExtractionId?: string | null;
  },
): Promise<FieldEventResult> {
  const contact = contactFieldOf(input.fieldPath);
  const request = parseRequestField(input.fieldPath);
  const path = contact || request ? null : parseFieldPath(input.fieldPath);
  if (!contact && !path && !request) return { status: 'invalid_path' };
  const personValue = input.value ?? null;
  const fits = contact ? validContactValue(personValue) : request ? validRequestValue(request.field, personValue)
    : path !== null && validFieldValue(path.field, personValue);
  if (request && ((input.type === 'field.accept' && input.value !== undefined) ||
      (input.type === 'field.edit' && input.value === undefined))) return { status: 'invalid_value' };
  if (input.type !== 'field.accept' && !fits) return { status: 'invalid_value' };
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        extractionId: workItem.extractionId,
        threadId: workItem.threadId,
        sourceMessageId: workItem.sourceMessageId,
        kind: workItem.kind,
        state: workItem.state,
        revision: workItem.revision,
        revisionHead: workItem.revisionHead,
        revisionSeq: workItem.revisionSeq,
      })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    if (Object.hasOwn(item.state, 'reservationWorkflowV2')) return { status: 'invalid_path' as const };
    if (input.expectedExtractionId !== undefined && input.expectedExtractionId !== item.extractionId) {
      return { status: 'stale_revision' as const };
    }
    const [read] = item.extractionId
      ? await tx
          .select({ id: mailExtraction.id, payload: mailExtraction.payload, version: mailExtraction.extractorVersion,
            attachments: mailExtraction.attachments, messageId: mailExtraction.messageId,
            kind: mailExtraction.kind, status: mailExtraction.status })
          .from(mailExtraction)
          .where(eq(mailExtraction.id, item.extractionId))
          .limit(1)
      : [];
    const parsedPayload = safeParseStoredMailExtraction(read?.payload);
    let payload = parsedPayload.success ? parsedPayload.data : null;
    item.state = hydrateStoredWorkState(item.state);
    const isManual = Object.hasOwn(item.state, MANUAL_CREATE_KEY);
    if (request || input.source || input.expectedSeq !== undefined || isManual) {
      if (!input.source || ((request || isManual) && input.expectedSeq === undefined) ||
          input.source.threadId !== item.threadId || input.source.messageId !== item.sourceMessageId ||
          !read || read.messageId !== item.sourceMessageId) {
        return { status: 'stale_source' as const };
      }
      if (input.expectedSeq !== undefined && input.expectedSeq !== item.revisionSeq) return { status: 'stale_revision' as const };
      const [mail] = await tx.select({ id: message.id, threadId: message.threadId, subject: message.subject, textBody: message.textBody,
        htmlBody: message.htmlBody, historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance }).from(message)
        .where(and(eq(message.id, input.source.messageId), eq(message.transportId, input.transportId),
          eq(message.threadId, input.source.threadId), eq(message.direction, 'inbound'))).limit(1);
      if (!mail || mail.historyOnly || mail.sourceProvenance?.attention != null ||
          staffQuoteSourceHash(mail) !== input.source.sourceHash) return { status: 'stale_source' as const };
      if (isManual) {
        payload = manualCreatePayload({ item, extraction: read, source: mail });
        if (!payload) return { status: 'stale_source' as const };
      } else if (read.kind !== item.kind || read.status !== 'succeeded') return { status: 'stale_source' as const };
    }
    let aiValue: unknown;
    if (request) {
      // The common guard above guarantees the source is present here.
      if (!input.source) return { status: 'stale_source' as const };
      if (!payload) return { status: 'invalid_path' as const };
      const requestSource = requestPayload(payload, item.state, item.kind as MailKind);
      const sourceRequest = sourceRequests(input.source, requestSource, read?.attachments as AttachmentRead[] | null ?? null)
        .find((entry) => entry.requestId === request.requestId);
      if (!sourceRequest) return { status: 'invalid_path' as const };
      // Until all action-specific prepare/Go guards consume the effective action, do not persist a new action.
      if (request.field === 'action' && input.type !== 'field.accept') return { status: 'invalid_value' as const };
      const [owner] = await tx.select({ action: mailActionLabel.action }).from(mailActionLabel)
        .where(and(eq(mailActionLabel.transportId, input.transportId), eq(mailActionLabel.messageId, input.source.messageId),
          eq(mailActionLabel.source, 'owner'), eq(mailActionLabel.version, 'owner')))
        .orderBy(desc(mailActionLabel.updatedAt), desc(mailActionLabel.id)).limit(1);
      if (!(MAIL_KINDS as readonly string[]).includes(item.kind)) return { status: 'invalid_path' as const };
      const effective = effectiveActions(input.source, requestSource, item.state, isManual ? undefined : owner?.action, item.kind as MailKind,
        read?.attachments as AttachmentRead[] | null ?? null, payload.stays.length).find((entry) => entry.requestId === request.requestId);
      if (input.type !== 'field.accept' && !requestFieldApplies(request, effective?.action ?? null)) {
        return { status: 'invalid_path' as const };
      }
      const stay = sourceRequest.stay;
      const liveStay = formStays(payload, item.state).find((entry) => entry.id === stay.id);
      if (!liveStay) {
        return { status: 'invalid_path' as const };
      }
      if (request.rowId !== null) {
        const row = liveStay.rows.find((entry) => entry.id === request.rowId);
        const countPath = `stays[${stay.id}].rows[${request.rowId}].count`;
        const count = Object.hasOwn(item.state, countPath) ? item.state[countPath] : row?.rooms ?? null;
        const ownRow = !row && liveStay.rows.length === 0 && request.rowId === `${stay.id}_row`;
        // Room zero is an editable placeholder while the room count is unknown. Prepare still requires a real count.
        const partialFirstRoom = effective?.action === 'new_booking' && request.roomIndex === 0 && count === null;
        if ((!row && !ownRow) || (request.roomIndex !== null && !partialFirstRoom &&
            (typeof count !== 'number' || !Number.isInteger(count) || request.roomIndex >= count))) {
          return { status: 'invalid_path' as const };
        }
      }
      if (effective?.action === 'cancel') {
        if (item.kind !== 'cancellation' && item.kind !== 'amendment') return { status: 'invalid_path' as const };
        const current = projectCancelRequests(input.source, payload, item.state, owner?.action, item.kind);
        if (!current.requests.some((entry) => entry.requestId === request.requestId)) return { status: 'invalid_path' as const };
        const original = projectCancelRequests(input.source, payload, {}, owner?.action, item.kind)
          .requests.find((entry) => entry.requestId === request.requestId);
        aiValue = request.field === 'action' ? stay.action ?? (payload.stays.length === 1 ? payload.action : null) ?? null :
          request.field === 'target' ? original?.fields.value.target ?? null :
          request.field === 'cancel.note' ? original?.fields.value.cancellationNote ?? null : null;
      } else if (request.field === 'action') aiValue = stay.action ?? (payload.stays.length === 1 ? payload.action : null) ?? null;
      else if (request.field === 'target') {
        const confirmations = [...new Set((stay.guests ?? []).flatMap((guest) => guest.confirmationNumber ? [guest.confirmationNumber] : []))];
        const confirmation = confirmations.length === 1 ? confirmations[0] :
          confirmations.length === 0 && payload.stays.length === 1 && payload.confirmationNumbers.length === 1
            ? payload.confirmationNumbers[0] : null;
        aiValue = confirmation && stay.booked?.arrival ? { confirmation, arrival: stay.booked.arrival } : null;
      } else {
        const proposalKey: Record<string, keyof NonNullable<ExtractionStay['workflowProposal']>> = {
          firstName: 'firstName', lastName: 'lastName', guestEmail: 'guestEmail', guestMobile: 'guestMobile',
          bookerName: 'bookerName', bookerEmail: 'bookerEmail', ratePlan: 'ratePlan', sourceOfBusiness: 'sourceOfBusiness',
          track: 'track', guaranteeType: 'guaranteeType', reservationNote: 'reservationNote',
          'cms.send': 'cmsSend', 'cms.messageId': 'cmsMessageId', 'cms.recipient': 'cmsRecipient',
        };
        const proposal = stay.workflowProposal?.[proposalKey[request.field]!];
        aiValue = proposal ? request.field === 'cms.recipient' ? { mode: 'custom', address: proposal.value } : proposal.value
          : amendEmailValue(stay, request.field as AmendField);
      }
    } else {
      aiValue = aiValueAt(payload, input.fieldPath);
    }
    // The scaffold is a staff choice, not an extraction, including its booking action.
    if (isManual) aiValue = null;
    const value = input.type === 'field.accept' ? aiValue : personValue;
    // state holds only a person's values. An accept clears the path, so the AI value shows as the extraction.
    const state = { ...item.state };
    if (input.type === 'field.accept') delete state[input.fieldPath];
    else state[input.fieldPath] = value;
    const advanced = advancePaneRevision({
      revision: item.revision,
      revisionHead: item.revisionHead,
      seq: item.revisionSeq,
      previousState: item.state,
      nextState: state,
      extractionId: item.extractionId,
    });
    await tx.insert(workEvent).values({
      workItemId: input.workItemId,
      actorKind: 'user',
      actorUserId: input.userId,
      type: input.type,
      fieldPath: input.fieldPath,
      aiValue,
      value,
      aiSource: isManual ? null : read?.version ?? null,
      msSinceOpen: input.msSinceOpen ?? null,
      evidence: advanced.evidence,
    });
    await tx
      .update(workItem)
      .set({
        state,
        revision: advanced.revision,
        revisionHead: advanced.revisionHead,
        revisionSeq: item.revisionSeq + 1,
        updatedAt: new Date(),
      })
      .where(eq(workItem.id, input.workItemId));
    return {
      status: 'recorded' as const,
      aiValue,
      value,
      previousSeq: item.revisionSeq,
      seq: item.revisionSeq + 1,
      revision: advanced.revision,
      revisionHead: advanced.revisionHead,
      workItemExtractionId: item.extractionId,
    };
  });
}

export type StayCommitWriteResult = { status: 'recorded' } | { status: 'already_booked' } | { status: 'not_found' };

/**
 * Writes one stay's HMS commit into `state.stays[stayId]`. A stay that already has a confirmation number is left
 * as it is (the commit path refuses before a second save). An unknown outcome can later be replaced by a number.
 */
export async function recordStayCommit(
  db: DB,
  input: {
    transportId: string;
    workItemId: string;
    stayId: string;
    record: StayCommitRecord;
    /** Trusted server-owned identity, never supplied by pane or tool input. */
    fence?: CreateFenceIdentity;
  },
): Promise<StayCommitWriteResult> {
  if (!STAY_COMMIT_ID_PATTERN.test(input.stayId)) return { status: 'not_found' };
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    if (input.fence) {
      // Batch children require a separately verified server-owned manifest.
      if (input.fence.scope?.kind !== 'single' || input.fence.scope.stayId !== input.stayId) {
        throw new CreateFenceError('owner_mismatch');
      }
      await assertCreateDispatchFenceOwner(tx, input, input.fence);
    } else {
      await assertNoCreateDispatchFence(tx, input);
    }
    const existing = stayCommitOf(item.state, input.stayId);
    if (existing?.confirmationNumber) return { status: 'already_booked' as const };
    const state = withStayCommit(hydrateStoredWorkState(item.state), input.stayId, input.record);
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    return { status: 'recorded' as const };
  });
}

export async function recordStayActionResult(
  db: DB,
  input: {
    transportId: string;
    workItemId: string;
    stayId: string;
    confirmationNumber: string;
    screenshotRef: StayCommitScreenshotRef | null;
  },
): Promise<{ status: 'recorded' } | { status: 'not_found' }> {
  if (!STAY_COMMIT_ID_PATTERN.test(input.stayId)) return { status: 'not_found' };
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    await assertNoCreateDispatchFence(tx, input);
    const state = withStayActionResult(hydrateStoredWorkState(item.state), input.stayId, {
      confirmationNumber: input.confirmationNumber,
      screenshotRef: input.screenshotRef,
    });
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    return { status: 'recorded' as const };
  });
}

export async function loadStayCommit(
  db: DB,
  input: { transportId: string; workItemId: string; stayId: string },
): Promise<StayCommitRecord | undefined> {
  const [item] = await db
    .select({ state: workItem.state })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  return item ? stayCommitOf(item.state, input.stayId) : undefined;
}

/**
 * Logs field.accept for each extraction field a person proceeded with and never edited (v5 B2). A path that already has
 * an edit, reject or accept is skipped, as is one the extraction has no value for. The accepted value is the AI value.
 * It is an event only, never a state value (see recordFieldEvent), so an accepted field is not shown as a staff
 * correction when the read is reopened. Paths outside the item's extraction shape are ignored.
 */
export async function acceptUneditedFields(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; fieldPaths: string[] },
): Promise<{ status: 'not_found' } | { status: 'recorded'; accepted: number }> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ extractionId: workItem.extractionId, state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    if (Object.hasOwn(item.state, 'reservationWorkflowV2')) return { status: 'recorded' as const, accepted: 0 };
    const paths = [...new Set(input.fieldPaths)].filter(
      (path) => !path.endsWith('.removed') && (contactFieldOf(path) !== null || parseFieldPath(path) !== null),
    );
    if (!paths.length) return { status: 'recorded' as const, accepted: 0 };
    const storedPaths = paths.flatMap(storedFieldPathAliases);
    const seen = await tx
      .select({ path: workEvent.fieldPath })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, input.workItemId),
          inArray(workEvent.type, ['field.edit', 'field.reject', 'field.accept', 'field.reset']),
          inArray(workEvent.fieldPath, storedPaths),
        ),
      );
    const touched = new Set(seen.flatMap((row) => row.path === null ? [] : [hydrateStoredFieldPath(row.path)]));
    const [read] = item.extractionId
      ? await tx
          .select({ payload: mailExtraction.payload, version: mailExtraction.extractorVersion })
          .from(mailExtraction)
          .where(eq(mailExtraction.id, item.extractionId))
          .limit(1)
      : [];
    const parsedPayload = safeParseStoredMailExtraction(read?.payload);
    const payload = parsedPayload.success ? parsedPayload.data : null;
    const accepts = paths
      .filter((path) => !touched.has(path))
      .map((path) => ({
        path,
        aiValue: aiValueAt(payload, path),
      }))
      .filter((accept) => accept.aiValue !== null && accept.aiValue !== undefined);
    if (!accepts.length) return { status: 'recorded' as const, accepted: 0 };
    await tx.insert(workEvent).values(
      accepts.map((accept) => ({
        workItemId: input.workItemId,
        actorKind: 'user',
        actorUserId: input.userId,
        type: 'field.accept' as const,
        fieldPath: accept.path,
        aiValue: accept.aiValue,
        value: accept.aiValue,
        aiSource: read?.version ?? null,
      })),
    );
    return { status: 'recorded' as const, accepted: accepts.length };
  });
}

/**
 * The work item the pane edits for this mail (the kind of its latest read), or null when it has none yet. Notes find
 * their item here and never open one.
 */
export async function workItemIdForMail(
  db: DB,
  input: { transportId: string; internetMessageId: string; selection?: PaneSourceSelection; expectedMessageId?: string },
): Promise<string | null> {
  const msg = await messageFor(db, input);
  if (!msg) return null;
  const latest = await succeededRead(db, msg.id);
  if (!latest) return null;
  const [item] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        eq(workItem.threadId, msg.threadId),
        eq(workItem.kind, latest.kind),
        eq(workItem.sourceMessageId, msg.id),
      ),
    )
    .limit(1);
  return item?.id ?? null;
}

/** Dismisses an open item and logs the change. Only needs_you and review items dismiss. Null when not in transport. */
export async function dismissWorkItem(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string },
): Promise<{ status: string } | null> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ status: workItem.status })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return null;
    if (item.status !== 'needs_you' && item.status !== 'review') return { status: item.status };
    await tx
      .update(workItem)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(eq(workItem.id, input.workItemId));
    await tx.insert(workEvent).values({
      workItemId: input.workItemId,
      actorKind: 'user',
      actorUserId: input.userId,
      type: 'status.changed',
      value: { from: item.status, to: 'dismissed' },
    });
    return { status: 'dismissed' };
  });
}

/** Mail kinds allowed in the Needs-you list. */
export const NEEDS_YOU_KINDS = [
  'quote',
  'booking',
  'amendment',
  'cancellation',
  'voucher_pop',
] as const;

/** Kinds the 66h follow-up sweep considers. Quote clocks from a validity window; booking from an HMS confirmation send. */
export const FOLLOW_UP_WORK_KINDS = ['quote', 'booking'] as const;

/** The chips on a Needs-you row (KTD14), in list order: the list sorts by this index, then by age. */
export const NEEDS_YOU_CHIPS = ['needs_you', 'review', 'queued', 'in_hms'] as const;
export type NeedsYouChip = (typeof NEEDS_YOU_CHIPS)[number];

// Leaf copies of reservation-workflow-v2-state's key/readers: importing that module would close an import cycle.
const RESERVATION_WORKFLOW_V2_STATE_KEY = 'reservationWorkflowV2';
const RESERVATION_WORKFLOW_V2_INTAKE_KEY = 'reservationWorkflowV2Intake';

function hasReservationWorkflowV2Draft(state: Record<string, unknown>): boolean {
  return Object.hasOwn(state, RESERVATION_WORKFLOW_V2_STATE_KEY);
}

function reservationWorkflowV2DraftOf(state: Record<string, unknown>): ReservationWorkflowV2Draft | null {
  const parsed = reservationWorkflowV2DraftSchema.safeParse(
    hydrateStoredReservationWorkflowV2(state[RESERVATION_WORKFLOW_V2_STATE_KEY]));
  return parsed.success ? parsed.data : null;
}

/**
 * The sibling intake record's no-action claim, when it still binds the parsed draft. Every failure
 * returns null and keeps the row visible: an unparseable sidecar, a missing recorded evidence hash
 * (the live reader tolerates its absence; hiding a row never does), a raw model declaration that
 * never became the adjudicated decision, any decision other than host-adjudicated `no_action`, a
 * generation or stored source hash that moved on, a draft without the evidence baseline the record
 * was adjudicated against, or a draft that is not a complete, issue-free extraction — pending,
 * partial or failed extraction and surviving requests, operations, issues or errors can still hide
 * an unseen ask, so they are never read as affirmed no-action.
 */
function boundNoActionIntake(state: Record<string, unknown>, draft: ReservationWorkflowV2Draft): ReservationWorkflowV2Intake | null {
  const intake = reservationWorkflowV2IntakeSchema.safeParse(state[RESERVATION_WORKFLOW_V2_INTAKE_KEY]);
  if (!intake.success || intake.data.evidenceHash === undefined ||
      intake.data.evidenceHash !== draft.prefill?.evidenceHash) return null;
  const { decision, generationId, sourceHash } = intake.data.disposition;
  if (decision !== 'no_action' || generationId !== draft.generationId ||
      sourceHash !== draft.source.sourceHash) return null;
  if (draft.status !== 'ready' || !draft.extraction ||
      draft.extractionGenerationId !== draft.generationId ||
      draft.extraction.issues?.length ||
      draft.proposal.issues?.length ||
      draft.proposal.content.requests.length > 0 || draft.operationResults.length > 0 ||
      draft.errors.length > 0) return null;
  return intake.data;
}

/** The staff-queue kind of a V2 request kind; `services` and `other` asks stay review-needed. */
const V2_REQUEST_MAIL_KIND: Record<string, MailKind> = {
  quote: 'quote',
  create: 'booking',
  amend: 'amendment',
  cancel: 'cancellation',
  filing: 'voucher_pop',
};

/**
 * The Needs-you admission of a work item's canonical V2 draft. `actions` carries every distinct request kind in
 * draft order so the row names each ask; `kind` stays the first supported action for older readers. Unsupported,
 * empty or unreadable drafts stay visible as `other_actionable` with `reviewOnly: true` and no actions — an
 * unfinished, failed or ambiguous draft can still hide an unseen ask, so it never reads as affirmed no-action and
 * never invents an `other` task. Self-sent pre-stay mail is about an existing booking: a `create` request is never
 * an ask, so it is dropped from the actions; unless a still-bound host-adjudicated no-action already hid the row
 * upstream, it still lists rather than read as resolved. When no ask survives — an empty, create-only, pending or
 * failed draft — the row carries `reviewOnly` and no actions: it is for staff review, and `other` must not claim a
 * task no request supports.
 */
function needsYouV2Admission(draft: ReservationWorkflowV2Draft | null, isPreStay: boolean): { kind: string; actions: string[]; reviewOnly: boolean } {
  const kinds = [...new Set((draft?.proposal.content.requests ?? []).map((request) => request.kind))];
  const asks = isPreStay ? kinds.filter((kind) => kind !== 'create') : kinds;
  const reviewOnly = asks.length === 0;
  const actions = asks;
  for (const action of actions) {
    const kind = V2_REQUEST_MAIL_KIND[action];
    if (kind) return { kind, actions, reviewOnly };
  }
  return { kind: 'other_actionable', actions, reviewOnly };
}

/**
 * Work items in this transport with the given statuses, the Needs-you list. On legacy kinds, deterministic source
 * policy (`classifyMailSource`) decides whether a message is direct/reviewable or a skipped channel/system notice,
 * rather than trusting model-derived `origin`. Canonical V2 drafts are admitted on their own door and are never
 * hidden by model origin. Only quote, booking, amendment, cancellation and voucher_pop items are included, plus
 * grounded separate pre-stay requests. A self-sent pre-stay row whose separate-ask evidence is missing, failed or
 * ungrounded stays listed as `reviewOnly`: an unknown ask is never read as no-action. The one door that hides a V2
 * row is a host-adjudicated no-action intake record still bound to the canonical draft's generation, the message's
 * live source hash and the live arrival-evidence hash; every missing, stale or uncertain piece keeps the row listed.
 * Spam, trashed and deleted threads are left out. Queued and In HMS come from the item's latest run on the HMS lane
 * only (KTD14), so a follow-up or extraction run never moves the chip. Otherwise a review item shows Review, and
 * anything else needs her. Rows sort by chip in NEEDS_YOU_CHIPS order, then the oldest mail first.
 */
export async function listWorkItems(
  db: DB,
  input: { transportId: string; statuses: readonly string[]; limit: number; receivedSince?: Date },
) {
  if (input.statuses.length === 0 || input.limit <= 0) return [];
  // Every candidate page must see the same order and source data.
  return db.transaction(async (tx) => {
    const hmsRunState = sql`(select ${aiWorkflowRun.state} from ${aiWorkflowRun} where ${aiWorkflowRun.executorLane} = 'hms' and (${aiWorkflowRun.workItemId} = ${workItem.id} or ${aiWorkflowRun.metrics}->'sharedWorkItemIds' @> jsonb_build_array(${workItem.id}::text) or ${aiWorkflowRun.metrics}->'batchLinks' @> jsonb_build_array(jsonb_build_object('workItemId', ${workItem.id}::text))) order by ${aiWorkflowRun.createdAt} desc limit 1)`;
    const chipRank = sql<number>`case ${hmsRunState} when 'claimed' then 3 when 'running' then 3 when 'queued' then 2 when 'retry_wait' then 2 else case when ${workItem.status} = 'review' then 1 else 0 end end`
      .mapWith(Number);
    const sortAge = sql`coalesce(${message.receivedAt}, ${workItem.createdAt})`;
    const [mailbox] = await tx
      .select({ email: mailboxTransport.email })
      .from(mailboxTransport)
      .where(eq(mailboxTransport.id, input.transportId))
      .limit(1);
    const mailboxEmail = normalizeEmailAddress(mailbox?.email ?? '');
    // A self-prestay candidate must also reach the validator regardless of model
    // kind/origin: SQL admits the narrow superset (own mailbox sender + pre-stay
    // subject), and the shared validator enforces confirmation number + ask.
    const preStayCandidate = mailboxEmail === '' ? undefined : and(
      sql`strpos(lower(${message.fromAddress}), ${mailboxEmail}) > 0`,
      or(
        sql`${message.subject} ilike '%pre%stay%'`,
        sql`${message.subject} ilike '%pre%arrival%'`,
      ),
    );
    const fetchPage = (cursor: NeedsYouCursor | null, size: number) => tx
      .select({
        id: workItem.id,
        kind: workItem.kind,
        status: workItem.status,
        threadId: workItem.threadId,
        sourceMessageId: workItem.sourceMessageId,
        outlookEntryId:
          sql<string | null>`${message.sourceProvenance} #>> '{evidence,locator,entryId}'`,
        updatedAt: workItem.updatedAt,
        sender: message.fromAddress,
        subject: message.subject,
        receivedAt: message.receivedAt,
        confirmationNumbers: sql<unknown>`${mailExtraction.payload}->'confirmationNumbers'`,
        extractionPayload: mailExtraction.payload,
        sourceBody: message.textBody,
        sourceHtml: message.htmlBody,
        sourceProvenance: message.sourceProvenance,
        state: workItem.state,
        reopenReason: sql<string | null>`(
          select we.value->>'reasonLine'
          from ${workEvent} as we
          where we.work_item_id = ${workItem}.id
            and we.type = 'status.changed'
            and we.value->>'reason' = 'reply_needs_action'
          order by we.at desc, we.id desc
          limit 1
        )`,
        chipRank: chipRank.as('chip_rank'),
        // Preserve PostgreSQL's microseconds; JavaScript Date truncates them.
        sortAge: sql<string>`${sortAge}::text`,
      })
      .from(workItem)
      .innerJoin(mailThread, eq(mailThread.id, workItem.threadId))
      .leftJoin(message, eq(message.id, workItem.sourceMessageId))
      .leftJoin(mailExtraction, eq(mailExtraction.id, workItem.extractionId))
      .where(
        and(
          eq(workItem.transportId, input.transportId),
          inArray(workItem.status, [...input.statuses]),
          or(
            ...(preStayCandidate ? [preStayCandidate] : []),
            inArray(workItem.kind, [...NEEDS_YOU_KINDS, 'other']),
            // A canonical V2 draft is its own admission: every stored request kind reaches the queue.
            sql`${workItem.state} ? ${RESERVATION_WORKFLOW_V2_STATE_KEY}`,
          ),
          isNull(mailThread.spamAt),
          isNull(mailThread.trashedAt),
          ...(input.receivedSince ? [gte(message.receivedAt, input.receivedSince)] : []),
          ...(cursor ? [sql`(${chipRank}, ${sortAge}, ${workItem.id}) > (${cursor.rank}, ${cursor.age}::timestamp, ${cursor.id}::uuid)`] : []),
        ),
      )
      .orderBy(sql`chip_rank`, asc(sortAge), asc(workItem.id))
      .limit(size);
    // One queue row per source: when a source message has canonical V2 drafts, only the draft-bearing item the
    // ensure path would reopen (latest updated, then id) represents the mail; legacy and stale duplicate rows hide.
    // Probed per candidate page so the lookup stays proportional to the page, not mailbox history.
    const canonicalV2BySource = new Map<string, { id: string; updatedAt: Date }>();
    const fileAttachmentMessageIds = new Set<string>();
    // Rows whose host-adjudicated no-action survived every binding check below. Only a draft-bearing
    // item's own row can land here, and only after live source/evidence hashes re-verify — the same
    // full inputs the reservationWorkflowV2 live reader uses (message row, causal thread, files,
    // optional-missing provenance), read inside this same repeatable-read transaction.
    const boundNoAction = new Set<string>();
    const fetchPageWithDrafts = async (cursor: NeedsYouCursor | null, size: number) => {
      const rows = await fetchPage(cursor, size);
      const sourceIds = [...new Set(rows.map((row) => row.sourceMessageId).filter((id): id is string => id !== null))];
      if (sourceIds.length === 0) return rows;
      const [drafts, fileAttachments] = await Promise.all([
        tx
          .select({ id: workItem.id, sourceMessageId: workItem.sourceMessageId, updatedAt: workItem.updatedAt })
          .from(workItem)
          .where(and(
            eq(workItem.transportId, input.transportId),
            inArray(workItem.sourceMessageId, sourceIds),
            sql`${workItem.state} ? ${RESERVATION_WORKFLOW_V2_STATE_KEY}`,
          )),
        tx
          .selectDistinct({ messageId: attachment.messageId })
          .from(attachment)
          .where(and(inArray(attachment.messageId, sourceIds), eq(attachment.isInline, false))),
      ]);
      for (const att of fileAttachments) {
        fileAttachmentMessageIds.add(att.messageId);
      }
      for (const draft of drafts) {
        if (!draft.sourceMessageId) continue;
        const current = canonicalV2BySource.get(draft.sourceMessageId);
        if (!current || draft.updatedAt.getTime() > current.updatedAt.getTime()
            || (draft.updatedAt.getTime() === current.updatedAt.getTime() && draft.id > current.id)) {
          canonicalV2BySource.set(draft.sourceMessageId, { id: draft.id, updatedAt: draft.updatedAt });
        }
      }
      const candidates: { row: (typeof rows)[number]; draft: ReservationWorkflowV2Draft; intake: ReservationWorkflowV2Intake }[] = [];
      for (const row of rows) {
        const state = row.state as Record<string, unknown> | null;
        if (!row.sourceMessageId || !state) continue;
        const draft = reservationWorkflowV2DraftOf(state);
        if (!draft || draft.workItemId !== row.id ||
            draft.source.messageId !== row.sourceMessageId || draft.source.threadId !== row.threadId) continue;
        const intake = boundNoActionIntake(state, draft);
        if (intake) candidates.push({ row, draft, intake });
      }
      if (candidates.length === 0) return rows;
      const candidateIds = [...new Set(candidates.map(({ row }) => row.sourceMessageId!))];
      const liveRows = await tx.select({ id: message.id, subject: message.subject,
          textBody: message.textBody, htmlBody: message.htmlBody, direction: message.direction,
          historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
          arrivedAt: MESSAGE_ARRIVED_AT,
          threadHistoryOnly: mailThread.historyOnly, threadTrashedAt: mailThread.trashedAt,
          threadSpamAt: mailThread.spamAt })
        .from(message)
        .innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
        .where(and(inArray(message.id, candidateIds), eq(message.transportId, input.transportId)));
      const liveById = new Map(liveRows.map((row) => [row.id, row]));
      const evidence = await reservationArrivalEvidenceBatch(tx, candidateIds);
      for (const { row, draft, intake } of candidates) {
        const live = row.sourceMessageId ? liveById.get(row.sourceMessageId) : undefined;
        if (live && live.direction === 'inbound' && live.historyOnly === false &&
            live.threadHistoryOnly === false && live.threadTrashedAt === null && live.threadSpamAt === null &&
            live.sourceProvenance?.attention == null &&
            live.arrivedAt instanceof Date && live.arrivedAt.toISOString() === draft.source.arrivedAt &&
            staffQuoteSourceHash(live) === draft.source.sourceHash &&
            evidence.get(row.sourceMessageId!)?.hash === intake.evidenceHash) {
          boundNoAction.add(row.id);
        }
      }
      return rows;
    };
    return collectNeedsYouPages({
      limit: input.limit,
      fetchPage: fetchPageWithDrafts,
      validate: ({ chipRank: rank, sortAge: _sortAge, confirmationNumbers, extractionPayload, sourceBody, sourceHtml, sourceProvenance, state, ...row }) => {
        const parsedPayload = safeParseStoredMailExtraction(extractionPayload);
        const payload = parsedPayload.success ? parsedPayload.data : null;
        const sourceText = preStaySourceText(sourceBody, sourceHtml);
        const sourceBodyText = canonicalSourceBodyText({ textBody: sourceBody, htmlBody: sourceHtml });
        // The same self-prestay evidence the ensure/prefill door uses: a confirmation number may live only in
        // the body, so a missing or empty extraction must not turn real pre-stay mail into a channel/system hide.
        const sourceConfirmationNumbers = `${row.subject ?? ''}\n${sourceText}`.match(/\b\d{6,10}-\d{1,4}\b/g) ?? [];
        const preStayAsk = selfSentPreStayAskVerdict({
          fromAddress: row.sender,
          mailboxAddress: mailbox?.email,
          subject: row.subject,
          textBody: sourceBody,
          htmlBody: sourceHtml,
          confirmationNumbers: [
            ...(Array.isArray(confirmationNumbers)
              ? confirmationNumbers.filter((value): value is string => typeof value === 'string')
              : []),
            ...sourceConfirmationNumbers,
          ],
          payload,
        });
        const chip = NEEDS_YOU_CHIPS[rank] ?? 'needs_you';
        const hasAttachments = row.sourceMessageId
          ? fileAttachmentPresence(fileAttachmentMessageIds.has(row.sourceMessageId), sourceProvenance)
          : undefined;
        const v2 = hasReservationWorkflowV2Draft(state ?? {});
        const canonicalV2Id = row.sourceMessageId ? canonicalV2BySource.get(row.sourceMessageId)?.id : undefined;
        if (canonicalV2Id !== undefined && (!v2 || canonicalV2Id !== row.id)) return null;
        if (v2) {
          // A host-adjudicated no-action hides the row only while it is still bound: to the canonical
          // draft's generation and stored source hash, to the message's live source hash and to the
          // live arrival-evidence hash. Everything else — missing sidecar or evidence, stale source
          // or evidence, incomplete or unparseable extraction, requests, operations, issues, errors,
          // or an uncertain or actionable decision — stays listed for staff review.
          if (boundNoAction.has(row.id)) return null;
          // The same deterministic source door the ensure/prefill paths keep: a known channel/system source never
          // queues (self-sent pre-stay is handled inside the admission — it is an automated notice by nature yet
          // its separate asks stay reviewable). The stored extraction's `origin` is optional model output with no
          // binding to this source or generation, so it never hides a V2 draft: anything uncertain stays reviewable.
          if (!preStayAsk && classifyMailSource({ fromAddress: row.sender,
              subject: row.subject, bodyText: sourceBodyText, hasAttachments }).kind !== 'direct') return null;
          const admission = needsYouV2Admission(reservationWorkflowV2DraftOf(state ?? {}), preStayAsk !== null);
          return { ...row, kind: admission.kind, chip, actions: admission.actions,
            ...(admission.reviewOnly ? { reviewOnly: true } : {}) };
        }
        if (!preStayAsk) {
          if (classifyMailSource({ fromAddress: row.sender, subject: row.subject, bodyText: sourceBodyText, hasAttachments }).kind !== 'direct') {
            return null;
          }
          if (row.kind === 'other') {
            if (payload?.needsAction === true) {
              return { ...row, kind: 'other_actionable', chip, actions: ['other'], reviewOnly: true };
            }
            return { ...row, kind: 'other_actionable', chip, actions: [], reviewOnly: true };
          }
          if (!NEEDS_YOU_KINDS.includes(row.kind as (typeof NEEDS_YOU_KINDS)[number])) {
            return null;
          }
          return { ...row, chip };
        }
        const separateAsk = preStayAsk.status === 'ask' ? preStayAsk.excerpt : null;
        if (separateAsk) return { ...row, kind: 'other_actionable', chip };
        return { ...row, kind: 'other_actionable', chip, actions: [], reviewOnly: true };
      },
    });
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export type WorkItemSection = { type: 'contact' } | { type: 'stay'; stayId: string };
export type ResetWorkSectionResult =
  | { status: 'not_found' }
  | { status: 'invalid_section' }
  | { status: 'invalid_cursor' }
  | { status: 'stale' }
  | { status: 'recorded'; reset: number; revision?: number; revisionHead?: number; seq?: number; extractionId?: string | null };

/** Restores extraction-backed overrides in one contact or stay section and logs each cleared field atomically. */
export async function resetWorkSection(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; section: WorkItemSection;
    expectedSeq?: number; expectedExtractionId?: string | null },
): Promise<ResetWorkSectionResult> {
  if (input.section.type === 'stay' && !STAY_ID_PATTERN.test(input.section.stayId)) {
    return { status: 'invalid_section' };
  }
  if ((input.expectedSeq === undefined) !== (input.expectedExtractionId === undefined)) {
    return { status: 'invalid_cursor' };
  }
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        extractionId: workItem.extractionId,
        threadId: workItem.threadId,
        sourceMessageId: workItem.sourceMessageId,
        kind: workItem.kind,
        state: workItem.state,
        revision: workItem.revision,
        revisionHead: workItem.revisionHead,
        revisionSeq: workItem.revisionSeq,
      })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    if (input.expectedSeq !== undefined &&
        (input.expectedSeq !== item.revisionSeq || input.expectedExtractionId !== item.extractionId)) {
      return { status: 'stale' as const };
    }
    const recorded = (reset: number, revision = item.revision, revisionHead = item.revisionHead, seq = item.revisionSeq) =>
      ({ status: 'recorded' as const, reset, ...(input.expectedSeq !== undefined
        ? { revision, revisionHead, seq, extractionId: item.extractionId } : {}) });

    item.state = hydrateStoredWorkState(item.state);
    const paths = Object.keys(item.state).filter((fieldPath) => {
      if (input.section.type === 'contact') return contactFieldOf(fieldPath) !== null;
      return parseFieldPath(fieldPath)?.stayId === input.section.stayId;
    });
    const requestPaths = input.section.type === 'stay'
      ? Object.keys(item.state).flatMap((fieldPath) => {
        const field = parseRequestField(fieldPath);
        return field && field.field !== 'action' ? [{ fieldPath, field }] : [];
      }) : [];
    if (!paths.length && !requestPaths.length) return recorded(0);

    const [read] = item.extractionId
      ? await tx
          .select({ payload: mailExtraction.payload, version: mailExtraction.extractorVersion,
            messageId: mailExtraction.messageId, kind: mailExtraction.kind, status: mailExtraction.status })
          .from(mailExtraction)
          .where(eq(mailExtraction.id, item.extractionId))
          .limit(1)
      : [];
    const parsedPayload = safeParseStoredMailExtraction(read?.payload);
    const payload = parsedPayload.success ? parsedPayload.data : null;
    const resets = paths
      .map((fieldPath) => ({
        fieldPath,
        aiValue: aiValueAt(payload, fieldPath),
      }))
      .filter((field) => field.aiValue !== null && field.aiValue !== undefined);
    if (input.section.type === 'stay' && requestPaths.length && read?.status === 'succeeded' &&
        read.messageId === item.sourceMessageId && read.kind === item.kind && item.threadId && item.sourceMessageId) {
      const stayId = input.section.stayId;
      const stay = payload?.stays.find((candidate) => candidate.id === stayId);
      const action = stay?.action ?? (payload?.stays.length === 1 ? payload.action : null) ??
        (item.kind === 'booking' ? 'new_booking' : null);
      const [mail] = await tx.select({ id: message.id, subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody })
        .from(message).where(and(eq(message.id, item.sourceMessageId), eq(message.transportId, input.transportId),
          eq(message.threadId, item.threadId), eq(message.direction, 'inbound'))).limit(1);
      if (stay && action === 'new_booking' && mail && item.extractionId) {
        const requestId = requestIdFor({ threadId: item.threadId, messageId: mail.id,
          sourceHash: staffQuoteSourceHash(mail) }, stay.id, 'primary');
        for (const entry of requestPaths) {
          if (entry.field.requestId !== requestId) continue;
          const aiValue = createRequestSourceValue(stay, entry.field);
          if (aiValue !== null && aiValue !== undefined) resets.push({ fieldPath: entry.fieldPath, aiValue });
        }
      }
    }
    if (!resets.length) return recorded(0);

    const state = { ...item.state };
    for (const { fieldPath } of resets) delete state[fieldPath];
    const advanced = advancePaneRevision({
      revision: item.revision,
      revisionHead: item.revisionHead,
      seq: item.revisionSeq,
      previousState: item.state,
      nextState: state,
      extractionId: item.extractionId,
    });
    await tx.insert(workEvent).values(
      resets.map(({ fieldPath, aiValue }) => ({
        workItemId: input.workItemId,
        actorKind: 'user',
        actorUserId: input.userId,
        type: 'field.reset' as const,
        fieldPath,
        aiValue,
        value: aiValue,
        aiSource: read?.version ?? null,
        evidence: advanced.evidence,
      })),
    );
    await tx
      .update(workItem)
      .set({
        state,
        revision: advanced.revision,
        revisionHead: advanced.revisionHead,
        revisionSeq: item.revisionSeq + 1,
        updatedAt: new Date(),
      })
      .where(eq(workItem.id, input.workItemId));
    return recorded(resets.length, advanced.revision, advanced.revisionHead, item.revisionSeq + 1);
  });
}

export {
  advancePaneRevision,
  loadPaneRevisionCursor,
  redoWorkItemRevision,
  undoWorkItemRevision,
} from './work-item-revision.js';
