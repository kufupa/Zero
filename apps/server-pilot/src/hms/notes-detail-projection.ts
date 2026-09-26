/**
 * Project Guest Stay detail dump note fields → bounded notes observations.
 * Live dump (2026-09-12 AfL0kuXg) proved keys: reservationnote, cancellationnote.
 * Traces tab / dedicated trace grid remain SURFACE_UNPROVEN until separate dump.
 */
import type { ReservationDetailDumpV1 } from './reservation-detail-projection.js';
import type { NotesTraceItem, NotesTracesContextData } from './context-read-contracts.js';
import { createHash } from 'node:crypto';

const NOTE_FIELD_SPECS = [
  { key: 'reservationnote', sourceKind: 'note' as const, noteRefSuffix: 'reservationnote' },
  { key: 'cancellationnote', sourceKind: 'note' as const, noteRefSuffix: 'cancellationnote' },
] as const;

const MAX_PERMITTED_TEXT = 2000;
const MASKED_VALUES = new Set([
  'protected',
  'hidden',
  'masked',
  'redacted',
  'not authorized',
  'not authorised',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/^ff_/, '').replace(/^filter_/, '');
}

type NoteValue =
  | { state: 'absent' | 'empty' }
  | { state: 'masked' }
  | { state: 'value'; text: string };

function valueFor(dump: ReservationDetailDumpV1, key: string): NoteValue {
  const present = new Set(dump.keys.map(normalizeKey));
  if (!present.has(key)) return { state: 'absent' };
  const raw = dump.values?.[key] ?? dump.values?.[key.toLowerCase()];
  if (typeof raw !== 'string') return { state: 'empty' };
  const trimmed = raw.trim();
  if (!trimmed) return { state: 'empty' };
  if (MASKED_VALUES.has(trimmed.toLowerCase())) return { state: 'masked' };
  return {
    state: 'value',
    text: trimmed.length > MAX_PERMITTED_TEXT ? trimmed.slice(0, MAX_PERMITTED_TEXT) : trimmed,
  };
}

function knownFact(
  value: unknown,
  evidenceRef: string,
  observedAt: string,
  expiresAt: string,
): NotesTraceItem['sourceKind'] {
  return {
    state: 'known',
    value,
    data: value,
    evidenceRef,
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

function unknownFact(
  evidenceRef: string,
  observedAt: string,
  expiresAt: string,
): NotesTraceItem['dueAt'] {
  return {
    state: 'unknown',
    value: null,
    data: null,
    reasonCode: 'NOT_APPLICABLE',
    evidenceRef,
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

export type ProjectedNotesFromDetail = {
  data: NotesTracesContextData;
  claimKeys: string[];
  tracesStatus: 'unavailable';
  tracesReasonCode: 'SURFACE_UNPROVEN';
  notesReasonCode: 'SOURCE_UNAVAILABLE' | 'POLICY_UNAPPROVED';
};

/** Map dump-proved reservation/cancellation notes; never invent absent keys. */
export function projectNotesFromDetailDump(
  dump: ReservationDetailDumpV1,
  input: {
    resourceRef: string;
    evidenceRef: string;
    observedAt: Date;
    expiresAt: Date;
    limit: number;
  },
): ProjectedNotesFromDetail {
  const observedAt = input.observedAt.toISOString();
  const expiresAt = input.expiresAt.toISOString();
  const items: NotesTraceItem[] = [];
  const claimKeys: string[] = [];
  let sawMasked = false;

  for (const spec of NOTE_FIELD_SPECS) {
    if (items.length >= input.limit) break;
    const value = valueFor(dump, spec.key);
    if (value.state === 'masked') {
      sawMasked = true;
      continue;
    }
    if (value.state !== 'value') continue;
    const text = value.text;
    const noteRef = `note:${spec.noteRefSuffix}:${createHash('sha256')
      .update(`${input.resourceRef}|${spec.key}|${text}`)
      .digest('hex')
      .slice(0, 32)}`;
    items.push({
      noteRef,
      resourceRef: input.resourceRef,
      sourceKind: knownFact(spec.sourceKind, input.evidenceRef, observedAt, expiresAt),
      permittedText: knownFact(text, input.evidenceRef, observedAt, expiresAt),
      // Detail form notes are staff observations until a disclosable flag is dump-proved.
      audience: knownFact('staff_only', input.evidenceRef, observedAt, expiresAt),
      customerPrintable: knownFact(false, input.evidenceRef, observedAt, expiresAt),
      status: knownFact('open', input.evidenceRef, observedAt, expiresAt),
      dueAt: unknownFact(input.evidenceRef, observedAt, expiresAt),
      deliveredAt: unknownFact(input.evidenceRef, observedAt, expiresAt),
      method: unknownFact(input.evidenceRef, observedAt, expiresAt),
      authorLabel: unknownFact(input.evidenceRef, observedAt, expiresAt),
      createdAt: knownFact(observedAt, input.evidenceRef, observedAt, expiresAt),
    });
    claimKeys.push(`notes.${spec.key}`);
  }

  if (items.length === 0) {
    return {
      data: {
        notes: {
          state: 'unavailable',
          data: null,
          reasonCode: sawMasked ? 'POLICY_UNAPPROVED' : 'SOURCE_UNAVAILABLE',
          issues: [
            {
              code: sawMasked ? 'POLICY_UNAPPROVED' : 'SOURCE_UNAVAILABLE',
              retryable: false,
              safeNextAction: 'manual_review',
            },
          ],
        },
      },
      claimKeys: [],
      tracesStatus: 'unavailable',
      tracesReasonCode: 'SURFACE_UNPROVEN',
      notesReasonCode: sawMasked ? 'POLICY_UNAPPROVED' : 'SOURCE_UNAVAILABLE',
    };
  }

  return {
    data: {
      notes: {
        items,
        page: { returnedCount: items.length, hasMore: false, nextCursor: null },
      },
    },
    claimKeys,
    tracesStatus: 'unavailable',
    tracesReasonCode: 'SURFACE_UNPROVEN',
    notesReasonCode: sawMasked ? 'POLICY_UNAPPROVED' : 'SOURCE_UNAVAILABLE',
  };
}
