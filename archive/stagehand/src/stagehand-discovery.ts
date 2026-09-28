/** Development-only reviewed commands. Model observations never become scripts. */
import {
  matchesExternalReferenceCandidate,
  type GuestStaySearchResult,
  type ReservationSearchCandidate,
} from './live-guest-stay-driver.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { buildBoundFolioReadFields } from './folio-read-facade.js';
import type { RequestRule } from './contracts.js';
import { z } from 'zod';

export const stagehandDiscoveryCommandSchema = z
  .object({
    action: z.enum([
      'folio',
      'traces',
      'notes',
      'capture',
      'close',
      'open_menu',
      'front_desk',
      'account',
      'guest_stay',
      'search_parent',
      'open_parent',
      'folio_all_view',
      'folio_all_run',
      'folio_all_next',
      'property_ledger',
      'advance_deposit',
      'deposit_schedule',
    ]),
  })
  .strict();

export function discoveryTabLabel(action: 'folio' | 'traces' | 'notes'): string {
  return { folio: 'Folio', traces: 'Traces', notes: 'Notes' }[action];
}

/** Per-owner control secret. Keep only in private owner evidence. */
export function createStagehandControlToken(): string {
  return randomBytes(32).toString('hex');
}

/** Exact Bearer match without exposing token bytes to ordinary equality. */
export function stagehandBearerTokenMatches(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(authorization.slice(7)).digest();
  const expected = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(supplied, expected);
}

export type StagehandParentHints = {
  confirmationNumber: string | null;
  externalReference: string | null;
  reservationStayId: string | null;
};

/** Small private parent record shape used by the model-free action client. */
export type StagehandParentRecord = {
  marker: string;
  candidate: ReservationSearchCandidate;
  hints?: StagehandParentHints;
  manualIdUsed: boolean;
  goldAnswerUsed: boolean;
};

export type StagehandParentCellObservation = {
  text?: string | null;
  /** Text from nested static-text/structured-value children. */
  nestedTexts?: readonly string[];
  /** Provider cell tokens, when DOM exposes them separately from text. */
  tokens?: readonly string[];
};

function nonBlank(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sameIdentity(left: string | null, right: unknown): boolean {
  return (
    left !== null && typeof right === 'string' && left.toUpperCase() === right.trim().toUpperCase()
  );
}

function identityTokenPresent(text: unknown, expected: string): boolean {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (value.length === 0) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Require token boundaries. `hasText` alone is unsafe: e.g. CONF-1 must
  // not match CONF-10. Delimiters may join confirmation + external values in
  // one rendered cell, so boundary matching is intentionally not whitespace-
  // only, but remains exact-token rather than substring matching.
  return new RegExp(`(?:^|[^A-Za-z0-9._:-])${escaped}(?:$|[^A-Za-z0-9._:-])`, 'iu').test(value);
}

/**
 * Verify one unique rendered row contains exact bound confirmation and, when
 * available, exact bound external reference. Caller must separately enforce
 * unique row count; this pure helper only checks row identity tokens.
 */
export function stagehandParentRowMatchesExactIdentity(input: {
  confirmationNumber: string | null;
  externalReference: string | null;
  cells: readonly StagehandParentCellObservation[];
}): boolean {
  const confirmation = nonBlank(input.confirmationNumber);
  const external = nonBlank(input.externalReference);
  if (!confirmation || !Array.isArray(input.cells) || input.cells.length === 0) return false;
  // This renderer places the confirmation text node directly beside a nested
  // external-reference span/suffix, without a whitespace separator. Accept
  // only the complete, already-bound pair as the entire cell, never a prefix.
  if (external && input.cells.some((cell) =>
    typeof cell.text === 'string' &&
    cell.text.trim().toUpperCase() === `${confirmation}${external}`.toUpperCase()
  )) return true;
  const cellTexts = input.cells.flatMap((cell) => [
    cell.text,
    ...(cell.nestedTexts ?? []),
    ...(cell.tokens ?? []),
  ]);
  const confirmationMatched = cellTexts.some((text) => identityTokenPresent(text, confirmation));
  const externalMatched =
    external === null || cellTexts.some((text) => identityTokenPresent(text, external));
  return confirmationMatched && externalMatched;
}

/**
 * Turn one parsed, live OSRESS match into parent evidence. Pure: no I/O,
 * mutation, or model use. Caller owns parsing and private persistence.
 */
export function confirmStagehandParentFromSearch<T extends StagehandParentRecord>(input: {
  parent: T;
  ownerMarker: string;
  search: GuestStaySearchResult;
  hints: StagehandParentHints;
}): T & { hints: StagehandParentHints } {
  if (
    typeof input.ownerMarker !== 'string' ||
    input.ownerMarker.trim().length === 0 ||
    input.parent.marker !== input.ownerMarker
  ) {
    throw new Error('CONNECTED_PARENT_MISMATCH');
  }
  if (input.parent.manualIdUsed !== false || input.parent.goldAnswerUsed !== false) {
    throw new Error('CONNECTED_PARENT_SOURCE_MISMATCH');
  }
  if (
    input.search.outcome !== 'matched' ||
    !Array.isArray(input.search.observations) ||
    input.search.observations.length !== 1
  ) {
    throw new Error('CONNECTED_SEARCH_NOT_UNIQUE');
  }

  const confirmationNumber = nonBlank(input.hints?.confirmationNumber);
  const externalReference = nonBlank(input.hints?.externalReference);
  if (!confirmationNumber && !externalReference) {
    throw new Error('CONNECTED_PARENT_IDENTITY_REQUIRED');
  }
  const observation = input.search.observations[0]!;
  const candidateMatchesObservation =
    input.parent.candidate.kind === 'confirmation'
      ? sameIdentity(input.parent.candidate.value, observation.confirmationNumber)
      : input.parent.candidate.kind === 'external_reference'
        ? matchesExternalReferenceCandidate(
            input.parent.candidate.value,
            observation.externalReference,
            true,
          )
        : true;
  if (
    !candidateMatchesObservation ||
    (confirmationNumber && !sameIdentity(confirmationNumber, observation.confirmationNumber)) ||
    (externalReference && !sameIdentity(externalReference, observation.externalReference))
  ) {
    throw new Error('CONNECTED_PARENT_IDENTITY_MISMATCH');
  }

  const hints: StagehandParentHints = {
    confirmationNumber,
    externalReference,
    reservationStayId: nonBlank(input.hints?.reservationStayId),
  };
  return { ...input.parent, hints };
}

/** Bind the reviewed FOL template to the one live, correlated parent. */
export function bindStagehandFolioRule(
  template: RequestRule,
  input: {
    confirmationNumber: string;
    reservationStayId: string;
    /** Exact, independently correlated OSRESV.LST row fields, when available. */
    hdrFields?: Record<string, string>;
  },
): RequestRule {
  if (template.id !== 'live-folio-osresv-fol') throw new Error('FOLIO_RULE_TEMPLATE_REQUIRED');
  const confirmationNumber = nonBlank(input.confirmationNumber);
  const reservationStayId = nonBlank(input.reservationStayId);
  const validIdentity = (value: string | null): value is string =>
    value !== null && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  if (!validIdentity(confirmationNumber) || !validIdentity(reservationStayId))
    throw new Error('FOLIO_PARENT_BINDING_REQUIRED');
  if (input.hdrFields) {
    const keys = [
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'confirmationnumber',
      'reservationstayid',
      'propertycode',
      'guestfullname',
      'account',
      'guestid',
      'hoteldate',
      'lastname',
      'firstname',
      'twitterid',
      'facebookid',
      'tripadvisorid',
      'bookingdotcomid',
      'room',
    ] as const;
    const fixedBody: Record<string, string> = {};
    for (const key of keys) {
      const value = input.hdrFields[key];
      if (value === undefined) throw new Error('FOLIO_PARENT_BINDING_REQUIRED');
      fixedBody[key] = value;
    }
    if (
      fixedBody.SYSTEM_FUNCTION_NAME !== 'OSRESV' ||
      fixedBody.USER_FUNCTION_NAME !== 'OSRESV' ||
      fixedBody.propertycode !== 'HRCEN' ||
      fixedBody.confirmationnumber !== confirmationNumber ||
      fixedBody.reservationstayid !== reservationStayId
    )
      throw new Error('FOLIO_PARENT_BINDING_REQUIRED');
    const boundFields = buildBoundFolioReadFields({
      confirmationNumber,
      reservationStayId,
      expectedPropertyCode: 'HRCEN',
      detailValues: fixedBody,
    });
    return { ...template, fixedBody: boundFields, variableBody: {} };
  }
  return {
    ...template,
    fixedBody: {
      ...template.fixedBody,
      confirmationnumber: confirmationNumber,
      reservationstayid: reservationStayId,
      id: reservationStayId,
    },
    variableBody: {},
  };
}
