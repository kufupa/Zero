import type { ReservationDetailDumpV1 } from '../../../../../../apps/server-pilot/src/hms/reservation-detail-projection.js';

export type ConnectedRunnerDetailResult = {
  status: string;
  completeness: string;
  scopeRef: string | null | undefined;
  evidence?: readonly ConnectedRunnerDetailEvidence[];
};

/** Minimal evidence shape copied from the closed read result boundary. */
export type ConnectedRunnerDetailEvidence = {
  evidenceRef?: string | null;
  artifactRef?: string | null;
  scopeVerified?: boolean;
};

export type ConnectedRunnerParentBinding = {
  reservationRef: string | null;
  detailDump: ReservationDetailDumpV1 | null;
  confirmationToken: string | null;
  reservationStayId: string | null;
  parentEvidenceId: string | null;
};

function emptyBinding(): ConnectedRunnerParentBinding {
  return {
    reservationRef: null,
    detailDump: null,
    confirmationToken: null,
    reservationStayId: null,
    parentEvidenceId: null,
  };
}

function detailValue(
  dump: ReservationDetailDumpV1 | null,
  key: string,
): string | null {
  const values = dump?.values;
  if (!values) return null;
  const matches = Object.entries(values).filter(([name]) => name.toLowerCase() === key);
  if (matches.length !== 1) return null;
  const value = matches[0]?.[1];
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * Keep child reads linked to the actual, scoped detail receipt. A missing or
 * unverified receipt is intentionally not replaced with a generated UUID.
 */
export function connectedRunnerParentEvidenceId(
  detail: ConnectedRunnerDetailResult | null | undefined,
): string | null {
  if (!detail || detail.status !== 'ok' || detail.completeness !== 'complete') {
    return null;
  }
  const evidence = detail.evidence?.find(
    (entry) =>
      entry.scopeVerified === true &&
      Boolean(entry.evidenceRef?.trim() || entry.artifactRef?.trim()),
  );
  return evidence?.evidenceRef?.trim() || evidence?.artifactRef?.trim() || null;
}

/**
 * Commit only a complete, scope-matched detail read. Any failed, missing, or
 * mismatched input returns an empty binding, so callers cannot retain a prior
 * reservation across a repeated find.
 */
export function bindConnectedRunnerParent(input: {
  reservationRef: string | null | undefined;
  detailResult: ConnectedRunnerDetailResult | null;
  detailDump: ReservationDetailDumpV1 | null;
  reservationStayId: string | null | undefined;
  parentEvidenceId: string | null | undefined;
}): ConnectedRunnerParentBinding {
  const reservationRef = input.reservationRef?.trim() || null;
  const reservationStayId = input.reservationStayId?.trim() || null;
  const parentEvidenceId = input.parentEvidenceId?.trim() || null;
  const confirmationToken = detailValue(input.detailDump, 'confirmationnumber');
  const detailStayId = detailValue(input.detailDump, 'reservationstayid');
  const detail = input.detailResult;
  if (
    !reservationRef ||
    !detail ||
    detail.status !== 'ok' ||
    detail.completeness !== 'complete' ||
    detail.scopeRef !== reservationRef ||
    !input.detailDump?.values ||
    !reservationStayId ||
    detailStayId !== reservationStayId ||
    !confirmationToken ||
    !parentEvidenceId
  ) {
    return emptyBinding();
  }
  return {
    reservationRef,
    detailDump: input.detailDump,
    confirmationToken,
    reservationStayId,
    parentEvidenceId,
  };
}

export function isConnectedRunnerParentBound(
  binding: ConnectedRunnerParentBinding,
  reservationRef: string | null | undefined,
): boolean {
  const expectedRef = reservationRef?.trim() || null;
  return Boolean(
      expectedRef &&
      binding.reservationRef === expectedRef &&
      binding.detailDump?.values &&
      detailValue(binding.detailDump, 'confirmationnumber') === binding.confirmationToken &&
      detailValue(binding.detailDump, 'reservationstayid') === binding.reservationStayId &&
      binding.confirmationToken &&
      binding.reservationStayId &&
      binding.parentEvidenceId,
  );
}
