/**
 * Aggregate per-batch thread-review result JSONs into a full-corpus census and
 * reconcile the judged classifications against the deterministic regex census.
 *
 * Deterministic and DB-free. Reads only private result files; emits only
 * aggregate counts. Never prints or stores raw message content.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const INTENT_CLASSES = [
  'booking_new',
  'booking_modify',
  'booking_cancel',
  'quote_request',
  'group_event',
  'payment_finance',
  'document_request',
  'vendor_b2b',
  'spam_noise',
  'internal_test',
  'staff_internal',
  'other',
] as const;

export type ThreadIntentClass = (typeof INTENT_CLASSES)[number];

export const TRIAGE_SLUGS = ['ops', 'spam', 'at-risk', 'resolved', 'unknown'] as const;
export type TriageSlug = (typeof TRIAGE_SLUGS)[number];

export const TOOL_DISPOSITIONS = [
  'gap_unlisted',
  'improve_existing',
  'extend_existing',
  'retain_existing',
  'split_or_replace',
  'defer_no_build',
] as const;
export type ToolDisposition = (typeof TOOL_DISPOSITIONS)[number];

/** Judge intent class → regex-census intent ids considered equivalent. */
export const INTENT_CLASS_TO_CENSUS_INTENTS: Record<ThreadIntentClass, string[]> = {
  booking_new: ['new_booking'],
  booking_modify: ['amendment'],
  booking_cancel: ['cancellation'],
  quote_request: ['quote_request'],
  group_event: ['group_event'],
  payment_finance: ['payment_ops'],
  document_request: ['invoice_docs', 'confirmation_status'],
  vendor_b2b: ['channel_ota', 'internal_ops'],
  spam_noise: ['spam_noise', 'confirmation_delivery'],
  internal_test: [],
  staff_internal: ['internal_ops'],
  other: [],
};

export type JudgedThread = {
  threadId: string;
  batchId: string;
  intentClass: ThreadIntentClass;
  pmsFacts: string[];
  routeSlug: TriageSlug;
  routeConfidence: 'high' | 'medium' | 'low';
  humanLockRequired: boolean;
  humanLockReason: string;
  toolDemand: Array<{
    need: string;
    disposition: ToolDisposition;
    verb: 'read' | 'create' | 'modify' | 'cancel' | 'send' | 'attach' | 'none';
    hitlRequired: boolean;
  }>;
  alreadyHandled: string;
  confidence: 'high' | 'medium' | 'low';
  anchorQuote: string;
};

type CoverageCounts = Map<string, number>;

function countCoverage(
  manifestThreadIds: string[],
  seen: CoverageCounts,
): {
  complete: boolean;
  totalThreads: number;
  missingThreads: string[];
  duplicateThreads: string[];
} {
  const manifestSet = new Set(manifestThreadIds);
  if (manifestSet.size !== manifestThreadIds.length) {
    throw new Error('Manifest itself contains duplicate threadIds');
  }
  const missing: string[] = [];
  for (const id of manifestThreadIds) {
    if (!seen.has(id)) missing.push(id);
  }
  const duplicates: string[] = [];
  for (const [id, count] of seen) {
    if (count > 1 && manifestSet.has(id)) duplicates.push(id);
  }
  // Extra threads not in the manifest are also duplicates of nothing — surface them.
  const extras: string[] = [];
  for (const id of seen.keys()) {
    if (!manifestSet.has(id)) extras.push(id);
  }
  return {
    complete: missing.length === 0 && duplicates.length === 0 && extras.length === 0,
    totalThreads: manifestThreadIds.length,
    missingThreads: [...missing, ...extras].sort(),
    duplicateThreads: duplicates.sort(),
  };
}

function normalizeIntentClass(value: unknown): ThreadIntentClass {
  const aliases: Record<string, ThreadIntentClass> = {
    booking_change: 'booking_modify',
    cancellation: 'booking_cancel',
    feedback_review: 'other',
  };
  const normalized = aliases[String(value)] ?? value;
  if (!INTENT_CLASSES.includes(normalized as ThreadIntentClass)) {
    throw new Error(`invalid intentClass: ${String(value)}`);
  }
  return normalized as ThreadIntentClass;
}

function normalizeTriageSlug(value: unknown): TriageSlug {
  // One early batch used a descriptive alias for the same human-review boundary.
  const normalized = value === 'human_lock' ? 'at-risk' : value;
  if (!TRIAGE_SLUGS.includes(normalized as TriageSlug)) {
    throw new Error(`invalid triage slug: ${String(value)}`);
  }
  return normalized as TriageSlug;
}

function requireConfidence(value: unknown, field: string): 'high' | 'medium' | 'low' {
  if (value !== 'high' && value !== 'medium' && value !== 'low') {
    throw new Error(`invalid ${field}: ${String(value)}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function requireToolDemand(
  value: unknown,
  fileName: string,
  index: number,
): JudgedThread['toolDemand'][number] {
  if (!value || typeof value !== 'object')
    throw new Error(`${fileName} tool demand ${index} invalid`);
  const row = value as Record<string, unknown>;
  const dispositions = TOOL_DISPOSITIONS as readonly string[];
  const verbs = ['read', 'create', 'modify', 'cancel', 'send', 'attach', 'none'];
  if (typeof row.need !== 'string' || row.need.length > 200)
    throw new Error(`${fileName} tool need invalid`);
  if (!dispositions.includes(String(row.disposition)))
    throw new Error(`${fileName} tool disposition invalid`);
  if (!verbs.includes(String(row.verb))) throw new Error(`${fileName} tool verb invalid`);
  if (typeof row.hitlRequired !== 'boolean') throw new Error(`${fileName} tool HITL flag invalid`);
  return {
    need: row.need,
    disposition: row.disposition as ToolDisposition,
    verb: row.verb as JudgedThread['toolDemand'][number]['verb'],
    hitlRequired: row.hitlRequired,
  };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid ${field}`);
  return value;
}

function parseResultFile(
  raw: string,
  fileName: string,
): { batchId: string; threads: Omit<JudgedThread, 'batchId'>[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Result file ${fileName} is not valid JSON`);
  }
  const obj = parsed as {
    schemaVersion?: unknown;
    batchId?: unknown;
    batch?: unknown;
    threads?: unknown;
  };
  if (obj.schemaVersion !== 1 && typeof obj.batch !== 'string') {
    throw new Error(`Result file ${fileName} has unsupported schemaVersion`);
  }
  const batchId = typeof obj.batchId === 'string' ? obj.batchId : String(obj.batch);
  if (typeof batchId !== 'string' || batchId === '') {
    throw new Error(`Result file ${fileName} is missing batchId`);
  }
  if (!Array.isArray(obj.threads)) {
    throw new Error(`Result file ${fileName} is missing threads array`);
  }
  const threads: Omit<JudgedThread, 'batchId'>[] = obj.threads.map((entry, index) => {
    const t = entry as Record<string, unknown>;
    const threadId = t.threadId;
    if (typeof threadId !== 'string' || threadId === '') {
      throw new Error(`${fileName} thread[${index}] missing threadId`);
    }
    const intentClass = normalizeIntentClass(t.intentClass);
    const route = (t.proposedTriageRoute ?? {}) as { slug?: unknown; confidence?: unknown };
    const slug = normalizeTriageSlug(route.slug);
    const routeConfidence = requireConfidence(route.confidence, 'route confidence');
    const demand = Array.isArray(t.toolDemand) ? t.toolDemand : [];
    if (demand.length > 20)
      throw new Error(`${fileName} thread[${index}] has too many tool demands`);
    return {
      threadId,
      intentClass,
      pmsFacts: requireStringArray(t.pmsFacts, 'pmsFacts', 3),
      routeSlug: slug,
      routeConfidence,
      humanLockRequired: requireBoolean(
        (t.humanLock as { required?: unknown })?.required,
        'humanLock.required',
      ),
      humanLockReason: String((t.humanLock as { reason?: unknown })?.reason ?? ''),
      toolDemand: demand.map((d, demandIndex) => requireToolDemand(d, fileName, demandIndex)),
      alreadyHandled: String(t.alreadyHandled ?? 'inbound_only'),
      confidence: requireConfidence(t.confidence, 'confidence'),
      anchorQuote: typeof t.anchorQuote === 'string' ? t.anchorQuote : '',
    };
  });
  return { batchId, threads };
}

export type AggregationResult = {
  threads: JudgedThread[];
  coverage: {
    complete: boolean;
    totalThreads: number;
    missingThreads: string[];
    duplicateThreads: string[];
  };
  intentCounts: Record<string, number>;
  routeCounts: Record<string, number>;
  humanLockCount: number;
  lowConfidenceCount: number;
  toolDemandCounts: Record<string, number>;
  toolVerbCounts: Record<string, number>;
  toolHitlCount: number;
};

export async function aggregateThreadReviewResults(input: {
  manifest: {
    schemaVersion?: number;
    threadCount?: number;
    batches: Array<{ batchId: string; threadIds: string[] }>;
  };
  resultsRoot: string;
}): Promise<AggregationResult> {
  const { manifest, resultsRoot } = input;
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    throw new Error('Unsupported batch manifest schemaVersion');
  }
  const manifestThreadIds = manifest.batches.flatMap((b) => b.threadIds);
  if (manifest.threadCount !== undefined && manifest.threadCount !== manifestThreadIds.length) {
    throw new Error('Manifest threadCount does not match threadIds');
  }
  if (new Set(manifest.batches.map((b) => b.batchId)).size !== manifest.batches.length) {
    throw new Error('Manifest contains duplicate batch IDs');
  }
  if (new Set(manifestThreadIds).size !== manifestThreadIds.length) {
    throw new Error('Manifest contains duplicate thread IDs');
  }

  const expectedBatchIds = new Set(manifest.batches.map((b) => b.batchId));
  const files = (await readdir(resultsRoot)).filter((f) => f.endsWith('.result.json'));
  const resultBatchIds = new Set<string>();
  const seen: CoverageCounts = new Map();
  const threads: JudgedThread[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(resultsRoot, file), 'utf8');
    const parsed = parseResultFile(raw, file);
    if (!expectedBatchIds.has(parsed.batchId)) {
      throw new Error(`Unexpected result batch ${parsed.batchId}`);
    }
    if (resultBatchIds.has(parsed.batchId)) {
      throw new Error(`Duplicate result batch ${parsed.batchId}`);
    }
    resultBatchIds.add(parsed.batchId);
    for (const t of parsed.threads) {
      seen.set(t.threadId, (seen.get(t.threadId) ?? 0) + 1);
      threads.push({ ...t, batchId: parsed.batchId });
    }
  }
  if (resultBatchIds.size !== expectedBatchIds.size) {
    throw new Error(
      `Expected ${expectedBatchIds.size} result batches, found ${resultBatchIds.size}`,
    );
  }

  const coverage = countCoverage(manifestThreadIds, seen);

  const intentCounts: Record<string, number> = {};
  const routeCounts: Record<string, number> = {};
  const toolDemandCounts: Record<string, number> = {};
  const toolVerbCounts: Record<string, number> = {};
  let humanLockCount = 0;
  let lowConfidenceCount = 0;
  let toolHitlCount = 0;
  for (const t of threads) {
    intentCounts[t.intentClass] = (intentCounts[t.intentClass] ?? 0) + 1;
    routeCounts[t.routeSlug] = (routeCounts[t.routeSlug] ?? 0) + 1;
    if (t.humanLockRequired) humanLockCount += 1;
    if (t.confidence === 'low') lowConfidenceCount += 1;
    for (const d of t.toolDemand) {
      toolDemandCounts[d.disposition] = (toolDemandCounts[d.disposition] ?? 0) + 1;
      toolVerbCounts[d.verb] = (toolVerbCounts[d.verb] ?? 0) + 1;
      if (d.hitlRequired) toolHitlCount += 1;
    }
  }

  return {
    threads,
    coverage,
    intentCounts,
    routeCounts,
    humanLockCount,
    lowConfidenceCount,
    toolDemandCounts,
    toolVerbCounts,
    toolHitlCount,
  };
}

export function buildReconciliation(
  threads: Array<Pick<JudgedThread, 'threadId' | 'intentClass'>>,
  censusIntentHints: Record<string, string>,
): {
  compared: number;
  agreements: number;
  overturns: Array<{ threadId: string; censusIntent: string; judgeIntent: ThreadIntentClass }>;
  unhinted: number;
  agreementRate: number;
} {
  let agreements = 0;
  let compared = 0;
  let unhinted = 0;
  const overturns: Array<{
    threadId: string;
    censusIntent: string;
    judgeIntent: ThreadIntentClass;
  }> = [];
  for (const t of threads) {
    const hint = censusIntentHints[t.threadId];
    const acceptable = hint
      ? INTENT_CLASS_TO_CENSUS_INTENTS[t.intentClass].includes(hint)
      : undefined;
    if (hint === undefined) {
      unhinted += 1;
      continue;
    }
    compared += 1;
    if (acceptable) {
      agreements += 1;
    } else {
      overturns.push({ threadId: t.threadId, censusIntent: hint, judgeIntent: t.intentClass });
    }
  }
  return {
    compared,
    agreements,
    overturns,
    unhinted,
    agreementRate: compared === 0 ? 0 : agreements / compared,
  };
}
