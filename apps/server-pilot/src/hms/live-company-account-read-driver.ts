/**
 * Reservation-linked company billing observer (Task 16).
 * Safe linked surfaces lack billingMode / paymentTermClass / contractStatus
 * (2026-08-06 OSRESS/OSACCT; reprove 2026-08-07 exact OSRESS.find → SOB keys
 * only: company, companyname, bookingagency*, channel*, marketsegment*,
 * sourceofbusiness*, group* — trio absent). Fail closed — never open editable
 * company screens or arbitrary profile search. Folio stays independent.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import type { ReadCandidateChild } from './candidate-graph.js';
import {
  COMPANY_ACCOUNT_READ_SURFACE_BLOCKER,
  type CompanyAccountReadData,
} from './company-account-read-contract.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HRCEN_PROPERTY_CODE } from './property-registry.js';
import { HmsRuntimeError } from './runtime.js';

export { COMPANY_ACCOUNT_READ_SURFACE_BLOCKER };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertCompanyAuth(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  propertyCode: string,
): void {
  if (authorization.toolId !== 'hms_company_account_read') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for company observer',
    );
  }
  if (
    authorization.discoveryOperationId !== 'reservation_linked_company_billing'
  ) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId mismatch',
    );
  }
  if (authorization.requestBranchId !== 'reservation_linked_company_billing') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for company observer',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (child.toolId !== authorization.toolId) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child toolId does not match authorization',
    );
  }
  if (child.requestBranchId !== authorization.requestBranchId) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child requestBranchId does not match authorization',
    );
  }
  if (Date.parse(child.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'candidate child expired');
  }
  if (child.propertyCode !== propertyCode) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child propertyCode denied',
    );
  }
}

/**
 * Live company billing read — structurally blocked until view-only billing
 * mode / payment terms / contract status exist on a reservation-linked surface.
 * Arbitrary profile search is unavailable by design.
 */
export async function observeReservationLinkedBilling(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  signal: AbortSignal,
  propertyCode = HRCEN_PROPERTY_CODE,
): Promise<ToolResult<CompanyAccountReadData>> {
  if (signal.aborted) {
    const err = new Error('company observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertCompanyAuth(authorization, child, propertyCode);
  const observedAt = new Date().toISOString();
  return {
    status: 'manual_required',
    draftReady: false,
    data: {} as CompanyAccountReadData,
    unresolvedFields: [COMPANY_ACCOUNT_READ_SURFACE_BLOCKER],
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_company_account_read',
      toolVersion: '1.0.0',
      propertyCode,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(COMPANY_ACCOUNT_READ_SURFACE_BLOCKER),
    },
  };
}

export function createLiveCompanyAccountReadDriver(
  propertyCode = HRCEN_PROPERTY_CODE,
): {
  observeReservationLinkedBilling: typeof observeReservationLinkedBilling;
} {
  return {
    observeReservationLinkedBilling: (authorization, child, signal) =>
      observeReservationLinkedBilling(authorization, child, signal, propertyCode),
  };
}
