/**
 * Tax Invoice / document-list live driver.
 * Tax Invoice display-only list stays blocked until tenant function code is proven.
 * Sent-document metadata reuses the shared PSSNEL observer + toSentDocumentMetadata.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import type { ReadCandidateChild } from './candidate-graph.js';
import {
  documentListReadDataSchema,
  type DocumentListReadData,
} from './document-list-contract.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HmsRuntimeError } from './runtime.js';
import {
  createLiveSentEmailObserver,
  toSentDocumentMetadata,
  type LiveSentEmailObserverInput,
  type MinimizedSentEmailRows,
} from './live-sent-email-observer.js';

export const TAX_INVOICE_SURFACE_BLOCKER =
  'BLOCKED_TAX_INVOICE_SURFACE_UNPROVEN' as const;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function emptyTaxInvoiceData(observedAt: string): DocumentListReadData {
  return documentListReadDataSchema.parse({
    sourceClass: 'finalized_tax_invoice',
    rows: [],
    inventoryComplete: false,
    rowsScanned: 0,
    bytesObserved: 0,
    durationMs: 0,
    observedAt,
  });
}

function taxInvoiceBlockedResult(
  observedAt: string,
): ToolResult<DocumentListReadData> {
  return {
    status: 'manual_required',
    draftReady: false,
    data: emptyTaxInvoiceData(observedAt),
    unresolvedFields: [TAX_INVOICE_SURFACE_BLOCKER],
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_list_documents',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt,
      expiresAt: new Date(
        Date.parse(observedAt) + 60 * 60 * 1000,
      ).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(TAX_INVOICE_SURFACE_BLOCKER),
    },
  };
}

function assertTaxAuth(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
): void {
  if (authorization.toolId !== 'hms_list_documents') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId must be hms_list_documents',
    );
  }
  if (authorization.discoveryOperationId !== 'tax_invoice_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId mismatch for tax invoice',
    );
  }
  if (authorization.requestBranchId !== 'tax_invoice_documents') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for tax invoice',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (
    child.toolId !== 'hms_list_documents' ||
    child.requestBranchId !== 'tax_invoice_documents'
  ) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child binding mismatch for tax invoice',
    );
  }
  if (Date.parse(child.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'candidate child expired');
  }
}

/**
 * Live Tax Invoice metadata observer.
 * Fail-closed: tenant discovery did not prove a Tax Invoice function code
 * (Front Desk > Tax Invoice absent from role menu; OSTXI/PSTXI/… returned 400).
 */
export async function observeTaxInvoiceMetadata(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  signal: AbortSignal,
): Promise<ToolResult<DocumentListReadData>> {
  if (signal.aborted) {
    const err = new Error('tax-invoice observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertTaxAuth(authorization, child);
  return taxInvoiceBlockedResult(new Date().toISOString());
}

export type LiveDocumentListDriver = {
  observeTaxInvoiceMetadata(
    authorization: HmsSessionAuthorization,
    child: ReadCandidateChild,
    signal: AbortSignal,
  ): Promise<ToolResult<DocumentListReadData>>;
  observeSentDocumentMetadata(
    authorization: HmsSessionAuthorization,
    child: ReadCandidateChild,
    signal: AbortSignal,
  ): Promise<ToolResult<DocumentListReadData>>;
};

export function createLiveDocumentListDriver(
  input: LiveSentEmailObserverInput,
): LiveDocumentListDriver {
  const sentObserver = createLiveSentEmailObserver(input);
  return {
    observeTaxInvoiceMetadata,
    async observeSentDocumentMetadata(authorization, child, signal) {
      const rows: MinimizedSentEmailRows =
        await sentObserver.observeSentEmailRows(authorization, child, signal);
      return toSentDocumentMetadata(rows);
    },
  };
}
