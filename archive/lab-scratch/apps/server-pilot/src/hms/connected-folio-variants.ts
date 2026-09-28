/**
 * Optional connected-runner probe for the proven transactions page.  The
 * ordinary folio read is deliberately unchanged; this helper only follows a
 * provider continuation when explicitly enabled by the private runner.
 */

export const CONNECTED_FOLIO_MAX_PAGE_CALLS = 4;

export type ConnectedFolioPagingRequest = {
  resourceRef: string;
  sections: ['transactions'];
  limit: 50;
  cursor?: string;
};

export type ConnectedFolioPagingReadResult = {
  status: string;
  completeness: 'complete' | 'partial' | 'unknown';
  scopeRef: string;
  page: {
    returnedCount: number;
    hasMore: boolean | null;
    nextCursor: string | null;
  } | null;
  evidence: ReadonlyArray<{ sourceHash?: string }>;
  unavailableSections: ReadonlyArray<{ section: string; reasonCode: string }>;
  issues: ReadonlyArray<{ code: string }>;
};

export type ConnectedFolioPagingReceipt = {
  request: {
    sections: ['transactions'];
    limit: 50;
    cursorPresent: boolean;
  };
  status: string | null;
  completeness: 'complete' | 'partial' | 'unknown';
  scopeMatches: boolean;
  page: ConnectedFolioPagingReadResult['page'];
  evidenceSourceHashes: string[];
  unavailableSections: string[];
  issueCodes: string[];
};

export type ConnectedFolioPagingVariant = {
  variant: 'transactions_limit50_paging';
  sections: ['transactions'];
  limit: 50;
  status: string;
  stopReason:
    | 'exhausted'
    | 'max_calls'
    | 'source_failure'
    | 'source_incomplete'
    | 'repeated_cursor'
    | 'cursor_mismatch'
    | 'scope_mismatch';
  calls: ConnectedFolioPagingReceipt[];
};

type VariantExecutor = (
  request: ConnectedFolioPagingRequest,
) => Promise<ConnectedFolioPagingReadResult | null>;

type VariantInput = {
  resourceRef: string;
  execute: VariantExecutor;
};

const sourceFailureCodes = new Set(['SOURCE_UNAVAILABLE', 'SIZE_LIMIT', 'TIMEOUT', 'SCOPE_DENIED']);
const cursorMismatchCodes = new Set(['STALE_EVIDENCE', 'UNSUPPORTED_FORMAT']);

function receipt(
  request: ConnectedFolioPagingRequest,
  result: ConnectedFolioPagingReadResult | null,
): ConnectedFolioPagingReceipt {
  return {
    request: {
      sections: ['transactions'],
      limit: 50,
      cursorPresent: request.cursor !== undefined,
    },
    status: result?.status ?? null,
    completeness: result?.completeness ?? 'unknown',
    scopeMatches: result?.scopeRef === request.resourceRef,
    page: result?.page ?? null,
    evidenceSourceHashes:
      result?.evidence
        .map((evidence) => evidence.sourceHash)
        .filter((value): value is string => typeof value === 'string') ?? [],
    unavailableSections:
      result?.unavailableSections.map((section) => `${section.section}:${section.reasonCode}`) ??
      [],
    issueCodes: result?.issues.map((issue) => issue.code) ?? [],
  };
}

function failureReason(
  result: ConnectedFolioPagingReadResult | null,
  request: ConnectedFolioPagingRequest,
): ConnectedFolioPagingVariant['stopReason'] | null {
  if (!result) return 'source_failure';
  if (result.scopeRef !== request.resourceRef) return 'scope_mismatch';
  const codes = new Set([
    ...result.issues.map((issue) => issue.code),
    ...result.unavailableSections.map((section) => section.reasonCode),
  ]);
  if ([...codes].some((code) => cursorMismatchCodes.has(code))) {
    return request.cursor === undefined ? 'source_failure' : 'cursor_mismatch';
  }
  if ([...codes].some((code) => sourceFailureCodes.has(code))) return 'source_failure';
  if (result.status !== 'ok') return 'source_failure';
  if (result.completeness !== 'complete') return 'source_incomplete';
  return null;
}

async function executeSafely(
  execute: VariantExecutor,
  request: ConnectedFolioPagingRequest,
): Promise<ConnectedFolioPagingReadResult | null> {
  try {
    return await execute(request);
  } catch {
    return null;
  }
}

export async function runConnectedFolioPagingVariant(
  input: VariantInput,
): Promise<ConnectedFolioPagingVariant> {
  const calls: ConnectedFolioPagingReceipt[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let status = 'manual_required';
  let stopReason: ConnectedFolioPagingVariant['stopReason'] = 'max_calls';

  for (let index = 0; index < CONNECTED_FOLIO_MAX_PAGE_CALLS; index += 1) {
    const request: ConnectedFolioPagingRequest =
      cursor === undefined
        ? { resourceRef: input.resourceRef, sections: ['transactions'], limit: 50 }
        : {
            resourceRef: input.resourceRef,
            sections: ['transactions'],
            limit: 50,
            cursor,
          };
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        stopReason = 'repeated_cursor';
        break;
      }
      seenCursors.add(cursor);
    }
    const result = await executeSafely(input.execute, request);
    calls.push(receipt(request, result));
    const failure = failureReason(result, request);
    status = result?.status ?? 'manual_required';
    if (failure) {
      stopReason = failure;
      break;
    }
    const page = result?.page;
    if (!page || page.returnedCount < 0 || page.returnedCount > 50) {
      stopReason = 'source_failure';
      break;
    }
    if (page.hasMore === false) {
      stopReason = 'exhausted';
      break;
    }
    if (page.hasMore === null) {
      stopReason = 'source_incomplete';
      break;
    }
    if (!page.nextCursor || page.nextCursor.length > 1000) {
      stopReason = 'source_failure';
      break;
    }
    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      stopReason = 'repeated_cursor';
      break;
    }
    cursor = page.nextCursor;
  }

  return {
    variant: 'transactions_limit50_paging',
    sections: ['transactions'],
    limit: 50,
    status,
    stopReason,
    calls,
  };
}
