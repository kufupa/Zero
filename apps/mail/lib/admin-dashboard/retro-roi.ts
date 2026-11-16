import type { Outputs } from '@zero/server/trpc';
import { z } from 'zod';

export type RetroResponse = Outputs['adminDashboard']['getRetroReport'];
export type RetroReport = Extract<RetroResponse, { status: 'ready' }>['report'];
export type RetroTask = RetroReport['tasks'][number];
export type RetroWorkflow = RetroTask['workflow'];
export type RetroOutcome = RetroTask['outcome'];

export const WORKFLOWS: RetroWorkflow[] = ['create', 'amend', 'quote', 'cancel', 'filing', 'other'];
export const OUTCOMES: RetroOutcome[] = [
  'correct_complete',
  'minor_correction',
  'wrong_preparation',
  'partial',
  'unsupported',
  'unknown',
];

export const WORKFLOW_LABELS: Record<RetroWorkflow, string> = {
  create: 'Create reservation',
  amend: 'Amend reservation',
  quote: 'Quote',
  cancel: 'Cancel reservation',
  filing: 'File documents',
  other: 'Other work',
};

export const OUTCOME_LABELS: Record<RetroOutcome, string> = {
  correct_complete: 'Correct & complete',
  minor_correction: 'Minor correction',
  wrong_preparation: 'Wrong preparation',
  partial: 'Partial preparation',
  unsupported: 'Unsupported',
  unknown: 'Unknown',
};

export const OUTCOME_COLORS: Record<RetroOutcome, { bar: string; badge: string }> = {
  correct_complete: {
    bar: 'bg-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  minor_correction: {
    bar: 'bg-amber-400',
    badge: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  },
  wrong_preparation: {
    bar: 'bg-rose-500',
    badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  },
  partial: { bar: 'bg-sky-400', badge: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  unsupported: { bar: 'bg-slate-400', badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300' },
  unknown: { bar: 'bg-violet-400', badge: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
};

export const MAX_TIMING_MINUTES = 240;
const minuteSchema = z.number().finite().min(0).max(MAX_TIMING_MINUTES);
export const timingSchema = z.object({
  manualMinutes: minuteSchema,
  assistedMinutes: minuteSchema,
});
export type Timing = z.infer<typeof timingSchema>;
export const DEFAULT_TIMING: Timing = { manualMinutes: 6, assistedMinutes: 2 };

const assumptionsSchema = z.object({
  global: timingSchema,
  workflows: z.object({
    create: timingSchema.optional(),
    amend: timingSchema.optional(),
    quote: timingSchema.optional(),
    cancel: timingSchema.optional(),
    filing: timingSchema.optional(),
    other: timingSchema.optional(),
  }),
});
export type Assumptions = z.infer<typeof assumptionsSchema>;
export const DEFAULT_ASSUMPTIONS: Assumptions = { global: DEFAULT_TIMING, workflows: {} };

export function readAssumptions(storageKey: string): Assumptions {
  try {
    const saved = typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey);
    if (!saved) return DEFAULT_ASSUMPTIONS;
    const parsed = assumptionsSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : DEFAULT_ASSUMPTIONS;
  } catch {
    return DEFAULT_ASSUMPTIONS;
  }
}

export function writeAssumptions(storageKey: string, assumptions: Assumptions): boolean {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(assumptions));
    return true;
  } catch {
    return false;
  }
}

export function workflowTiming(assumptions: Assumptions, workflow: RetroWorkflow): Timing {
  return assumptions.workflows[workflow] ?? assumptions.global;
}

export function taskCredit(task: RetroTask, assumptions: Assumptions): number {
  if (task.outcome !== 'correct_complete') return 0;
  const timing = workflowTiming(assumptions, task.workflow);
  return timing.manualMinutes - timing.assistedMinutes;
}

type PreparationCheck = Extract<RetroTask['replay'], { status: 'replayed' }>['checks'][number];
const HMS_CHECK_COUNTS: Record<RetroWorkflow, number> = {
  create: 4,
  amend: 3,
  quote: 2,
  cancel: 2,
  filing: 2,
  other: 1,
};

export function preparationCheckKind(task: RetroTask, check: PreparationCheck): 'email' | 'hms' {
  if (check.kind) return check.kind;
  return check.sourceValue === 'Historical native verification required' ||
    task.evidence.some(
      (evidence) =>
        evidence.kind === 'historical_native' && check.evidenceIds.includes(evidence.id),
    )
    ? 'hms'
    : 'email';
}

export function extractionQuality(tasks: RetroTask[]) {
  let matched = 0,
    missing = 0,
    mismatch = 0,
    measuredTasks = 0,
    completeTasks = 0;
  let hmsMatched = 0,
    hmsUnmeasurable = 0,
    hmsMismatch = 0,
    hmsDependentTasks = 0,
    hmsUnmeasurableTasks = 0;
  for (const task of tasks) {
    if (task.replay.status !== 'replayed') continue;
    const email = task.replay.checks.filter(
      (check) => preparationCheckKind(task, check) === 'email',
    );
    const hms = task.replay.checks.filter((check) => preparationCheckKind(task, check) === 'hms');
    if (email.length) {
      measuredTasks++;
      completeTasks += Number(email.every((check) => check.status === 'matched'));
    }
    matched += email.filter((check) => check.status === 'matched').length;
    missing += email.filter((check) => check.status === 'missing').length;
    mismatch += email.filter((check) => check.status === 'mismatch').length;
    hmsDependentTasks++;
    hmsUnmeasurableTasks += Number(task.replay.nativeEvidence === 'missing');
    hmsMatched += hms.filter((check) => check.status === 'matched').length;
    hmsUnmeasurable +=
      hms.filter((check) => check.status === 'missing').length +
      Math.max(0, HMS_CHECK_COUNTS[task.workflow] - hms.length);
    hmsMismatch += hms.filter((check) => check.status === 'mismatch').length;
  }
  const total = matched + missing + mismatch;
  return {
    matched,
    missing,
    mismatch,
    total,
    measuredTasks,
    completeTasks,
    percent: total ? (100 * matched) / total : null,
    hmsMatched,
    hmsUnmeasurable,
    hmsMismatch,
    hmsDependentTasks,
    hmsUnmeasurableTasks,
  };
}

export function taskProRataEstimate(task: RetroTask, assumptions: Assumptions): number {
  if (task.outcome === 'correct_complete') return taskCredit(task, assumptions);
  if (task.outcome !== 'partial' || task.replay.status !== 'replayed' || !task.replay.checks.length)
    return 0;
  const timing = workflowTiming(assumptions, task.workflow);
  const nativeChecks = task.replay.checks.filter(
    (check) => preparationCheckKind(task, check) === 'hms',
  ).length;
  const requiredChecks =
    task.replay.checks.length + Math.max(0, HMS_CHECK_COUNTS[task.workflow] - nativeChecks);
  return (
    ((timing.manualMinutes - timing.assistedMinutes) *
      task.replay.checks.filter((check) => check.status === 'matched').length) /
    requiredChecks
  );
}

function emptyOutcomes(): Record<RetroOutcome, number> {
  return {
    correct_complete: 0,
    minor_correction: 0,
    wrong_preparation: 0,
    partial: 0,
    unsupported: 0,
    unknown: 0,
  };
}

export function forecastReport(report: RetroReport, assumptions: Assumptions) {
  const outcomes = emptyOutcomes();
  const workflows = WORKFLOWS.map((workflow) => ({
    workflow,
    tasks: report.tasks.filter((task) => task.workflow === workflow),
    outcomes: emptyOutcomes(),
    savedMinutes: 0,
    proRataMinutes: 0,
    extraction: extractionQuality(report.tasks.filter((task) => task.workflow === workflow)),
  }));
  let savedMinutes = 0;
  let proRataMinutes = 0;
  for (const row of workflows) {
    for (const task of row.tasks) {
      row.outcomes[task.outcome] += 1;
      outcomes[task.outcome] += 1;
      const credit = taskCredit(task, assumptions);
      row.savedMinutes += credit;
      savedMinutes += credit;
      const estimate = taskProRataEstimate(task, assumptions);
      row.proRataMinutes += estimate;
      proRataMinutes += estimate;
    }
  }
  return {
    outcomes,
    workflows,
    savedMinutes,
    proRataMinutes,
    extraction: extractionQuality(report.tasks),
    taskCount: report.tasks.length,
  };
}

export function unassessedMessageCount(report: RetroReport): number {
  return Math.max(0, report.coverage.inboundMessages - report.coverage.classifiedMessages);
}

const numberFormatter = new Intl.NumberFormat('en-ZA');
const hourFormatter = new Intl.NumberFormat('en-ZA', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat('en-ZA', {
  timeZone: 'Africa/Johannesburg',
  dateStyle: 'medium',
  timeStyle: 'short',
});
export const formatCount = (value: number) => numberFormatter.format(value);
export const formatPercent = (value: number | null) =>
  value === null
    ? 'Not measured'
    : `${new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 1 }).format(value)}%`;
export const formatHours = (minutes: number) => hourFormatter.format(minutes / 60);
export const formatReportDate = (value: string) => dateFormatter.format(new Date(value));

// Export hashes, RFC Message-IDs and illustrative IDs cannot address a mail route.
function isMailRouteId(value: string | null): value is string {
  return (
    value !== null &&
    /^[A-Za-z0-9_-]{8,2048}={0,2}$/.test(value) &&
    !/^[a-f0-9]{40,64}$/i.test(value)
  );
}

export function sourceMailLink(source: RetroTask['sources'][number]): string | null {
  if (!isMailRouteId(source.threadId) || !isMailRouteId(source.messageId)) return null;
  const query = new URLSearchParams({
    threadId: source.threadId,
    sourceMessageId: source.messageId,
  });
  return `/mail/inbox?${query.toString()}`;
}

export function taskMatchesSearch(task: RetroTask, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    task.id,
    task.originalAsk,
    task.navaPreparation,
    task.reason,
    ...task.bookingReferences,
    ...task.sources.flatMap((source) => [source.subject, source.from]),
  ].some((value) => value.toLocaleLowerCase().includes(needle));
}

// Available only after an explicit example selection in frontend-only demo mode.
export const ILLUSTRATIVE_RETRO_REPORT: RetroReport = {
  version: 'centurion-retro-roi/1',
  reportId: 'illustrative-example',
  propertyCode: 'HRCEN',
  generatedAt: '2026-11-16T04:17:49Z',
  period: {
    start: '2026-10-17T04:17:49Z',
    end: '2026-11-16T04:17:49Z',
    timezone: 'Africa/Johannesburg',
  },
  coverage: {
    status: 'partial',
    sourceExportedAt: '2026-11-16T04:17:49Z',
    sourceThrough: '2026-10-28T10:00:00Z',
    rawMessages: 10,
    canonicalMessages: 9,
    inboundMessages: 8,
    classifiedMessages: 7,
    excludedMessages: 1,
    duplicateMessages: 1,
    unknownTimestampMessages: 0,
    failedMessages: 1,
    notes: ['Fictitious records demonstrate the layout, timing controls and preparation outcomes.'],
  },
  tasks: OUTCOMES.map((outcome, index): RetroTask => {
    const requestedAt = '2026-10-28T09:00:00Z';
    const workflow = WORKFLOWS[index] ?? 'other';
    const correct = outcome === 'correct_complete';
    return {
      id: `illustrative:${outcome}`,
      workflow,
      requestedAt,
      sources: [
        {
          messageId: `illustrative:message:${index}`,
          threadId: null,
          subject: `${WORKFLOW_LABELS[workflow]} — illustrative request`,
          from: 'Example agency',
          receivedAt: requestedAt,
          quote: 'Please prepare the requested reservation action for staff review.',
          duplicateMessageIds: [],
        },
      ],
      originalAsk: `An example agency requests one ${WORKFLOW_LABELS[workflow].toLowerCase()} action.`,
      navaPreparation: correct
        ? 'The requested business fields are prepared and checked.'
        : 'This fictitious preparation demonstrates an outcome with zero savings credit.',
      remainingWork: correct ? [] : ['Staff complete or verify the requested work.'],
      outcome,
      reason: correct
        ? 'Illustrative matched preparation and request-time native checks.'
        : `Illustrative ${OUTCOME_LABELS[outcome].toLowerCase()} outcome; no estimated time is credited.`,
      complexity: { rooms: 1, guests: 2, targets: 1 },
      workItemId: null,
      bookingReferences: ['EXAMPLE-BOOKING'],
      evidence: [
        {
          id: `source-${index}`,
          kind: 'source',
          reference: 'Illustrative request',
          observedAt: requestedAt,
          detail: 'Fictitious source email.',
        },
        {
          id: `native-${index}`,
          kind: 'historical_native',
          reference: 'Illustrative native check',
          observedAt: requestedAt,
          detail: 'Fictitious request-time native facts.',
        },
        {
          id: `prep-${index}`,
          kind: 'preparation',
          reference: 'Illustrative preparation',
          observedAt: requestedAt,
          detail: 'Fictitious prepared fields.',
        },
      ],
      replay: correct
        ? {
            status: 'replayed',
            replayId: `illustrative:replay:${index}`,
            nativeEvidence: 'complete',
            checks: [
              {
                requirement: 'Requested business fields',
                status: 'matched',
                sourceValue: 'Example request',
                preparedValue: 'Example request',
                evidenceIds: [`native-${index}`, `prep-${index}`],
              },
            ],
          }
        : { status: 'not_run', reason: 'Illustrative example, not a real replay.' },
    };
  }),
};
