import { z } from 'zod';

/** Shared envelope; a possibly dispatched write is uncertain until fresh readback verifies it. */
export type NavaToolResult<T> = {
  schema: 'nava.tool/v1';
  outcome: 'ok' | 'refused' | 'needs_input' | 'uncertain' | 'partial';
  reason?: string;
  field?: string;
  data?: T;
  /** Additional producer fields when an explicit data payload also exists; not verification. */
  legacyData?: Record<string, unknown>;
  children?: { key: string; outcome: NavaToolResult<unknown>['outcome']; reason?: string; confirmation?: string;
    data?: unknown; legacyData?: Record<string, unknown>; evidence?: NavaToolResult<unknown>['evidence'] }[];
  evidence?: {
    screenshots?: { runId: string; name: string; sha256: string }[];
    readback?: unknown;
    requestDigest?: string;
    level?: 'readback_verified' | 'attributed_metadata' | 'none';
    /** Producer metadata is retained without claiming it is verified proof. */
    legacy?: Record<string, unknown>[];
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

// Parsing validates structure only. Authority still requires a server-owned manifest and an unexpired grant.
const manifestIdentifier = z.string().min(1).refine((value) => value === value.trim() &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
const manifestDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const BatchManifestGrantSchema = z.object({
  manifestId: manifestIdentifier,
  revision: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
  children: z.array(z.object({ key: manifestIdentifier, stayDigest: manifestDigest, previewDigest: manifestDigest }).strict()).min(1),
}).strict().superRefine((grant, ctx) => {
  const keys = new Set<string>();
  for (const child of grant.children) {
    if (keys.has(child.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['children'], message: 'Duplicate child key.' });
    keys.add(child.key);
  }
});
export type BatchManifestGrant = z.infer<typeof BatchManifestGrantSchema>;

export type ExistingToolResult<T> = {
  status?: string;
  outcome?: string;
  reason?: string | null;
  issue?: string;
  error?: string;
  stack?: string;
  field?: string;
  data?: T;
  clickedSave?: boolean | 'unknown';
  saveAttempted?: boolean | 'unknown';
  uploadSent?: boolean | 'unknown';
  clickedOk?: boolean | 'unknown';
  saveDispatched?: boolean | 'unknown';
  possiblyDispatched?: boolean | 'unknown';
  dispatched?: boolean | 'unknown';
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
function normalizeExistingEvidence<T>(result: ExistingToolResult<T>, trustedReadback?: { readback: unknown }): NavaToolResult<T>['evidence'] {
  // Keep dispatch indicators and observations, but never echo raw errors or duplicate data.
  const legacyFields = new Set(['runId', 'screenshots', 'shots', 'readback', 'changedFieldsReadback',
    'clickedSave', 'saveAttempted', 'uploadSent', 'clickedOk', 'saveDispatched', 'possiblyDispatched', 'dispatched', 'claimedLevel', 'claimedReadback']);
  const keepEvidence = (source: Record<string, unknown>) => Object.fromEntries(
    Object.entries(source).filter(([key]) => legacyFields.has(key)),
  );
  const legacy = keepEvidence(result as Record<string, unknown>);
  if (result.evidence?.level === 'readback_verified') legacy.claimedLevel = 'readback_verified';
  if (trustedReadback && result.evidence?.readback !== undefined) legacy.claimedReadback = result.evidence.readback;
  const hasLegacy = Object.keys(legacy).length > 0;
  const previousLegacy = (result.evidence?.legacy ?? []).map(keepEvidence).filter((item) => Object.keys(item).length > 0);
  if (!result.evidence && !hasLegacy && !trustedReadback) return undefined;
  const screenshots = result.runId && result.shots
    ? result.shots.filter((shot) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(shot.name) && /^[a-f0-9]{64}$/i.test(shot.sha256))
      .map((shot) => ({ runId: result.runId!, name: shot.name, sha256: shot.sha256 }))
    : [];
  const existingShots = result.evidence?.screenshots ?? [];
  // Never attach an unverified producer observation to an unrelated verified level.
  const missingVerifiedReadback = result.evidence?.level === 'readback_verified' &&
    result.evidence.readback == null;
  const readback = trustedReadback ? trustedReadback.readback
    : result.evidence?.readback !== undefined ? result.evidence.readback
      : missingVerifiedReadback ? undefined
        : result.readback !== undefined ? result.readback : result.changedFieldsReadback;
  return {
    ...(result.evidence?.requestDigest !== undefined ? { requestDigest: result.evidence.requestDigest } : {}),
    ...(trustedReadback ? { level: 'readback_verified' as const }
      : result.evidence?.level !== undefined ? { level: result.evidence.level === 'readback_verified' ? 'none' as const : result.evidence.level } : {}),
    ...(existingShots.length || screenshots.length ? { screenshots: [...existingShots, ...screenshots] } : {}),
    ...(readback !== undefined ? { readback } : {}),
    ...(hasLegacy || previousLegacy.length ? { legacy: [...previousLegacy, ...(hasLegacy ? [legacy] : [])] } : {}),
  };
}

const existingControlFields = new Set<keyof ExistingToolResult<unknown>>([
  'status', 'outcome', 'reason', 'issue', 'error', 'stack', 'field', 'data', 'clickedSave', 'saveAttempted', 'uploadSent', 'clickedOk', 'saveDispatched',
  'possiblyDispatched', 'dispatched', 'runId', 'screenshots', 'shots', 'readback', 'changedFieldsReadback', 'evidence',
]);
type LegacyPayload<R> = Omit<R, keyof ExistingToolResult<unknown>>;
type AdaptedData<R> = R extends { data: infer T }
  ? undefined extends T ? Exclude<T, undefined> | LegacyPayload<R> : T
  : R extends { data?: infer T } ? T | LegacyPayload<R> : LegacyPayload<R>;

/** The trusted caller must verify a fresh matching read; producer evidence is never that proof. */
export function adaptExistingToolResult<R extends ExistingToolResult<unknown>>(result: R, options: {
  operation: 'read' | 'write'; readbackVerified?: boolean; verifiedReadback?: { readback: unknown };
}): NavaToolResult<AdaptedData<R>> {
  const code = result.outcome ?? result.status ?? '';
  // These amendment outcomes are produced before a runner can start. Unknown codes stay uncertain.
  const knownPreDispatchRefusal = ['refused_flag_off', 'amend_preview_required'].includes(code);
  const reason = stableReason(result.reason ?? result.issue ?? result.error ?? (knownPreDispatchRefusal ? code : undefined));
  const uncertainCodes = new Set(['committed_unverified', 'awaiting_readback', 'uncertain', 'save_unconfirmed', 'save_failed', 'partial']);
  // Generic status 'ok' can accompany a refused outcome; strong commit statuses cannot.
  const strongWriteStatuses = new Set(['saved', 'committed', 'confirmed', 'verified', 'readback_verified', 'amended', 'cancelled', 'attached']);
  const preDispatchCodes = new Set(['refused', 'not_dispatched', 'refused_flag_off', 'amend_preview_required', 'needs_input', 'input_gap']);
  const contradictoryWrite = options.operation === 'write' && (
    (strongWriteStatuses.has(result.status ?? '') && preDispatchCodes.has(result.outcome ?? '')) ||
    (strongWriteStatuses.has(result.outcome ?? '') && preDispatchCodes.has(result.status ?? ''))
  );
  const ambiguous = contradictoryWrite || uncertainCodes.has(code) || uncertainCodes.has(result.status ?? '') ||
    (result.reason === 'pane_save_unconfirmed' || result.issue === 'pane_save_unconfirmed');
  const possibleDispatch = result.clickedSave === true || result.clickedSave === 'unknown' ||
    result.saveAttempted === true || result.saveAttempted === 'unknown' || result.uploadSent === true || result.uploadSent === 'unknown' ||
    result.clickedOk === true || result.clickedOk === 'unknown' || result.saveDispatched === true || result.saveDispatched === 'unknown' ||
    result.possiblyDispatched === true || result.possiblyDispatched === 'unknown' || result.dispatched === true || result.dispatched === 'unknown';
  const successful = (['ok', 'success', 'verified', 'readback_verified', 'saved', 'committed', 'confirmed'].includes(code) ||
    (options.operation === 'read' && code === 'found') ||
    (options.operation === 'write' && ['amended', 'cancelled', 'attached'].includes(code))) && result.status !== 'refused';
  const hasTrustedReadback = options.readbackVerified === true && options.verifiedReadback?.readback != null;
  let outcome: NavaToolResult<unknown>['outcome'];
  if (ambiguous || (options.operation === 'write' && possibleDispatch && (!hasTrustedReadback || !successful))) outcome = 'uncertain';
  else if (code === 'refused' || code === 'not_dispatched' || knownPreDispatchRefusal) outcome = 'refused';
  else if (code === 'needs_input' || code === 'input_gap') outcome = 'needs_input';
  else if (successful) {
    outcome = options.operation === 'write' && !hasTrustedReadback ? 'uncertain' : 'ok';
  } else outcome = options.operation === 'write' ? 'uncertain' : 'refused';
  const trustedReadback = hasTrustedReadback && outcome === 'ok'
    ? options.verifiedReadback : undefined;
  const evidence = normalizeExistingEvidence(result, trustedReadback);
  // Legacy tools put useful observations beside their outcome rather than in data.
  const legacyData = Object.fromEntries(Object.entries(result).filter(([key]) =>
    !existingControlFields.has(key as keyof ExistingToolResult<unknown>)));
  const hasLegacyData = Object.keys(legacyData).length > 0;
  const data = result.data !== undefined ? result.data : hasLegacyData ? legacyData : undefined;
  return {
    schema: 'nava.tool/v1', outcome,
    ...(reason ? { reason } : {}),
    ...(result.field ? { field: result.field } : {}),
    ...(data !== undefined ? { data: data as AdaptedData<R> } : {}),
    ...(result.data !== undefined && hasLegacyData ? { legacyData } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** Batch stays partial even when individual children have uncertain outcomes. Use this adapter, not the single-result adapter, for batches. */
export function adaptBatchToolResult<R extends ExistingToolResult<unknown>>(children: Array<{
  key: string; result: R; readbackVerified?: boolean; verifiedReadback?: { readback: unknown }; confirmation?: string;
}>): NavaToolResult<never> {
  if (children.length === 0) return { schema: 'nava.tool/v1', outcome: 'needs_input', reason: 'batch_empty' };
  return {
    schema: 'nava.tool/v1', outcome: 'partial',
    children: children.map(({ key, result, readbackVerified, verifiedReadback, confirmation }) => {
      const adapted = adaptExistingToolResult(result, { operation: 'write', readbackVerified, verifiedReadback });
      return { key, outcome: adapted.outcome, ...(adapted.reason ? { reason: adapted.reason } : {}),
        ...(confirmation ? { confirmation } : {}), ...(adapted.data !== undefined ? { data: adapted.data } : {}),
        ...(adapted.legacyData !== undefined ? { legacyData: adapted.legacyData } : {}),
        ...(adapted.evidence !== undefined ? { evidence: adapted.evidence } : {}) };
    }),
  };
}
