/**
 * Label dataset contract, per-field scorers and pass criteria for the label backtest (v5 B4). Pure: no database, no model
 * and no network. The scorers are deterministic createScorer steps (function steps only, no LLM judge). A label is scored
 * only when a person made it: a correction (the value they kept) or a confirmation (the AI value they kept unchanged).
 * Notes and run flags carry no extraction field, so they are not scored. Of a field's labels only the last counts: an
 * earlier edit that staff changed again is not gold. An address or phone is masked in the dataset, so it compares by a
 * salted hash of its raw value (computed before masking) rather than by its masked text.
 */
import { aiValueAt, contactFieldOf, parseFieldPath } from './work-items.js';
import { EVAL_LABEL_KINDS, EVAL_LABEL_SPLITS } from '../db/schema/work.js';
import type { MailExtractionPayload } from './extraction/schema.js';
import { createScorer } from '@mastra/core/evals';
import { maskMailText } from './card-mask.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const EVAL_SCHEMA_VERSION = 'work-event-label/v2' as const;
export type Split = (typeof EVAL_LABEL_SPLITS)[number];
export type LabelKind = (typeof EVAL_LABEL_KINDS)[number];

const valueHashSchema = z.object({
  salt: z.string().min(1),
  ai: z.string().nullable(),
  human: z.string().nullable(),
});
/** Salted hashes of a contact label's AI and kept values, from the raw values. Null for every other field. */
export type ValueHash = z.infer<typeof valueHashSchema>;

/** sha256 hex of a mail domain. The domains are kept only as digests, never in clear. */
const domainDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const labelCaseSchema = z.object({
  schema_version: z.literal(EVAL_SCHEMA_VERSION),
  work_item_id: z.string().min(1),
  message_id: z.string().nullable(),
  transport_id: z.string().nullable(),
  kind: z.string(),
  extractor_version: z.string().nullable(),
  mailbox_domain_sha256: domainDigestSchema.nullable(),
  sender_domain_sha256: domainDigestSchema.nullable(),
  subject: z.string(),
  text: z.string(),
  split: z.enum(EVAL_LABEL_SPLITS),
  split_source: z.enum(['golden', 'stored', 'hash', 'time']),
  labels: z.array(
    z.object({
      event_id: z.string(),
      field_id: z.string(),
      label_kind: z.enum(EVAL_LABEL_KINDS),
      ai_source: z.string().nullable(),
      ai_value: z.unknown(),
      human_value: z.unknown(),
      value_hash: valueHashSchema.nullable(),
    }),
  ),
});
/** One labelled work item in the dataset file, masked. */
export type LabelCase = z.infer<typeof labelCaseSchema>;
export type LabelRow = LabelCase['labels'][number];

/** Parses a dataset JSONL file. A bad line throws with its line number; the file is never read as partly valid. */
export function parseLabelCases(jsonl: string): LabelCase[] {
  return jsonl.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`dataset line ${index + 1} is not JSON`);
    }
    const parsed = labelCaseSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ');
      throw new Error(`dataset line ${index + 1} is invalid: ${issues}`);
    }
    return [parsed.data];
  });
}

/** What one extraction run produced for a case. `extraction` is null when the run failed. */
export type CandidateTrace = {
  extraction: { kind: string; payload: MailExtractionPayload } | null;
  error?: string;
};

/**
 * Scoring group of an extraction field: stay.* (dates, removal), row.* (rooms, adults, room type, child ages, board, removal),
 * contact.* and other. Removal is scored as presence: a removed stay or row must be absent from the candidate.
 */
export function fieldClassOf(fieldId: string): string {
  const contact = contactFieldOf(fieldId);
  if (contact) return `contact.${contact}`;
  const path = parseFieldPath(fieldId);
  if (!path) return 'other';
  const scope = path.rowId === null ? 'stay' : 'row';
  return `${scope}.${path.field}`;
}

const isRemovalClass = (fieldClass: string) =>
  fieldClass === 'stay.removed' || fieldClass === 'row.removed';
const scoreable = (label: LabelRow) =>
  (label.label_kind === 'correction' || label.label_kind === 'confirmation') &&
  fieldClassOf(label.field_id) !== 'other';

/** The value a person kept: the AI value for a confirmation, the edited value for a correction. */
const truthOf = (label: LabelRow) =>
  label.label_kind === 'confirmation' ? label.ai_value : label.human_value;

/** JSON equality with null for undefined, and card-and-contact masking on the candidate side. */
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function maskStrings(value: unknown): unknown {
  if (typeof value === 'string') return maskMailText(value);
  if (Array.isArray(value)) return value.map(maskStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, maskStrings(inner)]),
    );
  }
  return value;
}

/**
 * The labels that count: the last correction or confirmation for each field of the case. Staff who change a value twice
 * leave two labels, and only the final one is the value they kept. Labels arrive oldest first, as the export writes them.
 */
export function finalLabels(labels: readonly LabelRow[]): LabelRow[] {
  const last = new Map<string, LabelRow>();
  for (const label of labels) if (scoreable(label)) last.set(label.field_id, label);
  return [...last.values()];
}

/** Address and phone: the two contact fields the masks change. They compare by hash, not by masked text. */
const HASHED_FIELD_CLASSES: ReadonlySet<string> = new Set(['contact.email', 'contact.phone']);
const isHashedField = (fieldId: string) => HASHED_FIELD_CLASSES.has(fieldClassOf(fieldId));

/** A contact value as it is compared: an address lowercased, a phone reduced to its digits and leading +. */
function normalizeContact(fieldId: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  return fieldClassOf(fieldId) === 'contact.phone' ? text.replace(/[^\d+]/g, '') : text.toLowerCase();
}

/** Salted SHA-256 of a normalized contact value. The salt is random per label, so the same address never links two labels. */
function hashContact(salt: string, normalized: string | null): string | null {
  return normalized === null
    ? null
    : createHash('sha256').update(`${salt}\0${normalized}`).digest('hex');
}

/**
 * The hashes an address or phone label carries, taken from the raw values before masking. Other fields carry none.
 * The export calls this; the scorer compares a candidate's raw value against them.
 */
export function contactValueHash(
  fieldId: string,
  aiValue: unknown,
  humanValue: unknown,
  salt: string,
): ValueHash | null {
  if (!isHashedField(fieldId)) return null;
  return {
    salt,
    ai: hashContact(salt, normalizeContact(fieldId, aiValue)),
    human: hashContact(salt, normalizeContact(fieldId, humanValue)),
  };
}

/** The hash of the value a person kept: the AI hash for a confirmation, the edited value's hash for a correction. */
const keptHashOf = (hash: ValueHash, kind: LabelKind) =>
  kind === 'confirmation' ? hash.ai : hash.human;

/** Whether the candidate's raw contact value is the value the person kept. A label without hashes never matches. */
function hashedMatch(label: LabelRow, candidate: unknown): boolean {
  if (!label.value_hash) return false;
  const kept = keptHashOf(label.value_hash, label.label_kind);
  return hashContact(label.value_hash.salt, normalizeContact(label.field_id, candidate)) === kept;
}

/**
 * Whether the candidate gets this label's field right. Removal is presence; addresses and phones compare by hash; other
 * fields compare masked values.
 */
export function candidateCorrect(label: LabelRow, payload: MailExtractionPayload): boolean {
  const truth = truthOf(label);
  const fieldClass = fieldClassOf(label.field_id);
  if (isRemovalClass(fieldClass)) {
    const path = parseFieldPath(label.field_id)!;
    const stay = payload.stays.find((item) => item.id === path.stayId);
    const present =
      path.rowId === null
        ? stay !== undefined
        : (stay?.rows.some((row) => row.id === path.rowId) ?? false);
    return present === (truth !== true);
  }
  if (isHashedField(label.field_id)) return hashedMatch(label, aiValueAt(payload, label.field_id));
  return sameValue(maskStrings(aiValueAt(payload, label.field_id)), maskStrings(truth));
}

/** The baseline is production's own value (the AI value stored on the label), scored the same way. */
export function baselineCorrect(label: LabelRow): boolean {
  if (isRemovalClass(fieldClassOf(label.field_id))) return truthOf(label) !== true;
  if (isHashedField(label.field_id)) {
    if (!label.value_hash) return false;
    return label.value_hash.ai === keptHashOf(label.value_hash, label.label_kind);
  }
  return sameValue(maskStrings(label.ai_value), maskStrings(truthOf(label)));
}

// ---- per-field scorers: createScorer function steps, deterministic ----

type FieldCheck = { label: LabelRow; payload: MailExtractionPayload | null };
const fieldScorers = new Map<string, ReturnType<typeof buildFieldScorer>>();
function buildFieldScorer(fieldClass: string) {
  return createScorer<FieldCheck, FieldCheck, string>({
    id: `label-field-${fieldClass}`,
    description: `Scores 1 when the extraction gets the labelled ${fieldClass} value right`,
  }).generateScore(({ run }) => {
    const { label, payload } = run.input!;
    return payload !== null && candidateCorrect(label, payload) ? 1 : 0;
  });
}
function fieldScorer(fieldClass: string) {
  let scorer = fieldScorers.get(fieldClass);
  if (!scorer) {
    scorer = buildFieldScorer(fieldClass);
    fieldScorers.set(fieldClass, scorer);
  }
  return scorer;
}

const kindScorer = createScorer<{ staffKind: string }, { candidateKind: string | null }, string>({
  id: 'label-kind',
  description: 'Scores 1 when the extraction kind equals the kind the staff kept',
}).generateScore(({ run }) => (run.output!.candidateKind === run.input!.staffKind ? 1 : 0));

/** Score of one labelled field for the candidate: 1 or 0. */
export async function scoreField(
  label: LabelRow,
  payload: MailExtractionPayload | null,
): Promise<number> {
  const check: FieldCheck = { label, payload };
  const result = await fieldScorer(fieldClassOf(label.field_id)).run({
    input: check,
    output: check,
  });
  return result.score === 1 ? 1 : 0;
}

/** Score of the kind: 1 when the candidate's kind equals the staff-kept kind. */
export async function scoreKind(staffKind: string, candidateKind: string | null): Promise<number> {
  const result = await kindScorer.run({ input: { staffKind }, output: { candidateKind } });
  return result.score === 1 ? 1 : 0;
}

// ---- summary and pass criteria ----

export type Pct = { n: number; correct: number; pct: number | null };
export type FieldSummary = {
  n: number;
  baselinePct: number | null;
  candidatePct: number | null;
  dropPoints: number | null;
};
export type LabelSummary = {
  cases: number;
  unanswered: number;
  byField: Record<string, FieldSummary>;
  /** Stay-level labels: stay dates and stay removal. Must be 100%. */
  stays: Pct;
  /** Booked-date labels. The pane has no booked-date path today, so this is usually n=0 and skipped. Must be 100%. */
  booked: Pct;
  /** Every confirmation the person kept. Must be 100%. */
  confirmations: Pct;
  kind: FieldSummary;
  bySplit: Record<Split, Pct>;
  /** Candidate accuracy, dev minus holdout, in points. */
  gapPoints: number | null;
};

export const LABEL_GATES = {
  maxFieldDropPoints: 5,
  maxKindDropPoints: 10,
  kindMinN: 30,
  maxGapPoints: 10,
} as const;

const pctOf = (n: number, correct: number): Pct => ({
  n,
  correct,
  pct: n ? Math.round((correct / n) * 1e4) / 100 : null,
});
const dropOf = (
  baseline: { pct: number | null },
  candidate: { pct: number | null },
): number | null =>
  baseline.pct === null || candidate.pct === null
    ? null
    : Math.round((baseline.pct - candidate.pct) * 100) / 100;

/**
 * Scores every case. A case with no extraction is unanswered: its labels and its kind count as wrong, so an incomplete
 * run cannot pass. The kind is scored once per case that has a label.
 */
export async function scoreLabelCases(
  cases: readonly LabelCase[],
  traces: ReadonlyMap<string, CandidateTrace>,
): Promise<LabelSummary> {
  const field = new Map<string, { n: number; base: number; cand: number }>();
  const split: Record<Split, { n: number; correct: number }> = {
    dev: { n: 0, correct: 0 },
    holdout: { n: 0, correct: 0 },
    test: { n: 0, correct: 0 },
  };
  const stays = { n: 0, correct: 0 };
  const booked = { n: 0, correct: 0 };
  const confirmations = { n: 0, correct: 0 };
  const kind = { n: 0, base: 0, cand: 0 };
  let unanswered = 0;

  for (const row of cases) {
    const trace = traces.get(row.work_item_id);
    const payload = trace?.extraction?.payload ?? null;
    const answered = payload !== null;
    if (!answered) unanswered += 1;
    if (row.labels.length) {
      kind.n += 1;
      kind.base += 1;
      if (trace?.extraction && (await scoreKind(row.kind, trace.extraction.kind)) === 1)
        kind.cand += 1;
    }
    for (const label of finalLabels(row.labels)) {
      const fieldClass = fieldClassOf(label.field_id);
      const base = baselineCorrect(label) ? 1 : 0;
      const cand = answered ? await scoreField(label, payload) : 0;
      const entry = field.get(fieldClass) ?? { n: 0, base: 0, cand: 0 };
      field.set(fieldClass, { n: entry.n + 1, base: entry.base + base, cand: entry.cand + cand });
      split[row.split].n += 1;
      split[row.split].correct += cand;
      if (fieldClass.startsWith('stay.')) {
        stays.n += 1;
        stays.correct += cand;
      }
      if (fieldClass.startsWith('booked.')) {
        booked.n += 1;
        booked.correct += cand;
      }
      if (label.label_kind === 'confirmation') {
        confirmations.n += 1;
        confirmations.correct += cand;
      }
    }
  }

  const byField: Record<string, FieldSummary> = {};
  for (const [fieldClass, entry] of field) {
    const baseline = pctOf(entry.n, entry.base);
    const candidate = pctOf(entry.n, entry.cand);
    byField[fieldClass] = {
      n: entry.n,
      baselinePct: baseline.pct,
      candidatePct: candidate.pct,
      dropPoints: dropOf(baseline, candidate),
    };
  }
  const kindBaseline = pctOf(kind.n, kind.base);
  const kindCandidate = pctOf(kind.n, kind.cand);
  const bySplit = {
    dev: pctOf(split.dev.n, split.dev.correct),
    holdout: pctOf(split.holdout.n, split.holdout.correct),
    test: pctOf(split.test.n, split.test.correct),
  };
  const gapPoints =
    bySplit.dev.pct !== null && bySplit.holdout.pct !== null
      ? Math.round((bySplit.dev.pct - bySplit.holdout.pct) * 100) / 100
      : null;
  return {
    cases: cases.length,
    unanswered,
    byField,
    stays: pctOf(stays.n, stays.correct),
    booked: pctOf(booked.n, booked.correct),
    confirmations: pctOf(confirmations.n, confirmations.correct),
    kind: {
      n: kind.n,
      baselinePct: kindBaseline.pct,
      candidatePct: kindCandidate.pct,
      dropPoints: dropOf(kindBaseline, kindCandidate),
    },
    bySplit,
    gapPoints,
  };
}

export type GateCheck = { name: string; status: 'pass' | 'fail' | 'skipped'; detail: string };

/**
 * The pass criteria. stays, booked and confirmations must be 100% where labelled. A field may drop at most 5 points
 * against production. Kind may drop at most 10 points, judged only from 30 cases. Dev may beat holdout by at most 10 points.
 * A criterion with nothing to score is skipped and says so; the run passes only when no criterion fails.
 */
export function evaluateLabelGates(summary: LabelSummary): { pass: boolean; checks: GateCheck[] } {
  const checks: GateCheck[] = [];
  if (summary.unanswered) {
    checks.push({
      name: 'every case answered',
      status: 'fail',
      detail: `${summary.unanswered} of ${summary.cases} cases have no extraction`,
    });
  }
  for (const [name, part] of [
    ['stays', summary.stays],
    ['booked', summary.booked],
    ['confirmations', summary.confirmations],
  ] as const) {
    checks.push(
      part.n === 0
        ? { name: `${name} 100%`, status: 'skipped', detail: 'no labelled cases' }
        : {
            name: `${name} 100%`,
            status: part.pct === 100 ? 'pass' : 'fail',
            detail: `${part.correct} of ${part.n} (${part.pct}%)`,
          },
    );
  }
  for (const [fieldClass, part] of Object.entries(summary.byField)) {
    const failed = part.dropPoints !== null && part.dropPoints > LABEL_GATES.maxFieldDropPoints;
    checks.push({
      name: `field ${fieldClass} drop <= ${LABEL_GATES.maxFieldDropPoints}`,
      status: part.dropPoints === null ? 'skipped' : failed ? 'fail' : 'pass',
      detail: `production ${part.baselinePct}%, candidate ${part.candidatePct}% of ${part.n}`,
    });
  }
  const kind = summary.kind;
  const kindFailed = kind.dropPoints !== null && kind.dropPoints > LABEL_GATES.maxKindDropPoints;
  checks.push({
    name: `kind drop <= ${LABEL_GATES.maxKindDropPoints} (n >= ${LABEL_GATES.kindMinN})`,
    status: kind.n < LABEL_GATES.kindMinN ? 'skipped' : kindFailed ? 'fail' : 'pass',
    detail: `n=${kind.n}, production ${kind.baselinePct}%, candidate ${kind.candidatePct}%`,
  });
  checks.push(
    summary.gapPoints === null
      ? {
          name: `dev-holdout gap <= ${LABEL_GATES.maxGapPoints}`,
          status: 'skipped',
          detail: 'dev or holdout has no labels',
        }
      : {
          name: `dev-holdout gap <= ${LABEL_GATES.maxGapPoints}`,
          status: summary.gapPoints > LABEL_GATES.maxGapPoints ? 'fail' : 'pass',
          detail: `gap ${summary.gapPoints} points`,
        },
  );
  return { pass: checks.every((check) => check.status !== 'fail'), checks };
}
