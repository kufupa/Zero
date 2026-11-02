import { z } from 'zod';

/** Shared envelope; a possibly dispatched write is uncertain until fresh readback verifies it. */
export type NavaToolResult<T> = {
  schema: 'nava.tool/v1';
  outcome: 'ok' | 'refused' | 'needs_input' | 'uncertain' | 'partial';
  reason?: string;
  field?: string;
  data?: T;
  children?: { key: string; outcome: NavaToolResult<unknown>['outcome']; reason?: string; confirmation?: string }[];
  evidence?: {
    screenshots?: { runId: string; name: string; sha256: string }[];
    readback?: unknown;
    requestDigest?: string;
    level?: 'readback_verified' | 'attributed_metadata' | 'none';
    /** Producer metadata is retained without claiming it is verified proof. */
    legacy?: { runId?: string | null; screenshots?: string[]; shots?: { name: string; sha256: string; at?: string }[]; readback?: unknown; changedFieldsReadback?: unknown }[];
  };
};

const grantRef = z.string().min(1).max(256);
export const FilingRunnerInputSchema = z.object({ grantRef }).strict();
export interface FilingRunner {
  run(input: z.infer<typeof FilingRunnerInputSchema>): Promise<NavaToolResult<{ documentCode: string; documentId?: string }>>;
}

export const AmendStageInputSchema = z.object({
  grantRef,
  dates: z.object({ arrival: z.string().date().optional(), departure: z.string().date().optional() }).strict().optional(),
  occupancy: z.object({
    adults: z.number().int().min(1),
    childAges: z.union([z.array(z.number().int().min(0).max(17)), z.literal('unknown')]),
  }).strict().optional(),
  retainRates: z.enum(['yes', 'no']).optional(),
}).strict();
export type AmendStageInput = z.infer<typeof AmendStageInputSchema>;

export const BatchManifestGrantSchema = z.object({
  manifestId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
  children: z.array(z.object({ key: z.string().min(1), stayDigest: z.string().min(1), previewDigest: z.string().min(1) }).strict()).min(1),
}).strict();
export type BatchManifestGrant = z.infer<typeof BatchManifestGrantSchema>;

export type ExistingToolResult<T> = {
  status?: string;
  outcome?: string;
  reason?: string;
  issue?: string;
  field?: string;
  data?: T;
  clickedSave?: boolean;
  saveDispatched?: boolean | 'unknown';
  possiblyDispatched?: boolean;
  dispatched?: boolean;
  runId?: string | null;
  screenshots?: string[];
  shots?: { name: string; sha256: string; at?: string }[];
  readback?: unknown;
  changedFieldsReadback?: unknown;
  evidence?: NavaToolResult<T>['evidence'];
};

function stableReason(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Existing HMS issue codes are uppercase; never expose arbitrary error text as a reason.
  return /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(value) ? value.toLowerCase() : 'tool_result_unclassified';
}

/** Preserve original observations; a filename or readback alone does not prove a write. */
function normalizeExistingEvidence<T>(result: ExistingToolResult<T>): NavaToolResult<T>['evidence'] {
  const legacy = {
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
    ...(result.screenshots !== undefined ? { screenshots: result.screenshots } : {}),
    ...(result.shots !== undefined ? { shots: result.shots } : {}),
    ...(result.readback !== undefined ? { readback: result.readback } : {}),
    ...(result.changedFieldsReadback !== undefined ? { changedFieldsReadback: result.changedFieldsReadback } : {}),
  };
  const hasLegacy = Object.keys(legacy).length > 0;
  if (!result.evidence && !hasLegacy) return undefined;
  const screenshots = result.runId && result.shots
    ? result.shots.filter((shot) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(shot.name) && /^[a-f0-9]{64}$/i.test(shot.sha256))
      .map((shot) => ({ runId: result.runId!, name: shot.name, sha256: shot.sha256 }))
    : [];
  const existingShots = result.evidence?.screenshots ?? [];
  // Never attach an unverified producer observation to an unrelated verified level.
  const missingVerifiedReadback = result.evidence?.level === 'readback_verified' &&
    result.evidence.readback === undefined;
  const readback = result.evidence?.readback !== undefined ? result.evidence.readback
    : missingVerifiedReadback ? undefined
      : result.readback !== undefined ? result.readback : result.changedFieldsReadback;
  return {
    ...result.evidence,
    ...(missingVerifiedReadback ? { level: 'none' as const } : {}),
    ...(existingShots.length || screenshots.length ? { screenshots: [...existingShots, ...screenshots] } : {}),
    ...(readback !== undefined ? { readback } : {}),
    ...(hasLegacy ? { legacy: [...(result.evidence?.legacy ?? []), legacy] } : {}),
  };
}

/** `readbackVerified` must be established by the trusted caller from a fresh, matching read. */
export function adaptExistingToolResult<T>(result: ExistingToolResult<T>, options: {
  operation: 'read' | 'write'; readbackVerified?: boolean;
}): NavaToolResult<T> {
  const code = result.outcome ?? result.status ?? '';
  // These amendment outcomes are produced before a runner can start. Unknown codes stay uncertain.
  const knownPreDispatchRefusal = ['refused_flag_off', 'amend_preview_required'].includes(code);
  const reason = stableReason(result.reason ?? result.issue ?? (knownPreDispatchRefusal ? code : undefined));
  const uncertainCodes = new Set(['committed_unverified', 'awaiting_readback', 'uncertain', 'save_unconfirmed', 'save_failed', 'partial']);
  const ambiguous = uncertainCodes.has(code) || uncertainCodes.has(result.status ?? '') ||
    (result.reason === 'pane_save_unconfirmed' || result.issue === 'pane_save_unconfirmed');
  const possibleDispatch = result.clickedSave === true || result.saveDispatched === true ||
    result.saveDispatched === 'unknown' || result.possiblyDispatched === true || result.dispatched === true;
  const successful = ['ok', 'success', 'verified', 'readback_verified', 'saved', 'committed', 'confirmed'].includes(code) && result.status !== 'refused';
  let outcome: NavaToolResult<T>['outcome'];
  if (ambiguous || (options.operation === 'write' && possibleDispatch && (!options.readbackVerified || !successful))) outcome = 'uncertain';
  else if (code === 'refused' || code === 'not_dispatched' || knownPreDispatchRefusal) outcome = 'refused';
  else if (code === 'needs_input' || code === 'input_gap') outcome = 'needs_input';
  else if (successful) {
    outcome = options.operation === 'write' && !options.readbackVerified ? 'uncertain' : 'ok';
  } else outcome = options.operation === 'write' ? 'uncertain' : 'refused';
  const evidence = normalizeExistingEvidence(result);
  return {
    schema: 'nava.tool/v1', outcome,
    ...(reason ? { reason } : {}),
    ...(result.field ? { field: result.field } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** Batch stays partial even when individual children have uncertain outcomes. Use this adapter, not the single-result adapter, for batches. */
export function adaptBatchToolResult<T>(children: Array<{
  key: string; result: ExistingToolResult<T>; readbackVerified?: boolean; confirmation?: string;
}>): NavaToolResult<never> {
  if (children.length === 0) return { schema: 'nava.tool/v1', outcome: 'needs_input', reason: 'batch_empty' };
  return {
    schema: 'nava.tool/v1', outcome: 'partial',
    children: children.map(({ key, result, readbackVerified, confirmation }) => {
      const adapted = adaptExistingToolResult(result, { operation: 'write', readbackVerified });
      return { key, outcome: adapted.outcome, ...(adapted.reason ? { reason: adapted.reason } : {}),
        ...(confirmation ? { confirmation } : {}) };
    }),
  };
}
