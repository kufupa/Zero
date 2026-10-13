import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useHmsJobNoticeReporter } from './hms-job-notice-context';
import {
  isSettled,
  pendingJobView,
  pollHmsJob,
  type HmsJobKind,
  type HmsJobQueueOptions,
  type HmsJobRequest,
  type HmsJobTransport,
  type HmsJobView,
} from './amend-find';

/**
 * One pane HMS lookup as a persisted job. start queues a request and polls its run id until the job settles. The job
 * lives in the database, so after a remount the latest job of the resume kind on this thread is read back, and polled
 * when it is still moving. A change of `scope` (another email or booking selection) clears what is shown.
 */

export type HmsJobState = {
  /** The job on screen: queued, running, retrying, done (a dated snapshot) or failed. Null before any job. */
  view: HmsJobView | null;
  /** True while the queue call for a new request is in flight. */
  queuing: boolean;
  /** True when the queue call itself failed, so no job exists. */
  queueFailed: boolean;
  /** True when the read-back failed, so the pane can offer a safe retry. */
  statusFailed: boolean;
  /**
   * False until the read-back for the current scope answers. An auto-start is queued in that same step, so queuing,
   * view and queueFailed cover it after this turns true.
   */
  readBackSettled: boolean;
  start: (request: HmsJobRequest, options?: HmsJobQueueOptions) => void;
  /** Queues the last request again, for a job that failed. */
  retry: () => void;
};

function sameSurname(a: string, b: string): boolean {
  const norm = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/** True when a read-back job was queued for the resume's surname and arrival, each only when given. */
function resumedFor(
  request: HmsJobRequest | null,
  lastName: string | null,
  arrival: string | null,
  departure: string | null | undefined,
): boolean {
  if (lastName && !(request?.kind === 'search_guest' && sameSurname(request.lastName, lastName))) return false;
  if (arrival && request?.arrival !== arrival) return false;
  if (departure !== undefined && (request?.kind !== 'search_guest' || (request.departure ?? null) !== departure))
    return false;
  return true;
}

export function useHmsJob(input: {
  transport: HmsJobTransport | null;
  /**
   * The job to read back after a remount. Null reads nothing back. A surname or arrival limits the read-back to a job
   * queued for them, so a thread with mail about two guests never shows one guest's job under the other.
   */
  resume: { kind: HmsJobKind; confirmation?: string; lastName?: string; arrival?: string; departure?: string | null } | null;
  /** Changes with the email or booking selection. The shown job is cleared and the read-back runs again. */
  scope: string | null;
  /** Starts a search_guest request after read-back confirms that no matching job exists. */
  autoStartIfMissing?: boolean;
  /** Pane section to return to from the completion notice. Defaults by request kind. */
  targetId?: string;
}): HmsJobState {
  const { transport, resume, scope } = input;
  const autoStartIfMissing = input.autoStartIfMissing ?? false;
  const targetId = input.targetId;
  const noticeReporter = useHmsJobNoticeReporter();
  const noticeObserverId = useId();
  const nextNoticeJobId = useRef(0);
  const activeNoticeJobId = useRef<string | null>(null);
  const retryRef = useRef<() => void>(() => undefined);
  const resumeKind = resume?.kind ?? null;
  const resumeConfirmation = resume?.confirmation ?? null;
  const resumeLastName = resume?.lastName ?? null;
  const resumeArrival = resume?.arrival ?? null;
  const resumeHasDeparture = resume !== null && Object.hasOwn(resume, 'departure');
  const resumeDeparture = resumeHasDeparture ? resume?.departure ?? null : undefined;
  const [runId, setRunId] = useState<string | null>(null);
  const [view, setView] = useState<HmsJobView | null>(null);
  const [queuing, setQueuing] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [readBackSettled, setReadBackSettled] = useState(false);
  const [statusRetryRound, setStatusRetryRound] = useState(0);
  // Bumped by Retry after lost polling, so the poll loop starts again on the same run.
  const [pollRound, setPollRound] = useState(0);
  // Each start and each scope change takes a new generation. An answer from an older one is dropped.
  const generation = useRef(0);
  const lastRequest = useRef<HmsJobRequest | null>(null);
  const lastRequestOptions = useRef<HmsJobQueueOptions | undefined>(undefined);
  const autoStartedKey = useRef<string | null>(null);

  const start = useCallback(
    (request: HmsJobRequest, options?: HmsJobQueueOptions) => {
      if (!transport) return;
      const mine = ++generation.current;
      const jobId = `${noticeObserverId}:${++nextNoticeJobId.current}`;
      activeNoticeJobId.current = jobId;
      noticeReporter.started({
        observerId: noticeObserverId,
        jobId,
        request,
        targetId,
        retry: () => retryRef.current(),
        transport,
      });
      lastRequest.current = request;
      lastRequestOptions.current = options;
      setRunId(null);
      setView(null);
      setQueueFailed(false);
      setStatusFailed(false);
      setQueuing(true);
      (options ? transport.queue(request, options) : transport.queue(request)).then(
        (started) => {
          if (generation.current !== mine) {
            if (started.view) {
              if (isSettled(started.view)) {
                noticeReporter.settled(noticeObserverId, jobId, started.view, () => retryRef.current());
              } else {
                noticeReporter.pending({
                  observerId: noticeObserverId,
                  jobId,
                  request: started.view.request ?? request,
                  targetId,
                  retry: () => retryRef.current(),
                  transport,
                  runId: started.runId,
                });
              }
            } else if (started.runId !== null) {
              noticeReporter.pending({
                observerId: noticeObserverId,
                jobId,
                request,
                targetId,
                retry: () => retryRef.current(),
                transport,
                runId: started.runId,
              });
            } else {
              noticeReporter.cancel(noticeObserverId, jobId);
            }
            return;
          }
          setQueuing(false);
          // Job queue off: the lookup ran synchronously and its answer is already settled.
          if (started.view) {
            setView(started.view);
            if (isSettled(started.view)) {
              noticeReporter.settled(noticeObserverId, jobId, started.view, () => retryRef.current());
            }
          }
          else if (started.runId !== null) {
            // Queued until the first status read lands, so the panel never looks idle while the job exists.
            setView(pendingJobView(started.runId, request));
            setRunId(started.runId);
          } else {
            // An auto-start with the queue off queues nothing: the card stays idle until staff search by hand.
            noticeReporter.cancel(noticeObserverId, jobId);
          }
        },
        () => {
          if (generation.current !== mine) {
            noticeReporter.queueFailed(noticeObserverId, jobId, () => retryRef.current());
            return;
          }
          setQueuing(false);
          setQueueFailed(true);
        },
      );
    },
    [noticeReporter, noticeObserverId, targetId, transport],
  );

  const retry = useCallback(() => {
    if (statusFailed) {
      setStatusRetryRound((round) => round + 1);
      return;
    }
    // Lost polling is not a failed job: the run may still be running. Retry polls it again and never queues a second one.
    if (view?.status === 'failed' && view.failureClass === 'POLL_LOST' && runId !== null) {
      setPollRound((round) => round + 1);
      return;
    }
    const last = lastRequest.current;
    if (!last) return;
    // A persisted terminal failure can be retried as a fresh user job; keeping autoStart would reuse its failed key.
    // POLL_LOST with no known run keeps the stable key, so the server can reattach to a job that may be running.
    const options =
      view?.status === 'failed' && view.failureClass !== 'POLL_LOST' ? undefined : lastRequestOptions.current;
    start(last, options);
  }, [runId, start, statusFailed, view]);
  retryRef.current = retry;

  // Scope change or remount: clear, then read back the latest job of this kind on the thread.
  useEffect(() => {
    const mine = ++generation.current;
    lastRequest.current = null;
    setRunId(null);
    setView(null);
    setQueuing(false);
    setQueueFailed(false);
    setStatusFailed(false);
    setReadBackSettled(false);
    if (!transport || !resumeKind) return;
    let live = true;
    const query = {
      kind: resumeKind,
      ...(resumeConfirmation ? { confirmation: resumeConfirmation } : {}),
      ...(resumeLastName ? { lastName: resumeLastName } : {}),
      ...(resumeArrival ? { arrival: resumeArrival } : {}),
      ...(resumeHasDeparture ? { departure: resumeDeparture } : {}),
    };
    activeNoticeJobId.current = `${noticeObserverId}:${++nextNoticeJobId.current}`;
    transport.status(query).then(
      (found) => {
        if (!live || generation.current !== mine) return;
        setReadBackSettled(true);
        if (found && resumedFor(found.request, resumeLastName, resumeArrival, resumeDeparture)) {
          lastRequest.current = found.request;
          lastRequestOptions.current = undefined;
          setView(found);
          if (!isSettled(found)) setRunId(found.runId);
          return;
        }
        if (!autoStartIfMissing || resumeKind !== 'search_guest' || !resumeLastName || !resumeArrival) return;
        const key = `${scope ?? ''}\u0000${resumeLastName.trim().replace(/\s+/g, ' ').toLowerCase()}\u0000${resumeArrival}`;
        if (autoStartedKey.current === key) return;
        autoStartedKey.current = key;
        start({ kind: 'search_guest', lastName: resumeLastName, arrival: resumeArrival }, { autoStart: true });
      },
      () => {
        if (!live || generation.current !== mine) return;
        setReadBackSettled(true);
        setStatusFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [
    transport,
    noticeObserverId,
    scope,
    resumeKind,
    resumeConfirmation,
    resumeLastName,
    resumeArrival,
    resumeHasDeparture,
    resumeDeparture,
    autoStartIfMissing,
    statusRetryRound,
    start,
  ]);

  // Polls the current run id until it settles. A new run id, a new scope or an unmount ends the old loop.
  useEffect(() => {
    if (!transport || !runId) return;
    const mine = generation.current;
    let live = true;
    void pollHmsJob(transport, runId, {
      live: () => live && generation.current === mine,
      onView: (next) => setView(next),
    });
    return () => {
      live = false;
    };
  }, [transport, runId, pollRound]);

  const lastNoticeScope = useRef(scope);
  useEffect(() => {
    if (lastNoticeScope.current !== scope) {
      lastNoticeScope.current = scope;
      noticeReporter.detached(noticeObserverId);
      return;
    }
    const request = view?.request ?? lastRequest.current;
    if (!request) return;
    const jobId = activeNoticeJobId.current;
    if (!jobId) return;
    const input = {
      observerId: noticeObserverId,
      jobId,
      request,
      targetId,
      retry: () => retryRef.current(),
      transport,
      runId: view?.runId ?? runId,
    };
    if (queuing || (view !== null && !isSettled(view))) {
      noticeReporter.pending(input);
      return;
    }
    if (view && isSettled(view)) noticeReporter.settled(noticeObserverId, jobId, view, () => retryRef.current());
    else if (queueFailed) noticeReporter.queueFailed(noticeObserverId, jobId, () => retryRef.current());
  }, [
    noticeReporter,
    noticeObserverId,
    queueFailed,
    queuing,
    runId,
    scope,
    targetId,
    transport,
    view,
  ]);

  useEffect(
    () => () => {
      generation.current += 1;
      noticeReporter.detached(noticeObserverId);
    },
    [noticeReporter, noticeObserverId],
  );

  return { view, queuing, queueFailed, statusFailed, readBackSettled, start, retry };
}
