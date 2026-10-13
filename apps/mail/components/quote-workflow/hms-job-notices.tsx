import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  HmsJobNoticeReporterContext,
  type HmsJobNoticeEmail,
  type HmsJobNoticeInput,
  type HmsJobNoticeReporter,
} from '@/lib/quote-workflow/hms-job-notice-context';
import {
  isSettled,
  pollHmsJob,
  type HmsJobQueueOptions,
  type HmsJobRequest,
  type HmsJobTransport,
  type HmsJobView,
} from '@/lib/quote-workflow/amend-find';

type TrackedJob = {
  observerId: string;
  jobId: string;
  runId: string | null;
  request: HmsJobRequest;
  options?: HmsJobQueueOptions;
  retryOptions?: HmsJobQueueOptions;
  targetId: string;
  emailKey: string | null;
  emailSubject: string | null;
  retry: () => void;
  transport: HmsJobTransport | null;
  detached: boolean;
  backgroundToken: number | null;
};

type HmsNotice = TrackedJob & {
  id: string;
  status: 'done' | 'failed';
  completedAt: number;
  failureClass: string | null;
  failureReason: string | null;
  message: string;
};

type NoticeView = {
  activeCount: number;
  notices: HmsNotice[];
  emailKey: string | null;
  emailSubject: string | null;
};

const ViewContext = createContext<NoticeView | null>(null);

function visibleNotice(notices: HmsNotice[]): HmsNotice | null {
  return notices.find((item) => item.status === 'failed') ?? notices[0] ?? null;
}

/** The visible failure copy for one target and selected email, if that notice is still on screen. */
export function useFailedHmsJobNoticeMessage(targetId: string, emailKey: string | null): string | null {
  const view = useContext(ViewContext);
  if (!emailKey) return null;
  const notice = view ? visibleNotice(view.notices) : null;
  return notice?.status === 'failed' && notice.targetId === targetId && notice.emailKey === emailKey
    ? notice.message
    : null;
}

const TARGET_BY_KIND: Record<string, string> = {
  find: 'quote-booking',
  search_guest: 'quote-rates',
  party: 'quote-party',
  staff_quote: 'quote-rates',
};

function trackedJobKey(observerId: string, jobId: string): string {
  return `${observerId}\u0000${jobId}`;
}

function targetFor(request: HmsJobRequest): string {
  const kind = String((request as unknown as { kind?: unknown }).kind ?? '');
  return TARGET_BY_KIND[kind] ?? 'quote-selected-message';
}

function requestRecord(request: HmsJobRequest): Record<string, unknown> {
  return request as unknown as Record<string, unknown>;
}

function completedMessage(request: HmsJobRequest): string {
  const kind = String(requestRecord(request).kind ?? '');
  if (kind === 'party') return 'Company/agency lookup finished';
  if (kind === 'staff_quote') return 'Rates ready';
  return 'HMS lookup finished';
}

function failureReason(failureClass: string | null): string {
  switch (failureClass) {
    case 'QUEUE_FAILED':
      return 'Nava could not queue the lookup. Try again.';
    case 'AUTH':
      return 'HMS access needs attention. Check the HMS session and retry.';
    case 'HMS_LOCK_BUSY':
      return 'HMS is busy. Retry shortly.';
    case 'RUN_DEADLINE':
      return 'The lookup took too long to finish. Retry the HMS lookup.';
    case 'PARTY_SEARCH_TIMEOUT':
      return 'The party search took longer than four minutes. Retry the HMS lookup.';
    case 'POLL_LOST':
      return 'Nava could not confirm that the lookup finished. Retry checking HMS.';
    case 'POLICY_BLOCK':
      return 'HMS could not complete this lookup. Check the request and retry.';
    default:
      return 'HMS could not complete the lookup. Retry, or check the request.';
  }
}

/** Pane-scoped status for read-only HMS jobs; retries reuse the read-job transport. */
export function HmsJobNoticeProvider({
  emailKey,
  emailSubject,
  passthrough = false,
  onReporterReady,
  children,
}: {
  emailKey: string | null;
  emailSubject: string | null;
  /** Keep the parent notice state when NavaPane is embedded in a keyed surface. */
  passthrough?: boolean;
  onReporterReady?: (reporter: HmsJobNoticeReporter) => void;
  children: ReactNode;
}) {
  const parentReporter = useContext(HmsJobNoticeReporterContext);
  const [snapshot, setSnapshot] = useState<{ activeCount: number; notices: HmsNotice[] }>({
    activeCount: 0,
    notices: [],
  });
  const active = useRef(new Map<string, TrackedJob>());
  const notices = useRef<HmsNotice[]>([]);
  const currentEmail = useRef({ emailKey, emailSubject });
  const providerEmail = useRef({ emailKey, emailSubject });
  const overriddenEmail = useRef<HmsJobNoticeEmail | null>(null);
  const nextNotice = useRef(0);
  const nextBackgroundToken = useRef(0);
  const mounted = useRef(true);
  if (
    providerEmail.current.emailKey !== emailKey ||
    providerEmail.current.emailSubject !== emailSubject
  ) {
    const nextEmail = { emailKey, emailSubject };
    providerEmail.current = nextEmail;
    currentEmail.current = nextEmail;
    overriddenEmail.current = null;
  }

  const publish = useCallback(() => {
    if (mounted.current) {
      setSnapshot({ activeCount: active.current.size, notices: [...notices.current] });
    }
  }, []);

  const setCurrentEmail = useCallback(
    (email: HmsJobNoticeEmail) => {
      currentEmail.current = email;
      overriddenEmail.current = email;
      publish();
    },
    [publish],
  );

  const complete = useCallback(
    (key: string, view: HmsJobView) => {
      const current = active.current.get(key);
      if (!current) return;
      active.current.delete(key);
      const request = view.request ?? current.request;
      const status = view.status === 'done' ? 'done' : 'failed';
      const safeReason = status === 'failed' ? failureReason(view.failureClass) : null;
      notices.current = [
        ...notices.current,
        {
          ...current,
          id: `hms-notice-${++nextNotice.current}`,
          completedAt: Date.now(),
          runId: view.runId,
          request,
          status,
          failureClass: status === 'failed' ? view.failureClass : null,
          failureReason: safeReason,
          message:
            status === 'done'
              ? completedMessage(request)
              : String(requestRecord(request).kind ?? '') === 'staff_quote'
                ? `Rates failed: ${safeReason}`
                : `HMS lookup failed: ${safeReason}`,
        },
      ];
      publish();
    },
    [publish],
  );

  const completeQueueFailure = useCallback(
    (key: string) => {
      const current = active.current.get(key);
      if (!current) return;
      active.current.delete(key);
      const reason = failureReason('QUEUE_FAILED');
      notices.current = [
        ...notices.current,
        {
          ...current,
          id: `hms-notice-${++nextNotice.current}`,
          completedAt: Date.now(),
          status: 'failed',
          failureClass: 'QUEUE_FAILED',
          failureReason: reason,
          message: `HMS lookup failed: ${reason}`,
        },
      ];
      publish();
    },
    [publish],
  );

  const startBackgroundWatch = useCallback(
    (key: string) => {
      const current = active.current.get(key);
      if (
        !current ||
        !current.detached ||
        current.backgroundToken !== null ||
        !current.runId ||
        !current.transport
      ) {
        return;
      }
      const token = ++nextBackgroundToken.current;
      current.backgroundToken = token;
      void pollHmsJob(current.transport, current.runId, {
        live: () => {
          const latest = active.current.get(key);
          return mounted.current && latest === current && latest.backgroundToken === token;
        },
        onView: (view) => {
          if (isSettled(view)) complete(key, view);
        },
      });
    },
    [complete],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current.clear();
    };
  }, []);

  const started = useCallback(
    (input: HmsJobNoticeInput) => {
      for (const [key, current] of active.current) {
        if (current.observerId === input.observerId) {
          current.detached = true;
          startBackgroundWatch(key);
        }
      }
      const key = trackedJobKey(input.observerId, input.jobId);
      active.current.set(key, {
        observerId: input.observerId,
        jobId: input.jobId,
        runId: null,
        request: input.request,
        options: input.options,
        retryOptions: input.retryOptions,
        targetId: input.targetId ?? targetFor(input.request),
        emailKey: input.email?.emailKey ?? currentEmail.current.emailKey,
        emailSubject: input.email?.emailSubject ?? currentEmail.current.emailSubject,
        retry: input.retry,
        transport: input.transport,
        detached: false,
        backgroundToken: null,
      });
      publish();
    },
    [publish, startBackgroundWatch],
  );

  const pending = useCallback(
    (input: HmsJobNoticeInput) => {
      const key = trackedJobKey(input.observerId, input.jobId);
      let current = active.current.get(key);
      if (!current) {
        current = {
          observerId: input.observerId,
          jobId: input.jobId,
          runId: input.runId ?? null,
          request: input.request,
          options: input.options,
          retryOptions: input.retryOptions,
          targetId: input.targetId ?? targetFor(input.request),
          emailKey: input.email?.emailKey ?? currentEmail.current.emailKey,
          emailSubject: input.email?.emailSubject ?? currentEmail.current.emailSubject,
          retry: input.retry,
          transport: input.transport,
          detached: false,
          backgroundToken: null,
        };
        active.current.set(key, current);
      } else {
        current.request = input.request;
        current.options = input.options;
        current.retryOptions = input.retryOptions;
        current.targetId = input.targetId ?? current.targetId;
        current.retry = input.retry;
        current.transport = input.transport ?? current.transport;
        if (input.runId) current.runId = input.runId;
      }
      if (current.detached) startBackgroundWatch(key);
      publish();
    },
    [publish, startBackgroundWatch],
  );

  const settled = useCallback(
    (observerId: string, jobId: string, view: HmsJobView, retry: () => void) => {
      const key = trackedJobKey(observerId, jobId);
      const current = active.current.get(key);
      if (!current) return;
      current.retry = retry;
      complete(key, view);
    },
    [complete],
  );

  const queueFailed = useCallback(
    (observerId: string, jobId: string, retry: () => void) => {
      const key = trackedJobKey(observerId, jobId);
      const current = active.current.get(key);
      if (!current) return;
      current.retry = retry;
      completeQueueFailure(key);
    },
    [completeQueueFailure],
  );

  const detached = useCallback(
    (observerId: string) => {
      let changed = false;
      for (const [key, current] of active.current) {
        if (current.observerId !== observerId) continue;
        current.detached = true;
        startBackgroundWatch(key);
        changed = true;
      }
      if (changed) publish();
    },
    [publish, startBackgroundWatch],
  );

  const cancel = useCallback(
    (observerId: string, jobId: string) => {
      if (!active.current.delete(trackedJobKey(observerId, jobId))) return;
      publish();
    },
    [publish],
  );

  const dismiss = useCallback(
    (noticeId: string) => {
      notices.current = notices.current.filter((notice) => notice.id !== noticeId);
      publish();
    },
    [publish],
  );

  const retryNotice = useCallback(
    (noticeId: string) => {
      const notice = notices.current.find((item) => item.id === noticeId);
      if (!notice) return;
      notices.current = notices.current.filter((item) => item.id !== notice.id);
      publish();
      if (!notice.transport) {
        notice.retry();
        return;
      }

      const jobId = `retry:${notice.id}`;
      const key = trackedJobKey(notice.observerId, jobId);
      active.current.set(key, {
        ...notice,
        jobId,
        runId: notice.failureClass === 'POLL_LOST' ? notice.runId : null,
        detached: true,
        backgroundToken: null,
      });
      publish();
      if (notice.failureClass === 'POLL_LOST' && notice.runId) {
        startBackgroundWatch(key);
        return;
      }
      const options = notice.retryOptions ?? notice.options;
      const queued = options
        ? notice.transport.queue(notice.request, options)
        : notice.transport.queue(notice.request);
      void queued.then(
        (started) => {
          const current = active.current.get(key);
          if (!current) return;
          if (started.view) {
            if (isSettled(started.view)) complete(key, started.view);
            else {
              current.runId = started.runId;
              startBackgroundWatch(key);
            }
            return;
          }
          if (started.runId) {
            current.runId = started.runId;
            startBackgroundWatch(key);
          } else {
            cancel(notice.observerId, jobId);
          }
        },
        () => completeQueueFailure(key),
      );
    },
    [cancel, complete, completeQueueFailure, publish, startBackgroundWatch],
  );

  const reporter = useMemo<HmsJobNoticeReporter>(
    () => ({
      setCurrentEmail,
      started,
      pending,
      settled,
      queueFailed,
      detached,
      cancel,
      dismiss,
      retryNotice,
    }),
    [
      setCurrentEmail,
      started,
      pending,
      settled,
      queueFailed,
      detached,
      cancel,
      dismiss,
      retryNotice,
    ],
  );
  useLayoutEffect(() => {
    onReporterReady?.(passthrough ? parentReporter : reporter);
  }, [onReporterReady, parentReporter, passthrough, reporter]);
  const view = { ...snapshot, ...(overriddenEmail.current ?? { emailKey, emailSubject }) };
  if (passthrough) return <>{children}</>;
  return (
    <HmsJobNoticeReporterContext.Provider value={reporter}>
      <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
    </HmsJobNoticeReporterContext.Provider>
  );
}

/** Compact count in the pane header; hidden when nothing is running. */
export function HmsJobRunningChip() {
  const view = useContext(ViewContext);
  if (!view?.activeCount) return null;
  return (
    <span
      className="whitespace-nowrap rounded-full bg-[#eff6ff] px-2 py-1 text-[10.5px] font-semibold text-[#0066cc]"
      data-testid="hms-running-count"
    >
      {`HMS: ${view.activeCount} pending`}
    </span>
  );
}

/** The oldest undismissed completion is pinned below the pane header; later notices stay queued. */
export function HmsJobNoticeBanner() {
  const view = useContext(ViewContext);
  const reporter = useContext(HmsJobNoticeReporterContext);
  const [returnHint, setReturnHint] = useState<string | null>(null);
  const notice = view ? visibleNotice(view.notices) : null;
  useEffect(() => setReturnHint(null), [notice?.id]);
  useEffect(() => {
    const timers = (view?.notices ?? [])
      .filter((item) => item.status === 'done')
      .map((item) =>
        window.setTimeout(
          () => reporter.dismiss(item.id),
          Math.max(0, item.completedAt + 20_000 - Date.now()),
        ),
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [view?.notices, reporter]);
  if (!view || !notice) return null;
  const sameEmail = notice.emailKey === view.emailKey;
  const moreCount = Math.max(0, view.notices.length - 1);

  // This component cannot switch the selection; if it changed, identify the email to select.
  const show = () => {
    if (!sameEmail) {
      setReturnHint(
        notice.emailSubject
          ? `Select “${notice.emailSubject}” in your inbox to view this result.`
          : 'Select the email this lookup came from to view this result.',
      );
      return;
    }
    const target = document.getElementById(notice.targetId);
    if (!target) {
      setReturnHint("That section isn't open any more");
      return;
    }
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    reporter.dismiss(notice.id);
  };

  return (
    <div
      role={notice.status === 'failed' ? 'alert' : 'status'}
      data-testid="hms-job-notice-banner"
      className={`mx-3 mt-2 flex shrink-0 items-start justify-between gap-2 rounded-sm border px-3 py-2 text-xs ${
        notice.status === 'failed'
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-emerald-200 bg-emerald-50 text-emerald-900'
      }`}
    >
      <div className="min-w-0">
        <p className="font-semibold">{notice.message}</p>
        {!sameEmail && notice.emailSubject ? (
          <p className="mt-0.5 text-[11px]">
            From “{notice.emailSubject}”. Select that email to view the result.
          </p>
        ) : null}
        {returnHint ? <p className="mt-0.5 text-[11px]">{returnHint}</p> : null}
        {moreCount ? <p className="mt-0.5 text-[11px]">{`+${moreCount} more`}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* A failed lookup is retried from its own card, which re-reads the current stay and refreshes the result there. */}
        <button
          type="button"
          aria-controls={notice.targetId}
          onClick={show}
          className="font-semibold underline"
        >
          {notice.status === 'done' ? 'Show' : 'Try again'}
        </button>
        <button
          type="button"
          aria-label="Dismiss HMS notice"
          onClick={() => reporter.dismiss(notice.id)}
          className="px-1 font-semibold"
        >
          ×
        </button>
      </div>
    </div>
  );
}
