import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isSettled,
  pollHmsJob,
  type HmsJobKind,
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
  start: (request: HmsJobRequest) => void;
  /** Queues the last request again, for a job that failed. */
  retry: () => void;
};

export function useHmsJob(input: {
  transport: HmsJobTransport | null;
  /** The job to read back after a remount. Null reads nothing back. */
  resume: { kind: HmsJobKind; confirmation?: string } | null;
  /** Changes with the email or booking selection. The shown job is cleared and the read-back runs again. */
  scope: string | null;
}): HmsJobState {
  const { transport, resume, scope } = input;
  const resumeKind = resume?.kind ?? null;
  const resumeConfirmation = resume?.confirmation ?? null;
  const [runId, setRunId] = useState<string | null>(null);
  const [view, setView] = useState<HmsJobView | null>(null);
  const [queuing, setQueuing] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  // Each start and each scope change takes a new generation. An answer from an older one is dropped.
  const generation = useRef(0);
  const lastRequest = useRef<HmsJobRequest | null>(null);

  // Scope change or remount: clear, then read back the latest job of this kind on the thread.
  useEffect(() => {
    const mine = ++generation.current;
    lastRequest.current = null;
    setRunId(null);
    setView(null);
    setQueuing(false);
    setQueueFailed(false);
    if (!transport || !resumeKind) return;
    let live = true;
    const query = resumeConfirmation
      ? { kind: resumeKind, confirmation: resumeConfirmation }
      : { kind: resumeKind };
    transport.status(query).then(
      (found) => {
        if (!live || generation.current !== mine || !found) return;
        lastRequest.current = found.request;
        setView(found);
        if (!isSettled(found)) setRunId(found.runId);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [transport, scope, resumeKind, resumeConfirmation]);

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
  }, [transport, runId]);

  const start = useCallback(
    (request: HmsJobRequest) => {
      if (!transport) return;
      const mine = ++generation.current;
      lastRequest.current = request;
      setRunId(null);
      setView(null);
      setQueueFailed(false);
      setQueuing(true);
      transport.queue(request).then(
        (started) => {
          if (generation.current !== mine) return;
          setQueuing(false);
          // Job queue off: the lookup ran synchronously and its answer is already settled.
          if (started.view) setView(started.view);
          else setRunId(started.runId);
        },
        () => {
          if (generation.current !== mine) return;
          setQueuing(false);
          setQueueFailed(true);
        },
      );
    },
    [transport],
  );

  const retry = useCallback(() => {
    const last = lastRequest.current;
    if (last) start(last);
  }, [start]);

  return { view, queuing, queueFailed, start, retry };
}
