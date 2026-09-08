/**
 * Live group-block aggregate observer (Task 17).
 * GSGRPB.LST proven for exact ref/status/dates, but con/blk/pickup/remaining
 * rows require BLK/detail load (empty without selected record). Fail closed.
 * Observations never emit recipientClass/inquiryClass, contacts, or rooming IDs.
 */
import {
  GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER,
  type GroupBlockReadData,
} from './group-block-read-contract.js';
import {
  groupBlockContextDataSchema,
  type GroupBlockContextData,
} from './context-read-contracts.js';
import type { HmsBrowserArtifactReceiptV1, HmsBrowserAuditSpec } from './browser-artifacts.js';
import { reviewedManifestSha256FromPayload } from './release-manifest-binding.js';
import { readResultSchema, unknownFact } from './read-service-contracts.js';
import { createGroupBlockReadFacade } from './group-block-read-facade.js';
import type { GroupReadCandidate } from './group-read-candidate.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HmsRuntimeError, type HmsRuntime } from './runtime.js';
import type { ReadResult } from './read-service-contracts.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import { createHash, randomUUID } from 'node:crypto';

export { GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

type GroupStatus = 'inquiry' | 'tentative' | 'definite' | 'cancelled' | 'closed';

export type GroupBlockListRow = {
  groupRef: string;
  status: GroupStatus | null;
  startDate: string | null;
  endDate: string | null;
};

export type GroupBlockListParse = {
  envelopeRecognized: boolean;
  rows: GroupBlockListRow[];
  bytesObserved: number;
};

const GROUP_REF_KEYS = [
  'groupbookingreferencenumber',
  'groupreference',
  'groupref',
  'groupcode',
  'groupid',
] as const;
const STATUS_KEYS = ['groupstatus', 'status', 'state'] as const;
const START_DATE_KEYS = ['startdate', 'fromdate', 'begindate', 'arrivaldate'] as const;
const END_DATE_KEYS = ['enddate', 'todate', 'finishdate', 'departuredate'] as const;

function parseHmsDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dmy = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (dmy) {
    const months: Record<string, string> = {
      JAN: '01',
      FEB: '02',
      MAR: '03',
      APR: '04',
      MAY: '05',
      JUN: '06',
      JUL: '07',
      AUG: '08',
      SEP: '09',
      OCT: '10',
      NOV: '11',
      DEC: '12',
    };
    const month = months[dmy[2]!.toUpperCase()];
    if (month) return `${dmy[3]}-${month}-${dmy[1]}`;
  }
  const slash = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (slash) return `${slash[3]}-${slash[2]}-${slash[1]}`;
  return null;
}

function parseGroupStatus(raw: unknown): GroupStatus | null {
  if (typeof raw !== 'string') return null;
  switch (
    raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ) {
    case 'prospect':
    case 'inquiry':
      return 'inquiry';
    case 'tentative':
      return 'tentative';
    case 'definite':
      return 'definite';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'closed':
      return 'closed';
    default:
      return null;
  }
}

function balancedObject(text: string, from: number): Record<string, unknown> | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = '';
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sourceRoot(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Infor's transport commonly prefixes a JSON object with `pageData:`.
  }
  for (const marker of ['pageData:', '"pageData":', "'pageData':"]) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) continue;
    const root = balancedObject(text, markerIndex + marker.length);
    if (root) return root;
  }
  return null;
}

function dataRows(value: unknown, key = ''): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    if (key.toLowerCase() === 'data') {
      return value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)),
      );
    }
    return value.flatMap((item) => dataRows(item));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([childKey, child]) => dataRows(child, childKey));
}

function rowValue(row: Record<string, unknown>, keys: readonly string[]): unknown {
  const lower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lower.get(key);
    if (value !== undefined && value !== null) {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
        return (value as { value?: unknown }).value;
      }
      return value;
    }
  }
  return null;
}

/** Parse only the reviewed GSGRPB.LST identity/status/date fields. */
export function parseGroupBlockListTransport(text: string): GroupBlockListParse {
  const root = sourceRoot(text);
  const rows = root
    ? dataRows(root).flatMap((row) => {
        const rawRef = rowValue(row, GROUP_REF_KEYS);
        if (typeof rawRef !== 'string' || rawRef.trim() === '') return [];
        return [
          {
            groupRef: rawRef.trim().toUpperCase(),
            status: parseGroupStatus(rowValue(row, STATUS_KEYS)),
            startDate: parseHmsDate(rowValue(row, START_DATE_KEYS)),
            endDate: parseHmsDate(rowValue(row, END_DATE_KEYS)),
          },
        ];
      })
    : [];
  return {
    envelopeRecognized: Boolean(root && /GRIDRESULT|pageData/i.test(text)),
    rows,
    bytesObserved: Buffer.byteLength(text, 'utf8'),
  };
}

function assertGroupAuth(
  authorization: HmsSessionAuthorization,
  candidate: GroupReadCandidate,
): void {
  if (authorization.toolId !== 'hms_group_block_read') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for group observer',
    );
  }
  if (authorization.discoveryOperationId !== 'group_block_list') {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization discoveryOperationId mismatch');
  }
  if (authorization.requestBranchId !== 'group_block_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for group observer',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (candidate.kind !== 'group_block') {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'candidate kind denied for group observer');
  }
  const recomputed = sha256Hex(`group_ref:${candidate.exactGroupReference}`);
  if (recomputed !== candidate.exactGroupReferenceHash) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'candidate reference hash mismatch');
  }
  if (reviewedManifestSha256FromPayload(authorization.manifest) !== authorization.manifestSha256) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization manifest digest mismatch');
  }
}

/**
 * Live group aggregate read — structurally blocked until list-only
 * con/blk/pickup/remaining/restriction rows exist without detail navigation.
 */
export async function observeGroupBlockAggregate(
  authorization: HmsSessionAuthorization,
  candidate: GroupReadCandidate,
  signal: AbortSignal,
): Promise<ToolResult<GroupBlockReadData>> {
  if (signal.aborted) {
    const err = new Error('group observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertGroupAuth(authorization, candidate);
  const observedAt = new Date().toISOString();
  return {
    status: 'manual_required',
    draftReady: false,
    data: {} as GroupBlockReadData,
    unresolvedFields: [GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER],
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_group_block_read',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER),
    },
  };
}

function groupSectionUnavailable(
  reasonCode: 'SOURCE_UNAVAILABLE' | 'SURFACE_UNPROVEN' | 'UNVERIFIED_NEGATIVE',
) {
  return {
    state: 'unavailable' as const,
    data: null,
    reasonCode,
    issues: [
      {
        code: reasonCode,
        retryable: false,
        safeNextAction: 'manual_review' as const,
      },
    ],
  };
}

function groupContextUnavailable(input: {
  groupRef: string;
  reasonCode: 'SOURCE_UNAVAILABLE' | 'SURFACE_UNPROVEN' | 'UNVERIFIED_NEGATIVE';
  observedAt: Date;
  expiresAt: Date;
  sourceHash?: string;
  manifestSha256?: string;
}): ReadResult<GroupBlockContextData> {
  const evidenceRef = `group-${sha256Hex(`${input.groupRef}:${input.observedAt.toISOString()}`).slice(0, 48)}`;
  const data = {
    summary: groupSectionUnavailable(input.reasonCode),
    blocks: groupSectionUnavailable('SURFACE_UNPROVEN'),
    delegates: groupSectionUnavailable('SOURCE_UNAVAILABLE'),
  } satisfies GroupBlockContextData;
  return readResultSchema.parse({
    toolId: 'hms_group_block_read',
    schemaVersion: 'hms-u15-context/1',
    status: 'manual_required',
    data,
    completeness: 'unknown',
    unavailableSections: [
      { section: 'summary', reasonCode: input.reasonCode },
      { section: 'blocks', reasonCode: 'SURFACE_UNPROVEN' },
      { section: 'delegates', reasonCode: 'SOURCE_UNAVAILABLE' },
    ],
    scopeRef: input.groupRef,
    evidence: [
      {
        evidenceRef,
        sourceSystem: 'hms',
        sourceSurface: 'GSGRPB.LST',
        requestBranchId: 'group_block_list',
        observedAt: input.observedAt.toISOString(),
        sourceUpdatedAt: null,
        expiresAt: input.expiresAt.toISOString(),
        scopeVerified: false,
        artifactRef: null,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        ...(input.manifestSha256 ? { manifestSha256: input.manifestSha256 } : {}),
      },
    ],
    page: null,
    issues: [
      {
        code: input.reasonCode,
        retryable: false,
        safeNextAction: 'manual_review',
      },
    ],
  }) as ReadResult<GroupBlockContextData>;
}

function groupContextFromRow(input: {
  candidate: GroupReadCandidate;
  row: GroupBlockListRow;
  observedAt: Date;
  expiresAt: Date;
  sourceHash: string;
  manifestSha256: string;
  artifactRef: string | null;
}): ReadResult<GroupBlockContextData> {
  const evidenceRef = `group-${input.sourceHash.slice(0, 48)}`;
  const known = <T>(value: T) => ({
    state: 'known' as const,
    value,
    data: value,
    evidenceRef,
    observedAt: input.observedAt.toISOString(),
    sourceUpdatedAt: null,
    expiresAt: input.expiresAt.toISOString(),
  });
  const unknown = (reasonCode: 'SURFACE_UNPROVEN' | 'SOURCE_UNAVAILABLE') =>
    unknownFact({
      reasonCode,
      evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    });
  const data: GroupBlockContextData = {
    summary: {
      state: 'available',
      data: {
        groupRef: known(input.row.groupRef),
        status: known(input.row.status),
        startDate: known(input.row.startDate),
        endDate: known(input.row.endDate),
        releasePolicy: unknown('SURFACE_UNPROVEN'),
        billingRef: unknown('SURFACE_UNPROVEN'),
      },
      completeness: 'partial',
      issues: [
        {
          code: 'SURFACE_UNPROVEN',
          retryable: false,
          safeNextAction: 'manual_review',
        },
      ],
    },
    blocks: groupSectionUnavailable('SURFACE_UNPROVEN'),
    delegates: groupSectionUnavailable('SOURCE_UNAVAILABLE'),
  };
  groupBlockContextDataSchema.parse(data);
  return readResultSchema.parse({
    toolId: 'hms_group_block_read',
    schemaVersion: 'hms-u15-context/1',
    status: 'partial',
    data,
    completeness: 'partial',
    unavailableSections: [
      { section: 'blocks', reasonCode: 'SURFACE_UNPROVEN' },
      { section: 'delegates', reasonCode: 'SOURCE_UNAVAILABLE' },
    ],
    scopeRef: input.candidate.exactGroupReference,
    evidence: [
      {
        evidenceRef,
        sourceSystem: 'hms',
        sourceSurface: 'GSGRPB.LST',
        requestBranchId: 'group_block_list',
        observedAt: input.observedAt.toISOString(),
        sourceUpdatedAt: null,
        expiresAt: input.expiresAt.toISOString(),
        scopeVerified: true,
        artifactRef: input.artifactRef,
        sourceHash: input.sourceHash,
        manifestSha256: input.manifestSha256,
      },
    ],
    page: null,
    issues: [
      {
        code: 'SURFACE_UNPROVEN',
        retryable: false,
        safeNextAction: 'manual_review',
      },
    ],
  }) as ReadResult<GroupBlockContextData>;
}

export type LiveGroupBlockDriverOptions = {
  runtime?: HmsRuntime;
  transportId?: string;
  auditSpec?: HmsBrowserAuditSpec;
};

function finalizedGroupReceipt(
  session: { lastReceipt?: () => HmsBrowserArtifactReceiptV1 | null },
  auditSpec: HmsBrowserAuditSpec | undefined,
  requestBranchId: string,
): HmsBrowserArtifactReceiptV1 | null {
  if (!auditSpec || typeof session.lastReceipt !== 'function') return null;
  let receipt: HmsBrowserArtifactReceiptV1 | null;
  try {
    receipt = session.lastReceipt();
  } catch {
    return null;
  }
  if (
    !receipt ||
    receipt.artifactState !== 'complete' ||
    typeof receipt.artifactId !== 'string' ||
    receipt.artifactId.length === 0 ||
    receipt.operationId !== auditSpec.operationId ||
    receipt.toolId !== auditSpec.toolId ||
    receipt.toolVersion !== auditSpec.toolVersion ||
    receipt.executionClass !== auditSpec.executionClass ||
    receipt.inputClass !== auditSpec.inputClass ||
    receipt.roleProofSha256 !== (auditSpec.roleProofSha256 ?? null) ||
    receipt.roleProofExpiresAt !== (auditSpec.roleProofExpiresAt ?? null) ||
    receipt.requestBranchId !== requestBranchId ||
    receipt.operationOutcome !== 'succeeded' ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.expiresAt) <= Date.now()
  ) {
    return null;
  }
  return receipt;
}

export async function observeGroupBlockContext(
  options: LiveGroupBlockDriverOptions,
  authorization: HmsSessionAuthorization,
  candidate: GroupReadCandidate,
  signal: AbortSignal,
): Promise<ReadResult<GroupBlockContextData>> {
  if (signal.aborted) {
    const err = new Error('group context observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertGroupAuth(authorization, candidate);
  const observedAt = new Date();
  const expiresAt = new Date(
    Math.min(Date.parse(authorization.expiresAt), observedAt.getTime() + 5 * 60_000),
  );
  if (!options.runtime || !options.transportId) {
    return groupContextUnavailable({
      groupRef: candidate.exactGroupReference,
      reasonCode: 'SOURCE_UNAVAILABLE',
      observedAt,
      expiresAt,
      manifestSha256: authorization.manifestSha256,
    });
  }
  if (!options.auditSpec) {
    return groupContextUnavailable({
      groupRef: candidate.exactGroupReference,
      reasonCode: 'SOURCE_UNAVAILABLE',
      observedAt,
      expiresAt,
      manifestSha256: authorization.manifestSha256,
    });
  }

  if (typeof options.runtime.openReadSession !== 'function') {
    return groupContextUnavailable({
      groupRef: candidate.exactGroupReference,
      reasonCode: 'SOURCE_UNAVAILABLE',
      observedAt,
      expiresAt,
      manifestSha256: authorization.manifestSha256,
    });
  }
  let session: Awaited<ReturnType<HmsRuntime['openReadSession']>>;
  try {
    session = await options.runtime.openReadSession({
      transportId: options.transportId,
      signal,
      allowUnstarted: true,
      auditSpec: options.auditSpec,
      sessionAuthorization: authorization,
    });
  } catch {
    return groupContextUnavailable({
      groupRef: candidate.exactGroupReference,
      reasonCode: 'SOURCE_UNAVAILABLE',
      observedAt,
      expiresAt,
      manifestSha256: authorization.manifestSha256,
    });
  }
  let closed = false;
  const close = async (
    outcome: 'succeeded' | 'unverified_negative' | 'failed',
    terminalCode: 'OK' | 'UNVERIFIED_NEGATIVE' | 'TOOL_ERROR',
  ) => {
    if (closed) return;
    closed = true;
    await session.close({ outcome, terminalCode, complete: true });
  };
  try {
    const transport = await createGroupBlockReadFacade(session).openList();
    if (session.terminal() || session.violation()) {
      await close('failed', 'TOOL_ERROR');
      return groupContextUnavailable({
        groupRef: candidate.exactGroupReference,
        reasonCode: 'SOURCE_UNAVAILABLE',
        observedAt,
        expiresAt,
        sourceHash: sha256Hex(transport),
        manifestSha256: authorization.manifestSha256,
      });
    }
    const parsed = parseGroupBlockListTransport(transport);
    const sourceHash = sha256Hex(transport);
    const exactRows = parsed.rows.filter(
      (row) => row.groupRef === candidate.exactGroupReference.toUpperCase(),
    );
    if (exactRows.length !== 1) {
      await close('unverified_negative', 'UNVERIFIED_NEGATIVE');
      return groupContextUnavailable({
        groupRef: candidate.exactGroupReference,
        reasonCode: 'SURFACE_UNPROVEN',
        observedAt,
        expiresAt,
        sourceHash,
        manifestSha256: authorization.manifestSha256,
      });
    }
    const row = exactRows[0]!;
    if (!row.status || !row.startDate || !row.endDate) {
      await close('failed', 'TOOL_ERROR');
      return groupContextUnavailable({
        groupRef: candidate.exactGroupReference,
        reasonCode: 'SURFACE_UNPROVEN',
        observedAt,
        expiresAt,
        sourceHash,
        manifestSha256: authorization.manifestSha256,
      });
    }
    await close('succeeded', 'OK');
    const receipt = finalizedGroupReceipt(
      session,
      options.auditSpec,
      authorization.requestBranchId,
    );
    if (!receipt) {
      return groupContextUnavailable({
        groupRef: candidate.exactGroupReference,
        reasonCode: 'SOURCE_UNAVAILABLE',
        observedAt,
        expiresAt,
        sourceHash,
        manifestSha256: authorization.manifestSha256,
      });
    }
    const receiptExpiresAt = Date.parse(receipt.expiresAt);
    const effectiveExpiresAt = new Date(Math.min(expiresAt.getTime(), receiptExpiresAt));
    const boundSourceHash = sha256Hex(
      JSON.stringify({
        sourceHash,
        manifestSha256: authorization.manifestSha256,
        artifactId: receipt.artifactId,
        receipt: {
          operationId: receipt.operationId,
          toolId: receipt.toolId,
          toolVersion: receipt.toolVersion,
          requestBranchId: receipt.requestBranchId,
          operationOutcome: receipt.operationOutcome,
          expiresAt: receipt.expiresAt,
        },
      }),
    );
    return groupContextFromRow({
      candidate,
      row,
      observedAt,
      expiresAt: effectiveExpiresAt,
      sourceHash: boundSourceHash,
      manifestSha256: authorization.manifestSha256,
      artifactRef: receipt.artifactId,
    });
  } catch {
    await close('failed', 'TOOL_ERROR').catch(() => undefined);
    return groupContextUnavailable({
      groupRef: candidate.exactGroupReference,
      reasonCode: 'SOURCE_UNAVAILABLE',
      observedAt,
      expiresAt,
      manifestSha256: authorization.manifestSha256,
    });
  } finally {
    await close('failed', 'TOOL_ERROR').catch(() => undefined);
  }
}

export function createLiveGroupBlockDriver(options: LiveGroupBlockDriverOptions = {}): {
  observeGroupBlockAggregate: typeof observeGroupBlockAggregate;
  observeGroupBlockContext: (
    authorization: HmsSessionAuthorization,
    candidate: GroupReadCandidate,
    signal: AbortSignal,
  ) => Promise<ReadResult<GroupBlockContextData>>;
} {
  return {
    observeGroupBlockAggregate,
    observeGroupBlockContext: (authorization, candidate, signal) =>
      observeGroupBlockContext(options, authorization, candidate, signal),
  };
}
