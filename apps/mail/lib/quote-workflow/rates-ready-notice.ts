import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { getMailCacheScope, subscribeMailCacheScope } from '../mail/mail-cache-scope';
import { HMS_JOB_POLL_MS } from './amend-find';
import type { StaffQuoteJobQuery, StaffQuoteJobView } from './staff-quote-bind';

export type OwnStaffQuoteJob = {
  runId: string;
  status: StaffQuoteJobView['status'];
  messageId: string;
  threadId: string | null;
  emailKey: string | null;
  subject: string | null;
  entryId: string | null;
  refused: boolean;
};
export type RatesReadyNotice = { runId: string; title: string; threadId: string | null; entryId: string | null };
type OpenDeps = { onOpenThread?: (threadId: string) => void; displayMessageForm?: (itemId: string) => void };
type JobMeta = Omit<OwnStaffQuoteJob, 'runId' | 'status' | 'refused'>;
const ownerKey = () => `${getMailCacheScope().userId}:${getMailCacheScope().activeTransportId}`;
// One list for every pane mount: the web panel remounts per thread, so a pane-owned list lost the job on switch.
export const ratesReadyJobs: { current: OwnStaffQuoteJob[] } = { current: [] };
const notifiedRuns = { ids: new Set<string>(), owner: '' };
const answers = (job: OwnStaffQuoteJob) => job.status === 'done' || job.refused;

export function ratesReadyToastTitle(job: Pick<OwnStaffQuoteJob, 'refused' | 'subject'>): string {
  return `${job.refused ? 'HMS answered' : 'Rates ready'} · ${job.subject?.trim() || 'this email'}`;
}

export function staffQuoteViewRefused(view: Pick<StaffQuoteJobView, 'status' | 'result'>): boolean {
  const result = view.result;
  return result?.ok === false || (view.status === 'done' && result != null && result.status !== 'ready');
}

export function ratesReadyNotices(input: {
  prev: OwnStaffQuoteJob[]; next: OwnStaffQuoteJob[];
  openMessageId: string | null; openEmailKey: string | null; notifiedIds: ReadonlySet<string>;
}): RatesReadyNotice[] {
  const prevById = new Map(input.prev.map((job) => [job.runId, job]));
  return input.next.flatMap((job) => {
    const prior = prevById.get(job.runId);
    if (!answers(job) || input.notifiedIds.has(job.runId) || (prior && answers(prior))) return [];
    if (job.messageId && job.messageId === input.openMessageId) return [];
    if (job.emailKey && job.emailKey === input.openEmailKey) return [];
    return [{ runId: job.runId, title: ratesReadyToastTitle(job), threadId: job.threadId, entryId: job.entryId }];
  });
}

function remember(jobs: OwnStaffQuoteJob[], job: OwnStaffQuoteJob): void {
  const index = jobs.findIndex((row) => row.runId === job.runId);
  const prior = index < 0 ? undefined : jobs[index];
  const merged = { ...job, subject: job.subject ?? prior?.subject ?? null, emailKey: job.emailKey ?? prior?.emailKey ?? null, entryId: job.entryId ?? prior?.entryId ?? null, threadId: job.threadId ?? prior?.threadId ?? null };
  if (index < 0) jobs.push(merged); else jobs[index] = merged;
}

export function trackingStaffQuoteJob(
  jobsRef: { current: OwnStaffQuoteJob[] },
  query: StaffQuoteJobQuery | undefined,
  meta: () => JobMeta,
): StaffQuoteJobQuery | undefined {
  if (!query) return undefined;
  return async (input, options) => {
    const view = await query(input, options);
    if (view?.runId) remember(jobsRef.current, { ...meta(), runId: view.runId, status: view.status, refused: staffQuoteViewRefused(view) });
    return view;
  };
}

function officeDisplay(): ((id: string) => void) | undefined {
  const mailbox = (globalThis as { Office?: { context?: { mailbox?: { displayMessageForm?: (id: string) => void } } } }).Office?.context?.mailbox;
  return typeof mailbox?.displayMessageForm === 'function' ? (id) => mailbox.displayMessageForm!(id) : undefined;
}

export function canOpenRatesReadyMail(deps: OpenDeps = {}): boolean {
  return Boolean(deps.onOpenThread || deps.displayMessageForm || officeDisplay());
}

export function openRatesReadyMail(target: { threadId: string | null; entryId: string | null }, deps: OpenDeps = {}): void {
  if (target.threadId && deps.onOpenThread) { deps.onOpenThread(target.threadId); return; }
  const display = deps.displayMessageForm ?? officeDisplay();
  if (target.entryId && display) display(target.entryId);
}

export function useRatesReadyNotice(input: {
  jobsRef: { current: OwnStaffQuoteJob[] };
  openMessageId: string | null; openEmailKey: string | null;
  query?: StaffQuoteJobQuery; onOpenThread?: (threadId: string) => void;
}): void {
  const live = useRef(input);
  live.current = input;
  useEffect(() => {
    let stopped = false;
    let prev: OwnStaffQuoteJob[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetOwner = () => {
      const next = ownerKey();
      if (notifiedRuns.owner === next) return;
      notifiedRuns.owner = next;
      live.current.jobsRef.current = [];
      notifiedRuns.ids = new Set(); prev = [];
    };
    const poll = async () => {
      resetOwner();
      const { jobsRef, query, openMessageId, openEmailKey, onOpenThread } = live.current;
      const jobs = jobsRef.current;
      for (const job of jobs) {
        if (answers(job) || !query) continue;
        try {
          const view = await query({ runId: job.runId });
          if (view) remember(jobs, { ...job, status: view.status, refused: staffQuoteViewRefused(view) });
        } catch { /* keep the pane-session row */ }
      }
      if (stopped) return;
      const notices = ratesReadyNotices({ prev, next: jobs, openMessageId, openEmailKey, notifiedIds: notifiedRuns.ids });
      prev = jobs.map((job) => ({ ...job }));
      // A job seen finished (toasted or on screen) never toasts again, even from a later pane mount.
      for (const job of jobs) if (answers(job)) notifiedRuns.ids.add(job.runId);
      for (const notice of notices) {
        toast(notice.title, canOpenRatesReadyMail({ onOpenThread })
          ? { action: { label: 'Open', onClick: () => openRatesReadyMail(notice, live.current) } }
          : undefined);
      }
      timer = setTimeout(poll, HMS_JOB_POLL_MS);
    };
    const unsub = subscribeMailCacheScope(resetOwner);
    void poll();
    return () => { stopped = true; unsub(); clearTimeout(timer); };
  }, []);
}
