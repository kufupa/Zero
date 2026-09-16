import {
  reservationContextReadResultSchema,
  reservationContextSections,
  reservationFindResultSchema,
  type ReservationContextSection,
  type ReservationMatch,
} from './reservation-context-contract.js';
import {
  knownFact,
  readIssue,
  readRefSchema,
  unknownFact,
  type ReadFact,
  type ReadSection,
} from './read-service-contracts.js';
import type { LinkedContextReferenceKind } from './context-read-reference.js';
import { isSentinelGuestName } from '../ops/hms-find-match-compare.js';
import { randomUUID } from 'node:crypto';

export interface ReservationContextLookup {
  transportId: string;
  mailboxId: string;
  threadId: string;
  triggerMessageId: string;
  parentRef: string;
  branchId: string;
  propertyCode: string;
  candidateId: string;
  referenceKind: 'confirmation' | 'external' | 'surname_dates';
  value: string;
  observedAt: Date | string;
  expiresAt: Date | string;
}

export interface ReservationRow {
  confirmationNumber: string | null;
  externalReference: string | null;
  guestName: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  reservationStatus: string | null;
  roomType: string | null;
  ratePlan: string | null;
  /** Explicit source adapter output; arbitrary row keys never mint context authority. */
  linkedContextRefs?: Partial<Record<LinkedContextReferenceKind, string>>;
  [key: string]: unknown;
}

export type ReservationLookupResult =
  | {
      status: 'matched';
      row: ReservationRow;
      evidenceRef?: string;
      observedAt?: Date | string;
      expiresAt?: Date | string;
    }
  | {
      status: 'ambiguous';
      rows: ReservationRow[];
      evidenceRef?: string;
      observedAt?: Date | string;
      expiresAt?: Date | string;
    }
  | {
      status: 'not_found';
      evidenceRef?: string;
      observedAt?: Date | string;
      expiresAt?: Date | string;
    }
  | {
      status: 'unverified_negative';
      evidenceRef?: string;
      observedAt?: Date | string;
      expiresAt?: Date | string;
    };

export type ReservationContextLookupFn = (
  input: ReservationContextLookup,
) => Promise<ReservationLookupResult>;

export type ReservationContextReader = (
  input: ReservationContextLookup & {
    reservationRef: string;
    sections: ReservationContextSection[];
    detail?: 'summary' | 'detail';
  },
  row: ReservationRow,
) => Promise<Partial<Record<ReservationContextSection, unknown>>>;

interface RefBinding {
  reservationRef: string;
  lookup: ReservationContextLookup;
  row: ReservationRow;
  observedAt: Date | string;
  expiresAt: Date | string;
  evidenceRef: string;
}

type FacadeOptions = {
  now: () => Date;
  lookup: ReservationContextLookupFn;
  readContext: ReservationContextReader;
  /** Trusted worker binding for a persisted, opaque reservation reference. */
  reservationRefFor?: (input: ReservationContextLookup, row: ReservationRow) => string;
  /** Emit only explicit source-linked U15 references to the trusted executor seam. */
  linkedContextReferenceSink?: (input: {
    kind: LinkedContextReferenceKind;
    sourceRef: string;
    observedAt: Date | string;
    expiresAt: Date | string;
  }) => void;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function errorWithCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function safeRef(): string {
  // The token contains no PMS identifier.  It is intentionally opaque and
  // only meaningful within this process's binding table.
  return `resref_${randomUUID()}`;
}

function evidence(
  ref: string,
  input: ReservationContextLookup,
  observedAt: Date | string,
  expiresAt: Date | string,
) {
  return {
    evidenceRef: readRefSchema.parse(ref),
    sourceSystem: 'hms' as const,
    sourceSurface: 'reservation-context',
    requestBranchId: input.branchId,
    observedAt: iso(observedAt),
    sourceUpdatedAt: null,
    expiresAt: iso(expiresAt),
    scopeVerified: true,
    artifactRef: null,
  };
}

function fact<T>(
  value: T | null | undefined,
  evidenceRef: string,
  observedAt: Date | string,
  expiresAt: Date | string,
): ReadFact<T> {
  if (value === null || value === undefined || value === '') {
    return unknownFact({ reasonCode: 'SOURCE_UNAVAILABLE', evidenceRef, observedAt, expiresAt });
  }
  return knownFact({ value, evidenceRef, observedAt, expiresAt });
}

function retainFact<T>(
  value: unknown,
  evidenceRef: string,
  observedAt: Date | string,
  expiresAt: Date | string,
): ReadFact<T> {
  if (value && typeof value === 'object' && 'state' in value) return value as ReadFact<T>;
  return fact(value as T | null | undefined, evidenceRef, observedAt, expiresAt);
}

function matchLabelFor(
  row: ReservationRow,
  ambiguous: boolean,
  evidenceRef: string,
  observedAt: Date | string,
  expiresAt: Date | string,
): ReadFact<string> {
  // Ambiguous rows must not expose guest names or a selectable identifier.
  if (ambiguous) {
    return fact('reservation match', evidenceRef, observedAt, expiresAt);
  }
  const raw = typeof row.guestName === 'string' ? row.guestName.trim() : '';
  if (!raw || isSentinelGuestName(raw)) {
    return unknownFact({
      reasonCode: 'SOURCE_UNAVAILABLE',
      evidenceRef,
      observedAt,
      expiresAt,
    });
  }
  return fact(raw, evidenceRef, observedAt, expiresAt);
}

function matchFor(
  row: ReservationRow,
  input: ReservationContextLookup,
  reservationRef: string | null,
  evidenceRef: string,
  observedAt: Date | string,
  expiresAt: Date | string,
  ambiguous: boolean,
): ReservationMatch {
  const referenceKind = row.externalReference ? 'external' : 'confirmation';
  return {
    reservationRef,
    label: matchLabelFor(row, ambiguous, evidenceRef, observedAt, expiresAt),
    referenceKind: fact(referenceKind, evidenceRef, observedAt, expiresAt),
    status: fact(row.reservationStatus, evidenceRef, observedAt, expiresAt),
    arrival: fact(row.arrivalDate, evidenceRef, observedAt, expiresAt),
    departure: fact(row.departureDate, evidenceRef, observedAt, expiresAt),
    roomType: fact(row.roomType, evidenceRef, observedAt, expiresAt),
    matchEvidenceRefs: [evidenceRef],
  } as ReservationMatch;
}

function requestedSection(
  section: ReservationContextSection,
  raw: unknown,
  row: ReservationRow,
  binding: RefBinding,
): ReadSection<unknown> {
  const rawRecord = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const state = rawRecord.status;
  if (state === 'unavailable' || state === 'not_requested') {
    return {
      state: state as 'unavailable' | 'not_requested',
      data: null,
      reasonCode: (rawRecord.reasonCode as never) ?? 'SOURCE_UNAVAILABLE',
      issues: [],
    };
  }
  if (state === 'partial') {
    return {
      state: 'partial',
      data: normalizeSectionData(section, rawRecord, row, binding),
      completeness: 'partial',
      issues: [readIssue('PARTIAL_WINDOW', 'manual_review')],
    };
  }
  return {
    state: 'available',
    data: normalizeSectionData(section, rawRecord, row, binding),
    completeness: 'complete',
    issues: [],
  };
}

function normalizeSectionData(
  section: ReservationContextSection,
  raw: Record<string, unknown>,
  row: ReservationRow,
  binding: RefBinding,
): unknown {
  const ev = binding.evidenceRef;
  const at = binding.observedAt;
  const until = binding.expiresAt;
  const value = (name: string, fallback?: unknown) => raw[name] ?? fallback;

  if (raw.data !== undefined) return raw.data;
  if (section === 'core') {
    return {
      confirmation: retainFact(value('confirmation', row.confirmationNumber), ev, at, until),
      externalReference: retainFact(
        value('externalReference', row.externalReference),
        ev,
        at,
        until,
      ),
      status: retainFact(value('reservationStatus', row.reservationStatus), ev, at, until),
      guestRefs: retainFact(value('guestRefs'), ev, at, until),
      organizationRef: retainFact(value('organizationRef'), ev, at, until),
      agencyRef: retainFact(value('agencyRef'), ev, at, until),
      groupRef: retainFact(value('groupRef'), ev, at, until),
    };
  }
  if (section === 'stay') {
    return {
      arrival: retainFact(value('arrival', row.arrivalDate), ev, at, until),
      departure: retainFact(value('departure', row.departureDate), ev, at, until),
      roomType: retainFact(value('roomType', row.roomType), ev, at, until),
      roomQuantity: retainFact(value('roomQuantity'), ev, at, until),
      adults: retainFact(value('adults'), ev, at, until),
      childAges: retainFact(value('childAges'), ev, at, until),
      additionalGuests: retainFact(value('additionalGuests'), ev, at, until),
    };
  }
  if (section === 'rates') return { items: value('items', []), page: null };
  if (section === 'policies') {
    return {
      guarantee: retainFact(value('guarantee'), ev, at, until),
      deposit: retainFact(value('deposit'), ev, at, until),
      cancellation: retainFact(value('cancellation'), ev, at, until),
      policyVersion: retainFact(value('policyVersion'), ev, at, until),
    };
  }
  return { items: value('items', []), page: null };
}

export function createReservationContextFacade(options: FacadeOptions) {
  const bindings = new Map<string, RefBinding>();

  async function findReservation(input: ReservationContextLookup) {
    const result = await options.lookup(input);
    const observedAt = result.observedAt ?? input.observedAt;
    const expiresAt = result.expiresAt ?? input.expiresAt;
    const evidenceRef = result.evidenceRef ?? `hms-evidence-${randomUUID()}`;
    const rows =
      result.status === 'matched' ? [result.row] : result.status === 'ambiguous' ? result.rows : [];
    const matches = rows.map((row) => {
      if (result.status !== 'matched')
        return matchFor(row, input, null, evidenceRef, observedAt, expiresAt, true);
      const reservationRef = options.reservationRefFor?.(input, row) ?? safeRef();
      readRefSchema.parse(reservationRef);
      const linkedContextRefs = row.linkedContextRefs;
      if (linkedContextRefs) {
        for (const [kind, sourceRef] of Object.entries(linkedContextRefs)) {
          if (
            (kind === 'company' || kind === 'group' || kind === 'event' || kind === 'notes') &&
            typeof sourceRef === 'string' &&
            sourceRef.length > 0
          ) {
            options.linkedContextReferenceSink?.({
              kind,
              sourceRef,
              observedAt,
              expiresAt,
            });
          }
        }
      }
      bindings.set(reservationRef, {
        reservationRef,
        lookup: input,
        row,
        observedAt,
        expiresAt,
        evidenceRef,
      });
      return matchFor(row, input, reservationRef, evidenceRef, observedAt, expiresAt, false);
    });
    const response = {
      toolId: 'hms_find_reservation' as const,
      schemaVersion: 'reservation-find/1' as const,
      status:
        result.status === 'matched'
          ? ('ok' as const)
          : result.status === 'ambiguous'
            ? ('ambiguous' as const)
            : result.status === 'unverified_negative'
              ? ('unverified_negative' as const)
              : ('not_found' as const),
      data: { matches, matchCount: matches.length, capped: false },
      completeness: 'complete' as const,
      unavailableSections: [],
      scopeRef: input.parentRef,
      evidence: [evidence(evidenceRef, input, observedAt, expiresAt)],
      page: null,
      issues:
        result.status === 'not_found'
          ? [readIssue('SOURCE_UNAVAILABLE', 'request_input')]
          : result.status === 'unverified_negative'
            ? [readIssue('UNVERIFIED_NEGATIVE', 'manual_review')]
            : [],
    };
    return reservationFindResultSchema.parse(response);
  }

  async function readReservation(
    input: ReservationContextLookup & {
      reservationRef: string;
      sections: ReservationContextSection[];
      detail?: 'summary' | 'detail';
    },
  ) {
    let ref: string;
    try {
      ref = readRefSchema.parse(input.reservationRef);
    } catch {
      throw errorWithCode('RESERVATION_REF_NOT_FOUND', 'reservation reference is not known');
    }
    const binding = bindings.get(ref);
    if (!binding)
      throw errorWithCode('RESERVATION_REF_NOT_FOUND', 'reservation reference is not known');
    const expiry = Date.parse(iso(binding.expiresAt));
    if (!Number.isFinite(expiry) || options.now().getTime() >= expiry) {
      bindings.delete(ref);
      throw errorWithCode('RESERVATION_REF_EXPIRED', 'reservation reference has expired');
    }
    const sameScope = [
      'transportId',
      'mailboxId',
      'threadId',
      'triggerMessageId',
      'parentRef',
      'branchId',
      'propertyCode',
    ].every(
      (key) =>
        input[key as keyof ReservationContextLookup] ===
        binding.lookup[key as keyof ReservationContextLookup],
    );
    if (!sameScope)
      throw errorWithCode(
        'RESERVATION_REF_BINDING_MISMATCH',
        'reservation reference scope does not match',
      );

    const sections = [...new Set(input.sections)] as ReservationContextSection[];
    const rawSections = await options.readContext(input, binding.row);
    const data = {} as Record<ReservationContextSection, ReadSection<unknown>>;
    for (const section of reservationContextSections) {
      if (!sections.includes(section)) {
        data[section] = {
          state: 'not_requested',
          data: null,
          reasonCode: 'NOT_REQUESTED',
          issues: [],
        };
      } else {
        data[section] = requestedSection(section, rawSections[section], binding.row, binding);
      }
    }
    const unavailableSections = sections
      .filter((section) => data[section].state === 'unavailable')
      .map((section) => ({
        section,
        reasonCode: (data[section] as unknown as { reasonCode: never }).reasonCode,
      }));
    const status =
      unavailableSections.length === 0
        ? 'ok'
        : unavailableSections.length === sections.length
          ? 'partial'
          : 'partial';
    return reservationContextReadResultSchema.parse({
      toolId: 'hms_read_reservation' as const,
      schemaVersion: 'reservation-context/1',
      status,
      data,
      completeness: unavailableSections.length === 0 ? 'complete' : 'partial',
      unavailableSections,
      scopeRef: ref,
      evidence: [
        evidence(binding.evidenceRef, binding.lookup, binding.observedAt, binding.expiresAt),
      ],
      page: null,
      issues: unavailableSections.length ? [readIssue('SOURCE_UNAVAILABLE', 'manual_review')] : [],
    });
  }

  return { findReservation, readReservation };
}

export type ReservationContextFacade = ReturnType<typeof createReservationContextFacade>;
