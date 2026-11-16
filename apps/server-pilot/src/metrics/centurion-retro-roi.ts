import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';

export const RETRO_WORKFLOWS = ['create', 'amend', 'quote', 'cancel', 'filing', 'other'] as const;
export const RETRO_OUTCOMES = [
  'correct_complete', 'minor_correction', 'wrong_preparation', 'partial', 'unsupported', 'unknown',
] as const;
const instant = z.string().datetime({ offset: true });
const text = z.string().max(8000);
const count = z.number().int().nonnegative();
const sourceSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().nullable(),
  subject: text,
  from: z.string(),
  receivedAt: instant,
  timestampBasis: z.enum(['received_at', 'sent_at_confirmed_outbound', 'sent_at_fallback', 'created_at', 'missing']).optional(),
  quote: text,
  duplicateMessageIds: z.array(z.string()).default([]),
});
const evidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['source', 'preparation', 'historical_native', 'later_outcome']),
  reference: z.string().min(1).max(2000),
  observedAt: instant,
  detail: text,
});
const checkSchema = z.object({
  kind: z.enum(['email', 'hms']).optional(),
  requirement: text,
  status: z.enum(['matched', 'missing', 'mismatch']),
  sourceValue: text,
  preparedValue: text,
  evidenceIds: z.array(z.string()).min(1),
});
const replaySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_run'), reason: text }),
  z.object({
    status: z.literal('replayed'),
    replayId: z.string().min(1),
    nativeEvidence: z.enum(['complete', 'missing']),
    checks: z.array(checkSchema),
  }),
]);

export const retroTaskSchema = z.object({
  id: z.string().min(1).max(500),
  workflow: z.enum(RETRO_WORKFLOWS),
  requestedAt: instant,
  sources: z.array(sourceSchema).min(1).max(32),
  originalAsk: text,
  navaPreparation: text,
  remainingWork: z.array(text).max(40),
  outcome: z.enum(RETRO_OUTCOMES),
  reason: text,
  complexity: z.object({ rooms: count.nullable(), guests: count.nullable(), targets: count.nullable() }),
  workItemId: z.string().nullable(),
  bookingReferences: z.array(z.string()).max(32),
  evidence: z.array(evidenceSchema).max(100),
  replay: replaySchema,
});
export type RetroTask = z.infer<typeof retroTaskSchema>;

export const retroReportSchema = z.object({
  version: z.literal('centurion-retro-roi/1'),
  reportId: z.string().min(1),
  propertyCode: z.literal('HRCEN'),
  generatedAt: instant,
  period: z.object({ start: instant, end: instant, timezone: z.literal('Africa/Johannesburg') }),
  provenance: z.object({
    sourceSnapshotId: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    productSha: z.string().regex(/^[a-f0-9]{40}$/),
    runnerVersion: z.string().min(1),
    model: z.string().min(1),
  }),
  coverage: z.object({
    status: z.enum(['complete', 'partial']),
    sourceExportedAt: instant,
    sourceThrough: instant.nullable(),
    rawMessages: count,
    canonicalMessages: count,
    inboundMessages: count,
    classifiedMessages: count,
    excludedMessages: count,
    duplicateMessages: count,
    unknownTimestampMessages: count,
    failedMessages: count,
    notes: z.array(text).max(40),
  }),
  tasks: z.array(retroTaskSchema).max(15000),
}).superRefine((report, ctx) => {
  const start = Date.parse(report.period.start);
  const end = Date.parse(report.period.end);
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (end - start !== 30 * 24 * 60 * 60 * 1000) issue('Report must cover exactly 30 days');
  if (end > Date.parse(report.generatedAt)) issue('Report cutoff is after generation');
  const c = report.coverage;
  if (c.classifiedMessages + c.failedMessages > c.inboundMessages) issue('Invalid classification counts');
  if (c.excludedMessages > c.classifiedMessages) issue('Invalid excluded count');
  if (c.inboundMessages > c.canonicalMessages || c.canonicalMessages > c.rawMessages) issue('Invalid source counts');
  if (c.status === 'complete' && (c.classifiedMessages !== c.inboundMessages || c.failedMessages > 0 ||
      c.unknownTimestampMessages > 0 || !c.sourceThrough || Date.parse(c.sourceThrough) < end)) {
    issue('Complete coverage requires a complete source and classification');
  }
  const ids = new Set<string>();
  for (const task of report.tasks) {
    if (ids.has(task.id)) issue('Duplicate task identity');
    ids.add(task.id);
    const at = Date.parse(task.requestedAt);
    if (at < start || at >= end) issue('Task outside report period');
    if (!task.sources.some(source => Date.parse(source.receivedAt) === at)) issue('Task request source missing');
    if (task.sources.some(source => Date.parse(source.receivedAt) > at)) issue('Future source in request context');
    if (task.evidence.some(e => (e.kind === 'historical_native' || e.kind === 'source') && Date.parse(e.observedAt) > at)) {
      issue('Future evidence used as request-time source');
    }
    const evidenceIds = new Set(task.evidence.map(e => e.id));
    if (evidenceIds.size !== task.evidence.length) issue('Duplicate evidence identity');
    if (task.replay.status === 'replayed' && task.replay.checks.some(check =>
      check.evidenceIds.some(id => !evidenceIds.has(id)))) issue('Missing check evidence');
    if (task.outcome === 'correct_complete') {
      if (!task.sources.some(source => Date.parse(source.receivedAt) === at && source.timestampBasis === 'received_at')) {
        issue('Correct complete requires a known request receipt timestamp');
      }
      if (task.replay.status !== 'replayed' || task.replay.nativeEvidence !== 'complete' ||
          task.replay.checks.length === 0 || task.replay.checks.some(check => check.status !== 'matched') ||
          task.remainingWork.length > 0 || !task.evidence.some(e => e.kind === 'preparation') ||
          !task.evidence.some(e => e.kind === 'historical_native')) {
        issue('Correct complete requires grounded, complete replay checks');
      }
    }
  }
});
export type RetroReport = z.infer<typeof retroReportSchema>;
export type StaffRetroReport = Omit<RetroReport, 'provenance'> & { provenance: Record<string, never> };

function staffExplanation(value: string, fallback: string, sourceNames: ReadonlySet<string>): string {
  return value
    .replace(/\s*Prior valid .*? grade retained from the compatible reviewed producer\.?/gi, '')
    .replace(/\b(?:gpt-[a-z0-9_.-]+|luna|terra|sol|astra)\b/gi, name => sourceNames.has(name.toLowerCase()) ? name : 'Nava')
    .replace(/(?<![\w:/])(?:\/[^\s"'<>]+|[a-z]:[\\/][^\s"'<>]+)/gi, 'supporting evidence')
    .trim() || fallback;
}

export function toStaffRetroReport(report: RetroReport): StaffRetroReport {
  const progressNotes = report.coverage.notes.flatMap(note => {
    const progress = note.startsWith('Pending measurements:')
      ? note.split('. ')[0]
      : /^(?:PARTIAL LIVE SNAPSHOT:|Selected \d+\/\d+ inbound messages;)/.test(note) ? note : undefined;
    return progress ? [staffExplanation(progress, '', new Set<string>())] : [];
  });
  return {
    version: report.version,
    reportId: report.reportId,
    propertyCode: report.propertyCode,
    generatedAt: report.generatedAt,
    period: report.period,
    // Older open dashboards read this object before their next page reload.
    provenance: {},
    coverage: {
      ...report.coverage,
      notes: [
        report.coverage.status === 'partial'
          ? 'This is a partial retrospective. Assessed tasks are a subset of captured email; unresolved measurements remain pending or failed and are excluded from task outcomes.'
          : 'Source coverage and classification are complete. Preparation quality is assessed separately for each task.',
        'Email extraction is assessed against the request. HMS-dependent work without historical evidence is not measurable from history.',
        'Effort minutes are estimates, not measured staff savings. There is no monthly savings extrapolation.',
        ...progressNotes,
      ],
    },
    tasks: report.tasks.map(task => {
      const sourceValues = [...task.sources.map(source => source.quote), ...(task.replay.status === 'replayed' ? task.replay.checks.map(check => check.sourceValue) : [])];
      const sourceNames = new Set(sourceValues.flatMap(value => value.toLowerCase().match(/\b(?:luna|terra|sol|astra)\b/g) ?? []));
      const preparation = staffExplanation(task.navaPreparation, 'No preparation recorded.', sourceNames);
      return {
        ...task,
        navaPreparation: preparation,
        remainingWork: task.remainingWork.map(work => staffExplanation(work, 'Staff verification is required.', sourceNames)),
        reason: staffExplanation(task.reason, 'See the requested and prepared values for this assessment.', sourceNames),
        evidence: task.evidence.map(evidence => ({
          ...evidence,
          reference: evidence.id,
          detail: evidence.kind === 'preparation'
            ? preparation
            : evidence.kind === 'historical_native'
              ? 'Historical HMS observation recorded; see the linked checks for its result.'
              : evidence.detail,
        })),
        replay: task.replay.status === 'not_run'
          ? { ...task.replay, reason: staffExplanation(task.replay.reason, 'Preparation has not been assessed.', sourceNames) }
          : { ...task.replay, replayId: task.id },
      };
    }),
  };
}

export type RetroReportResponse =
  | { status: 'ready'; report: RetroReport }
  | { status: 'unavailable'; reason: 'not_available' | 'invalid_report' };

const DEFAULT_REPORT_PATH = '/home/ubuntu/.local/share/zero/centurion-retro-roi/report.json';
export const RETRO_ROI_MAX_REPORT_BYTES = 32 * 1024 * 1024;

export async function loadCenturionRetroRoiReport(): Promise<RetroReportResponse> {
  const reportPath = process.env.CENTURION_RETRO_ROI_REPORT_PATH || DEFAULT_REPORT_PATH;
  try {
    const info = await stat(reportPath);
    if (!info.isFile() || info.size > RETRO_ROI_MAX_REPORT_BYTES) return { status: 'unavailable', reason: 'invalid_report' };
    const parsed = retroReportSchema.safeParse(JSON.parse(await readFile(reportPath, 'utf8')));
    return parsed.success
      ? { status: 'ready', report: parsed.data }
      : { status: 'unavailable', reason: 'invalid_report' };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error && 'code' in error &&
      error.code === 'ENOENT' ? 'not_available' : 'invalid_report' };
  }
}
