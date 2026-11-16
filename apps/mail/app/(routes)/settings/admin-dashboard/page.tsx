import {
  DEFAULT_ASSUMPTIONS,
  ILLUSTRATIVE_RETRO_REPORT,
  MAX_TIMING_MINUTES,
  OUTCOMES,
  OUTCOME_COLORS,
  OUTCOME_LABELS,
  WORKFLOW_LABELS,
  forecastReport,
  formatCount,
  formatHours,
  formatReportDate,
  readAssumptions,
  sourceMailLink,
  taskCredit,
  taskMatchesSearch,
  timingSchema,
  unassessedMessageCount,
  workflowTiming,
  writeAssumptions,
  type Assumptions,
  type RetroOutcome,
  type RetroReport,
  type RetroTask,
  type RetroWorkflow,
  type Timing,
} from '@/lib/admin-dashboard/retro-roi';
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileText,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import {
  previousScopeBeforeSwitch,
  runAccountSwitchCacheCleanup,
} from '@/lib/mail/account-switch-cache';
import {
  beginMailSelectionIntent,
  isCurrentMailSelectionIntent,
} from '@/lib/mail/source-message-navigation';
import { getMailCacheScope, setMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useConnections } from '@/hooks/use-connections';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { useRetroRoi } from '@/hooks/use-retro-roi';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router';
import { del } from 'idb-keyval';
import { toast } from 'sonner';

const panel = 'rounded-2xl border border-border bg-background';
const disclosure =
  'min-h-[44px] cursor-pointer list-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden';

function OutcomeBadge({ outcome }: { outcome: RetroOutcome }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${OUTCOME_COLORS[outcome].badge}`}
    >
      {OUTCOME_LABELS[outcome]}
    </span>
  );
}

function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={`${panel} flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center`}
    >
      <FileText className="text-muted-foreground size-8" aria-hidden="true" />
      <div className="max-w-md space-y-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="text-muted-foreground text-sm leading-relaxed">{children}</div>
      </div>
      {action}
    </div>
  );
}

function TimingEditor({
  timing,
  label,
  onApply,
  onReset,
}: {
  timing: Timing;
  label: string;
  onApply: (timing: Timing) => void;
  onReset?: () => void;
}) {
  const id = useId();
  const [manual, setManual] = useState(String(timing.manualMinutes));
  const [assisted, setAssisted] = useState(String(timing.assistedMinutes));
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      aria-label={`${label} timing assumptions`}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = timingSchema.safeParse({
          manualMinutes: Number(manual),
          assistedMinutes: Number(assisted),
        });
        if (!manual.trim() || !assisted.trim() || !parsed.success) {
          setError(`Enter finite values from 0 to ${MAX_TIMING_MINUTES} minutes.`);
          return;
        }
        setError(null);
        onApply(parsed.data);
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-40">
          <Label htmlFor={`${id}-manual`}>Manual minutes</Label>
          <Input
            id={`${id}-manual`}
            className="min-h-[44px]"
            type="number"
            min={0}
            max={MAX_TIMING_MINUTES}
            step="any"
            required
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-40">
          <Label htmlFor={`${id}-assisted`}>Nava-assisted minutes</Label>
          <Input
            id={`${id}-assisted`}
            className="min-h-[44px]"
            type="number"
            min={0}
            max={MAX_TIMING_MINUTES}
            step="any"
            required
            value={assisted}
            onChange={(event) => setAssisted(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </div>
        <Button type="submit" variant="outline" className="min-h-[44px]">
          Apply
        </Button>
        {onReset ? (
          <Button type="button" variant="ghost" className="min-h-[44px]" onClick={onReset}>
            Use global
          </Button>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function Coverage({ report }: { report: RetroReport }) {
  const { coverage } = report;
  const unassessed = unassessedMessageCount(report);
  const values = [
    ['Source messages', coverage.rawMessages],
    ['Deduplicated messages', coverage.canonicalMessages],
    ['Inbound messages', coverage.inboundMessages],
    ['Classified messages', coverage.classifiedMessages],
    ['Excluded messages', coverage.excludedMessages],
    ['Duplicate copies', coverage.duplicateMessages],
    ['Unassessed messages', unassessed],
    ['Classification failures', coverage.failedMessages],
    ['Unknown timestamps', coverage.unknownTimestampMessages],
  ] satisfies [string, number][];
  return (
    <details className={`${panel} overflow-hidden`}>
      <summary
        className={`${disclosure} flex flex-wrap items-center justify-between gap-3 px-5 py-4`}
      >
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck
            className="text-muted-foreground mt-0.5 size-5 shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">
              {coverage.status === 'complete'
                ? 'Complete source coverage'
                : 'Partial source coverage'}
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {formatCount(coverage.excludedMessages)} excluded · {formatCount(unassessed)}{' '}
              unassessed · {formatCount(coverage.failedMessages)} failed
            </p>
          </div>
        </div>
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          Coverage &amp; provenance <ChevronDown className="size-4" aria-hidden="true" />
        </span>
      </summary>
      <div className="space-y-5 border-t px-5 py-5">
        {coverage.status === 'partial' ? (
          <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            These totals cover the captured and assessed records. They do not represent the entire
            30-day workload.
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {values.map(([label, count]) => (
            <div key={label}>
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{formatCount(count)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Counts above are messages; the forecast counts distinct requested tasks. Failures are
          included in unassessed messages. Excluded traffic includes out-of-scope conversations and
          does not receive task credit. Unknown task outcomes remain visible below.
        </p>
        {coverage.notes.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {Array.from(new Set(coverage.notes)).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        <dl className="grid gap-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Source exported</dt>
            <dd className="mt-1">{formatReportDate(coverage.sourceExportedAt)} SAST</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Source available through</dt>
            <dd className="mt-1">
              {coverage.sourceThrough
                ? `${formatReportDate(coverage.sourceThrough)} SAST`
                : 'Not established'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Source snapshot</dt>
            <dd className="mt-1 break-all font-mono">{report.provenance.sourceSnapshotId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Nava version assessed</dt>
            <dd className="mt-1 break-all font-mono">{report.provenance.productSha}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Report ID</dt>
            <dd className="mt-1 break-all font-mono">{report.reportId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Assessment version</dt>
            <dd className="mt-1 break-all font-mono">{report.provenance.runnerVersion}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Source fingerprint</dt>
            <dd className="mt-1 break-all font-mono">{report.provenance.sourceSha256}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function EvidenceGroup({ title, evidence }: { title: string; evidence: RetroTask['evidence'] }) {
  if (!evidence.length) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide">{title}</h4>
      {evidence.map((item) => (
        <div key={item.id} className="bg-muted/40 rounded-lg p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.detail}</p>
          <p className="text-muted-foreground mt-2 text-xs">
            {formatReportDate(item.observedAt)} SAST
          </p>
          <p className="text-muted-foreground mt-1 break-all font-mono text-xs">{item.reference}</p>
        </div>
      ))}
    </div>
  );
}

function SourceEmailAction({ to }: { to: string }) {
  const { data, isLoading } = useConnections();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const { mutateAsync: setDefaultConnection } = useMutation(
    trpc.connections.setDefault.mutationOptions({ meta: { noGlobalError: true } }),
  );
  const openEmail = async () => {
    if (opening || isFrontendOnlyDemo()) return;
    const intent = beginMailSelectionIntent();
    const originalUserId = getMailCacheScope().userId;
    const isCurrentSelection = () =>
      isCurrentMailSelectionIntent(intent) && getMailCacheScope().userId === originalUserId;
    const centurion = data?.connections.find(
      (connection) =>
        connection.id === 'transport-centurion' ||
        connection.email.toLowerCase() === 'centurion@legacyhotels.co.za',
    );
    if (!centurion) {
      toast.error('Centurion mailbox access is unavailable for this account.');
      return;
    }
    setOpening(true);
    try {
      const previousScope = previousScopeBeforeSwitch({
        current: getMailCacheScope(),
        nextTransportId: centurion.id,
      });
      if (previousScope.activeTransportId !== centurion.id) {
        await setDefaultConnection({ connectionId: centurion.id });
        if (!isCurrentSelection()) return;
        setMailCacheScope({ userId: previousScope.userId, activeTransportId: centurion.id });
        if (!isCurrentSelection()) return;
        await runAccountSwitchCacheCleanup({ previousScope, queryClient, deleteIdbKey: del });
        const currentScope = getMailCacheScope();
        if (!isCurrentSelection() || currentScope.activeTransportId !== centurion.id) return;
        queryClient.setQueryData(trpc.connections.getDefault.queryKey(), {
          ...centurion,
          picture: null,
          createdAt: null,
        });
      }
      if (!isCurrentSelection() || getMailCacheScope().activeTransportId !== centurion.id) return;
      void navigate(to);
    } catch {
      if (isCurrentSelection())
        toast.error('Could not open the Centurion mailbox. Please try again.');
    } finally {
      setOpening(false);
    }
  };
  return (
    <Button
      variant="link"
      className="min-h-[44px] px-0 text-xs"
      disabled={isLoading || opening}
      isLoading={opening}
      loadingText="Opening Centurion…"
      onClick={() => {
        void openEmail();
      }}
    >
      Open email <ArrowUpRight className="size-3" aria-hidden="true" />
    </Button>
  );
}

function TaskDetails({ task, assumptions }: { task: RetroTask; assumptions: Assumptions }) {
  const [expanded, setExpanded] = useState(false);
  const credit = taskCredit(task, assumptions);
  return (
    <details
      className="rounded-xl border"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
      }}
    >
      <summary className={`${disclosure} flex flex-wrap items-start justify-between gap-3 p-4`}>
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words text-sm font-medium">
            {task.sources[0]?.subject || task.originalAsk || task.id}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {formatReportDate(task.requestedAt)} SAST
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <OutcomeBadge outcome={task.outcome} />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatCount(credit)} min credit
          </span>
          <ChevronDown className="text-muted-foreground size-4" aria-hidden="true" />
        </div>
      </summary>
      {expanded ? (
        <div className="space-y-6 border-t p-4 sm:p-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold">Original ask</h4>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {task.originalAsk}
              </p>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Nava preparation</h4>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {task.navaPreparation || 'No preparation recorded.'}
              </p>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Remaining work</h4>
              {task.remainingWork.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {Array.from(new Set(task.remainingWork)).map((work) => (
                    <li key={work} className="whitespace-pre-wrap break-words">
                      {work}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground mt-2 text-sm">
                  {task.outcome === 'correct_complete'
                    ? 'No remaining preparation recorded. Staff review and any Save or send remain part of assisted effort.'
                    : 'No remaining-work detail recorded.'}
                </p>
              )}
            </div>
            <div>
              <h4 className="text-sm font-semibold">Why this outcome</h4>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {task.reason}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                {task.outcome === 'correct_complete'
                  ? `${workflowTiming(assumptions, task.workflow).manualMinutes} manual − ${workflowTiming(assumptions, task.workflow).assistedMinutes} assisted = ${credit} estimated minutes saved.`
                  : 'This outcome receives zero savings credit under the forecast policy.'}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Rooms / guests / targets</dt>
              <dd className="mt-1">
                {task.complexity.rooms ?? 'Unknown'} / {task.complexity.guests ?? 'Unknown'} /{' '}
                {task.complexity.targets ?? 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Bookings</dt>
              <dd className="mt-1 break-words">
                {task.bookingReferences.join(', ') || 'None linked'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Task ID</dt>
              <dd className="mt-1 break-all font-mono">{task.id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Work item</dt>
              <dd className="mt-1 break-all font-mono">{task.workItemId ?? 'None linked'}</dd>
            </div>
          </dl>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold">Source emails</h4>
            {task.sources.map((source) => {
              const link = sourceMailLink(source);
              return (
                <article key={source.messageId} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {source.subject || '(No subject)'}
                      </p>
                      <p className="text-muted-foreground mt-1 break-words text-xs">
                        {source.from} · {formatReportDate(source.receivedAt)} SAST
                      </p>
                      {source.timestampBasis && source.timestampBasis !== 'received_at' ? (
                        <p className="text-muted-foreground mt-1 text-xs">
                          {source.timestampBasis === 'sent_at_confirmed_outbound'
                            ? 'Hotel sent timestamp.'
                            : source.timestampBasis === 'sent_at_fallback'
                              ? 'Sent timestamp; receipt time was not retained.'
                              : 'Storage timestamp; the original receipt time is unknown.'}
                        </p>
                      ) : null}
                    </div>
                    {link ? <SourceEmailAction to={link} /> : null}
                  </div>
                  <blockquote className="text-muted-foreground mt-3 whitespace-pre-wrap break-words border-l-2 pl-3 text-sm">
                    {source.quote || 'No source excerpt retained.'}
                  </blockquote>
                  <p className="text-muted-foreground mt-3 break-all font-mono text-xs">
                    Message: {source.messageId}
                  </p>
                  {source.threadId ? (
                    <p className="text-muted-foreground mt-1 break-all font-mono text-xs">
                      Thread: {source.threadId}
                    </p>
                  ) : null}
                  {source.duplicateMessageIds.length ? (
                    <p className="text-muted-foreground mt-1 break-all text-xs">
                      Duplicate copies: {source.duplicateMessageIds.join(', ')}
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
          <div className="space-y-4">
            <h4 className="text-sm font-semibold">Preparation checks</h4>
            {task.replay.status === 'not_run' ? (
              <p className="text-muted-foreground text-sm">{task.replay.reason}</p>
            ) : (
              <>
                <p className="text-muted-foreground text-xs">
                  Request-time native evidence:{' '}
                  {task.replay.nativeEvidence === 'complete' ? 'complete' : 'missing'} · Replay{' '}
                  {task.replay.replayId}
                </p>
                {task.replay.checks.map((check) => (
                  <div
                    key={`${check.requirement}:${check.evidenceIds.join('|')}`}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <p className="font-medium">
                      {check.requirement}{' '}
                      <span className="text-muted-foreground font-normal">· {check.status}</span>
                    </p>
                    <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground text-xs">Requested</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words">
                          {check.sourceValue}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground text-xs">Prepared</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words">
                          {check.preparedValue}
                        </dd>
                      </div>
                    </dl>
                    <p className="text-muted-foreground mt-2 break-all text-xs">
                      Evidence: {check.evidenceIds.join(', ')}
                    </p>
                  </div>
                ))}
              </>
            )}
          </div>
          <EvidenceGroup
            title="Available at the request · source and native facts"
            evidence={task.evidence.filter(
              (item) => item.kind === 'source' || item.kind === 'historical_native',
            )}
          />
          <EvidenceGroup
            title="Preparation evidence"
            evidence={task.evidence.filter((item) => item.kind === 'preparation')}
          />
          {task.evidence.some((item) => item.kind === 'later_outcome') ? (
            <div className="space-y-2 border-t pt-4">
              <p className="text-muted-foreground text-xs">
                Later outcomes are context. They do not establish what Nava knew when the request
                arrived.
              </p>
              <EvidenceGroup
                title="Later outcome evidence"
                evidence={task.evidence.filter((item) => item.kind === 'later_outcome')}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

type WorkflowForecast = ReturnType<typeof forecastReport>['workflows'][number];

function WorkflowDetails({
  row,
  assumptions,
  onOverride,
  onReset,
  search,
  outcome,
}: {
  row: WorkflowForecast;
  assumptions: Assumptions;
  onOverride: (workflow: RetroWorkflow, timing: Timing) => void;
  onReset: (workflow: RetroWorkflow) => void;
  search: string;
  outcome: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(10);
  const timing = workflowTiming(assumptions, row.workflow);
  const overridden = Boolean(assumptions.workflows[row.workflow]);
  const tasks = row.tasks.filter(
    (task) => (outcome === 'all' || task.outcome === outcome) && taskMatchesSearch(task, search),
  );
  const filtered = Boolean(search.trim()) || outcome !== 'all';
  return (
    <details
      className={`${panel} group overflow-hidden`}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
      }}
    >
      <summary className={`${disclosure} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{WORKFLOW_LABELS[row.workflow]}</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {formatCount(row.tasks.length)} distinct tasks ·{' '}
              {formatCount(row.outcomes.correct_complete)} correct &amp; complete
              {overridden ? ' · custom timing' : ''}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">
                {formatHours(row.savedMinutes)}{' '}
                <span className="text-muted-foreground text-xs font-normal">hours</span>
              </p>
              <p className="text-muted-foreground text-xs">estimated savings</p>
            </div>
            <ChevronDown
              className="text-muted-foreground size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </div>
        </div>
        <div
          className="bg-muted mt-4 flex h-2 overflow-hidden rounded-full"
          role="img"
          aria-label={OUTCOMES.map((item) => `${OUTCOME_LABELS[item]}: ${row.outcomes[item]}`).join(
            '; ',
          )}
        >
          {OUTCOMES.map((item) =>
            row.outcomes[item] > 0 ? (
              <span
                key={item}
                className={OUTCOME_COLORS[item].bar}
                style={{ width: `${(100 * row.outcomes[item]) / row.tasks.length}%` }}
              />
            ) : null,
          )}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          {filtered ? `${formatCount(tasks.length)} matching tasks · ` : ''}Review outcomes, timing
          &amp; task evidence
        </p>
      </summary>
      {expanded ? (
        <div className="space-y-5 border-t p-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {OUTCOMES.map((item) => (
              <div
                key={item}
                className="flex items-center justify-between gap-2 rounded-lg border p-3"
              >
                <dt className="text-xs">{OUTCOME_LABELS[item]}</dt>
                <dd className="font-semibold tabular-nums">{formatCount(row.outcomes[item])}</dd>
              </div>
            ))}
          </dl>
          <div className="bg-muted/30 space-y-3 rounded-xl p-4">
            <div>
              <h4 className="text-sm font-semibold">Workflow timing assumptions</h4>
              <p className="text-muted-foreground mt-1 text-xs">
                {overridden
                  ? 'Custom values for this workflow.'
                  : 'Using the global assumptions. Apply values to override this workflow.'}{' '}
                Correct &amp; complete tasks receive{' '}
                {formatCount(timing.manualMinutes - timing.assistedMinutes)} minutes each.
              </p>
            </div>
            <TimingEditor
              key={`${timing.manualMinutes}:${timing.assistedMinutes}:${overridden}`}
              timing={timing}
              label={WORKFLOW_LABELS[row.workflow]}
              onApply={(value) => onOverride(row.workflow, value)}
              onReset={overridden ? () => onReset(row.workflow) : undefined}
            />
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold">
              Task evidence{' '}
              <span className="text-muted-foreground font-normal">
                · {formatCount(tasks.length)}
                {filtered ? ' matching' : ''} tasks
              </span>
            </h4>
            {tasks.slice(0, limit).map((task) => (
              <TaskDetails key={task.id} task={task} assumptions={assumptions} />
            ))}
            {!tasks.length ? (
              <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                {filtered
                  ? 'No tasks match these filters.'
                  : 'No tasks recorded for this workflow.'}
              </p>
            ) : null}
            {tasks.length > limit ? (
              <Button
                variant="outline"
                className="min-h-[44px]"
                onClick={() => setLimit((value) => value + 20)}
              >
                Show more tasks ({formatCount(tasks.length - limit)} remaining)
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function RetroDashboard({
  report,
  viewerScopeKey,
  example = false,
  refreshing = false,
  refresh,
}: {
  report: RetroReport;
  viewerScopeKey: string;
  example?: boolean;
  refreshing?: boolean;
  refresh?: () => void;
}) {
  const storageKey = `centurion-retro-roi:assumptions:1:${viewerScopeKey}`;
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [storageFailed, setStorageFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('all');
  const filterId = useId();
  useEffect(() => {
    setAssumptions(readAssumptions(storageKey));
  }, [storageKey]);
  const forecast = useMemo(() => forecastReport(report, assumptions), [report, assumptions]);
  const saveAssumptions = (next: Assumptions) => {
    setAssumptions(next);
    setStorageFailed(!writeAssumptions(storageKey, next));
  };
  const onOverride = (workflow: RetroWorkflow, timing: Timing) =>
    saveAssumptions({
      ...assumptions,
      workflows: { ...assumptions.workflows, [workflow]: timing },
    });
  const onReset = (workflow: RetroWorkflow) => {
    const workflows = { ...assumptions.workflows };
    delete workflows[workflow];
    saveAssumptions({ ...assumptions, workflows });
  };
  return (
    <div className="space-y-6">
      {example ? (
        <div
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200"
          role="status"
        >
          <strong>Illustrative example.</strong> All records and totals are fictitious. This preview
          demonstrates the dashboard; it is not Centurion's analysis.
        </div>
      ) : null}
      <section
        className="overflow-hidden rounded-2xl border border-emerald-600/20 bg-emerald-500/5"
        aria-label="Retrospective forecast summary"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-emerald-600/10 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
              {example ? 'Illustrative period' : 'Centurion · HRCEN'} · 30-day retrospective
            </p>
            <p className="mt-2 text-sm font-medium">
              {formatReportDate(report.period.start)} → {formatReportDate(report.period.end)} SAST
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Africa/Johannesburg · start inclusive, cutoff exclusive · fixed analysis period
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${report.coverage.status === 'complete' ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-800 dark:text-amber-300'}`}
            >
              {report.coverage.status === 'complete' ? 'Complete coverage' : 'Partial coverage'}
            </span>
            {refresh ? (
              <Button
                variant="ghost"
                className="min-h-[44px]"
                disabled={refreshing}
                onClick={refresh}
                aria-label="Reload published report"
              >
                <RefreshCw
                  className={`size-4 ${refreshing ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-6 px-5 py-6 sm:grid-cols-3 sm:px-6">
          <div className="sm:col-span-1">
            <div className="flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300">
              <Clock3 className="size-4" aria-hidden="true" />
              <h2>Estimated hours saved</h2>
            </div>
            <p
              className="mt-3 text-5xl font-semibold tabular-nums tracking-tight"
              aria-live="polite"
              aria-atomic="true"
            >
              {formatHours(forecast.savedMinutes)}{' '}
              <span className="text-muted-foreground text-xl font-normal">hours</span>
            </p>
            <p className="text-muted-foreground mt-2 text-xs">
              {formatCount(forecast.savedMinutes)} forecast minutes across credited tasks
            </p>
          </div>
          <div>
            <h2 className="text-muted-foreground text-sm">Distinct tasks assessed</h2>
            <p className="mt-3 text-4xl font-semibold tabular-nums tracking-tight">
              {formatCount(forecast.taskCount)}
            </p>
            <p className="text-muted-foreground mt-2 text-xs">
              Requested staff actions, deduplicated across source emails
            </p>
          </div>
          <div>
            <h2 className="text-muted-foreground text-sm">Correct &amp; complete preparation</h2>
            <p className="mt-3 text-4xl font-semibold tabular-nums tracking-tight">
              {formatCount(forecast.outcomes.correct_complete)}
            </p>
            <p className="text-muted-foreground mt-2 text-xs">
              Evidence-backed tasks eligible for savings credit
            </p>
          </div>
        </div>
        <div className="border-t border-emerald-600/10 px-5 py-4 sm:px-6">
          <p className="text-muted-foreground text-xs leading-relaxed">
            A forecast of what the assessed Nava version could have saved on past reservation work.
            These are editable effort assumptions, not measured staff savings or adoption. Staff
            review remains required.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            Report as of {formatReportDate(report.generatedAt)} SAST
            {report.coverage.status === 'partial' ? ' · captured and assessed records only' : ''}
          </p>
          {forecast.savedMinutes < 0 ? (
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" role="status">
              Negative savings mean your assumptions estimate additional assisted effort.
            </p>
          ) : null}
        </div>
      </section>
      <Coverage report={report} />
      <section className={`${panel} p-5 sm:p-6`} aria-labelledby={`${filterId}-timing-title`}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={`${filterId}-timing-title`} className="font-semibold">
              Your forecast assumptions
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Manual effort minus Nava-assisted effort, per correct &amp; complete task.
            </p>
          </div>
          <Button
            variant="ghost"
            className="min-h-[44px]"
            onClick={() => saveAssumptions(DEFAULT_ASSUMPTIONS)}
          >
            Reset all to 6 / 2
          </Button>
        </div>
        <TimingEditor
          key={`${assumptions.global.manualMinutes}:${assumptions.global.assistedMinutes}`}
          label="Global"
          timing={assumptions.global}
          onApply={(global) => saveAssumptions({ ...assumptions, global })}
        />
        <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
          Default: 6 manual minutes − 2 assisted minutes = 4 minutes saved. Every other outcome
          receives zero credit. Negative differences estimate additional effort. Workflow overrides
          stay in effect when global values change. Your edits recalculate the same assessments and
          are saved for this viewer and mailbox.
        </p>
        {storageFailed ? (
          <p className="mt-2 text-sm text-amber-800 dark:text-amber-300" role="status">
            Browser storage is unavailable. These assumptions apply for this visit.
          </p>
        ) : null}
      </section>
      <section className="space-y-4" aria-labelledby={`${filterId}-workflow-title`}>
        <div>
          <h2 id={`${filterId}-workflow-title`} className="text-lg font-semibold">
            Where the time could be saved
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Preparation outcomes by workflow. Expand a row to adjust its timing or inspect each
            task.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {OUTCOMES.map((item) => (
            <div key={item} className={`${panel} p-3`}>
              <dt className="flex items-center gap-2 text-xs">
                <span
                  className={`size-2 shrink-0 rounded-full ${OUTCOME_COLORS[item].bar}`}
                  aria-hidden="true"
                />
                {OUTCOME_LABELS[item]}
              </dt>
              <dd className="mt-2 text-xl font-semibold tabular-nums">
                {formatCount(forecast.outcomes[item])}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Label className="sr-only" htmlFor={`${filterId}-search`}>
              Search task evidence
            </Label>
            <Search
              className="text-muted-foreground pointer-events-none absolute left-3 top-3.5 size-4"
              aria-hidden="true"
            />
            <Input
              id={`${filterId}-search`}
              className="min-h-[44px] pl-9"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search asks, senders or booking references"
            />
          </div>
          <div>
            <Label className="sr-only" htmlFor={`${filterId}-outcome`}>
              Filter tasks by preparation outcome
            </Label>
            <select
              id={`${filterId}-outcome`}
              className="border-input bg-background focus-visible:ring-ring min-h-[44px] w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 sm:w-56"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
            >
              <option value="all">All preparation outcomes</option>
              {OUTCOMES.map((item) => (
                <option key={item} value={item}>
                  {OUTCOME_LABELS[item]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {search || outcome !== 'all' ? (
          <p className="text-muted-foreground text-xs" role="status">
            Filters apply to the task lists. Forecast totals continue to include the full report.
          </p>
        ) : null}
        {forecast.taskCount === 0 ? (
          <EmptyState title="No distinct tasks assessed yet">
            Source coverage above explains what was captured. There is no task-level savings
            estimate to credit.
          </EmptyState>
        ) : null}
        {forecast.workflows.map((row) => (
          <WorkflowDetails
            key={`${report.reportId}:${row.workflow}`}
            row={row}
            assumptions={assumptions}
            onOverride={onOverride}
            onReset={onReset}
            search={search}
            outcome={outcome}
          />
        ))}
      </section>
      <p className="text-muted-foreground flex items-start gap-2 pb-4 text-xs leading-relaxed">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Task outcomes and source evidence remain unchanged by timing edits. Reload checks the
        published report; it does not run an assessment or write to HMS.
      </p>
    </div>
  );
}

export default function AdminDashboardPage() {
  const state = useRetroRoi();
  const [showExample, setShowExample] = useState(false);
  let content: ReactNode;
  switch (state.status) {
    case 'loading':
      content = (
        <div className="space-y-4" role="status" aria-label="Loading retrospective report">
          <p className="text-muted-foreground text-sm">Loading the published retrospective…</p>
          <div className={`${panel} bg-muted/40 h-60 animate-pulse`} />
          <div className={`${panel} bg-muted/40 h-24 animate-pulse`} />
          <div className={`${panel} bg-muted/40 h-36 animate-pulse`} />
        </div>
      );
      break;
    case 'denied':
      content = (
        <EmptyState title="Dashboard access is restricted">
          Sign in with an authorised dashboard account to view Centurion's retrospective.
        </EmptyState>
      );
      break;
    case 'error':
      content = (
        <EmptyState
          title="The report could not be loaded"
          action={
            <Button variant="outline" className="min-h-[44px]" onClick={state.retry}>
              Try again
            </Button>
          }
        >
          The published report is temporarily unavailable. Reload to check again.
        </EmptyState>
      );
      break;
    case 'unavailable':
      content = (
        <EmptyState
          title={
            state.reason === 'invalid_report'
              ? 'The report needs verification'
              : 'No retrospective published yet'
          }
          action={
            <Button variant="outline" className="min-h-[44px]" onClick={state.retry}>
              Check for a report
            </Button>
          }
        >
          {state.reason === 'invalid_report'
            ? 'The saved report did not pass its evidence and data checks. Forecast totals will appear when a valid report is published.'
            : 'A source-backed 30-day report has not been published for Centurion. Forecast totals will appear after its source coverage and task assessments are ready.'}
        </EmptyState>
      );
      break;
    case 'demo':
      content = showExample ? (
        <RetroDashboard
          key="illustrative"
          report={ILLUSTRATIVE_RETRO_REPORT}
          viewerScopeKey="illustrative-preview"
          example
        />
      ) : (
        <EmptyState
          title="Frontend preview"
          action={
            <Button variant="outline" className="min-h-[44px]" onClick={() => setShowExample(true)}>
              View illustrative example
            </Button>
          }
        >
          This frontend preview has no connection to Centurion's report. You can explore a clearly
          marked example with fictitious task records.
        </EmptyState>
      );
      break;
    case 'ready':
      content = (
        <RetroDashboard
          key={state.viewerScopeKey}
          report={state.report}
          viewerScopeKey={state.viewerScopeKey}
          refreshing={state.refreshing}
          refresh={state.refresh}
        />
      );
      break;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-1 sm:p-4">
      <header className="space-y-2">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-widest">
          Nava / Dashboard
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Time back for your team
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          A retrospective forecast for Centurion's reservation work, grounded in distinct requests
          and the preparation Nava could provide.
        </p>
      </header>
      {content}
    </main>
  );
}
