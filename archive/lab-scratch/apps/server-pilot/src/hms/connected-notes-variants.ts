/**
 * Fixed, private connected-runner notes probes.
 *
 * These are not model-facing inputs. The runner supplies the already-bound
 * reservation resource and this helper emits only the two reviewed audience
 * probes plus one bounded staff continuation probe.
 */

export const CONNECTED_NOTES_MAX_PAGE_CALLS = 6;

export type ConnectedNotesVariantRequest = {
  resourceRef: string;
  states: Array<'open' | 'completed'>;
  limit: number;
  cursor?: string;
  audience: 'staff' | 'customer';
};

export type ConnectedNotesVariantReadResult = {
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

export type ConnectedNotesVariantReceipt = {
  request: {
    audience: 'staff' | 'customer';
    states: Array<'open' | 'completed'>;
    limit: number;
    cursorPresent: boolean;
  };
  status: string | null;
  completeness: 'complete' | 'partial' | 'unknown';
  scopeMatches: boolean;
  page: ConnectedNotesVariantReadResult['page'];
  evidenceSourceHashes: string[];
  unavailableSections: string[];
  issueCodes: string[];
};

export type ConnectedNotesVariant = {
  variant:
    | 'staff_all_states'
    | 'customer_all_states'
    | 'staff_limit1_paging'
    | 'staff_open_only'
    | 'staff_completed_only';
  audience: 'staff' | 'customer';
  states: Array<'open' | 'completed'>;
  limit: number;
  status: string;
  stopReason:
    | 'single_page'
    | 'exhausted'
    | 'max_calls'
    | 'source_failure'
    | 'source_incomplete'
    | 'repeated_cursor'
    | 'cursor_mismatch'
    | 'scope_mismatch';
  calls: ConnectedNotesVariantReceipt[];
};

type VariantExecutor = (
  request: ConnectedNotesVariantRequest,
) => Promise<ConnectedNotesVariantReadResult | null>;

type VariantInput = {
  resourceRef: string;
  execute: VariantExecutor;
};

const sourceFailureCodes = new Set(['SOURCE_UNAVAILABLE', 'SIZE_LIMIT', 'TIMEOUT', 'SCOPE_DENIED']);
const cursorMismatchCodes = new Set(['STALE_EVIDENCE', 'UNSUPPORTED_FORMAT']);

function hasBoundedPartialContinuation(result: ConnectedNotesVariantReadResult): boolean {
  const page = result.page;
  return (
    result.status === 'partial' &&
    result.completeness === 'partial' &&
    page?.hasMore === true &&
    typeof page.nextCursor === 'string' &&
    page.nextCursor.trim().length > 0 &&
    result.unavailableSections.length === 0 &&
    result.issues.length > 0 &&
    result.issues.every((issue) => issue.code === 'PARTIAL_WINDOW')
  );
}

function validPageShape(
  page: ConnectedNotesVariantReadResult['page'],
): page is NonNullable<ConnectedNotesVariantReadResult['page']> {
  if (page === null) return false;
  if (!Number.isInteger(page.returnedCount) || page.returnedCount < 0 || page.returnedCount > 50) {
    return false;
  }
  if (page.hasMore === true) {
    return typeof page.nextCursor === 'string' && page.nextCursor.trim().length > 0;
  }
  return page.nextCursor === null;
}

function receipt(
  request: ConnectedNotesVariantRequest,
  result: ConnectedNotesVariantReadResult | null,
): ConnectedNotesVariantReceipt {
  return {
    request: {
      audience: request.audience,
      states: [...request.states],
      limit: request.limit,
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

function resultFailureReason(
  result: ConnectedNotesVariantReadResult | null,
  request: ConnectedNotesVariantRequest,
): ConnectedNotesVariant['stopReason'] | null {
  if (!result) return 'source_failure';
  if (result.scopeRef !== request.resourceRef) return 'scope_mismatch';
  const issueCodes = new Set([
    ...result.issues.map((issue) => issue.code),
    ...result.unavailableSections.map((section) => section.reasonCode),
  ]);
  if ([...issueCodes].some((code) => cursorMismatchCodes.has(code))) {
    return request.cursor === undefined ? 'source_failure' : 'cursor_mismatch';
  }
  if ([...issueCodes].some((code) => sourceFailureCodes.has(code))) return 'source_failure';
  if (
    ['manual_required', 'not_found', 'ambiguous', 'unverified_negative', 'unknown'].includes(
      result.status,
    )
  ) {
    return 'source_failure';
  }
  if (!validPageShape(result.page)) return 'source_incomplete';
  if (hasBoundedPartialContinuation(result)) return null;
  if (result.status !== 'ok' || result.completeness !== 'complete' || result.page.hasMore !== false) {
    return 'source_incomplete';
  }
  return null;
}

async function executeSafely(
  execute: VariantExecutor,
  request: ConnectedNotesVariantRequest,
): Promise<ConnectedNotesVariantReadResult | null> {
  try {
    return await execute(request);
  } catch {
    return null;
  }
}

async function runSingleVariant(
  input: VariantInput,
  spec: {
    variant: 'staff_all_states' | 'customer_all_states' | 'staff_open_only' | 'staff_completed_only';
    audience: 'staff' | 'customer';
    states: Array<'open' | 'completed'>;
  },
): Promise<ConnectedNotesVariant> {
  const request: ConnectedNotesVariantRequest = {
    resourceRef: input.resourceRef,
    states: [...spec.states],
    limit: 20,
    audience: spec.audience,
  };
  const result = await executeSafely(input.execute, request);
  const call = receipt(request, result);
  const failure = resultFailureReason(result, request);
  return {
    variant: spec.variant,
    audience: spec.audience,
    states: [...request.states],
    limit: request.limit,
    status:
      failure && result?.status === 'ok'
        ? 'manual_required'
        : (result?.status ?? 'manual_required'),
    stopReason: failure ?? 'single_page',
    calls: [call],
  };
}

async function runPagingVariant(input: VariantInput): Promise<ConnectedNotesVariant> {
  const base: Omit<ConnectedNotesVariantRequest, 'cursor'> = {
    resourceRef: input.resourceRef,
    states: ['open', 'completed'],
    limit: 1,
    audience: 'staff',
  };
  const calls: ConnectedNotesVariantReceipt[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let status = 'manual_required';
  let stopReason: ConnectedNotesVariant['stopReason'] = 'max_calls';

  for (let index = 0; index < CONNECTED_NOTES_MAX_PAGE_CALLS; index += 1) {
    const request: ConnectedNotesVariantRequest =
      cursor === undefined ? { ...base } : { ...base, cursor };
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        stopReason = 'repeated_cursor';
        break;
      }
      seenCursors.add(cursor);
    }
    const result = await executeSafely(input.execute, request);
    calls.push(receipt(request, result));
    const failure = resultFailureReason(result, request);
    status =
      failure && result?.status === 'ok'
        ? 'manual_required'
        : (result?.status ?? 'manual_required');
    if (failure) {
      stopReason = failure;
      break;
    }
    const page = result?.page;
    if (!page) {
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
    if (!page.nextCursor) {
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
    variant: 'staff_limit1_paging',
    audience: 'staff',
    states: [...base.states],
    limit: base.limit,
    status,
    stopReason,
    calls,
  };
}

export async function runConnectedNotesVariants(
  input: VariantInput,
): Promise<ConnectedNotesVariant[]> {
  return [
    await runSingleVariant(input, {
      variant: 'staff_all_states',
      audience: 'staff',
      states: ['open', 'completed'],
    }),
    await runSingleVariant(input, {
      variant: 'customer_all_states',
      audience: 'customer',
      states: ['open', 'completed'],
    }),
    await runPagingVariant(input),
    await runSingleVariant(input, {
      variant: 'staff_open_only',
      audience: 'staff',
      states: ['open'],
    }),
    await runSingleVariant(input, {
      variant: 'staff_completed_only',
      audience: 'staff',
      states: ['completed'],
    }),
  ];
}
