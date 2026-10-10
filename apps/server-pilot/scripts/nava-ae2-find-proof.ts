/**
 * AE2 live proof: on an amendment email, "Find this booking in HMS" looks the booking up by its booked dates.
 *
 * AE2 (docs/plans/2026-10-09-001-feat-nava-pane-weekend-v4-plan.md): the guest adds the night of 31 Oct and late checkout
 * on 7 Nov; HMS has 1-6 Nov. The pane reads requested 31 Oct-7 Nov and booked 1-6 Nov, and the lookup uses the booked
 * dates. PASS means:
 *   - the find request the pane sends carries the booked arrival (amendment.arrival), not the requested one;
 *   - the booking is found, and "Booking in HMS now" shows the arrival and departure the job read.
 *
 * The driver opens one thread in /nava-preview, waits for the pane to read it and for the amendment card, clicks "Find
 * this booking in HMS" once, waits for the job to settle, and screenshots the card with guest details masked. When the card
 * already shows a stored lookup (a staff or prefetch job read back from the database), the button is gone: the driver
 * reports that job's request and result instead, and makes no HMS call.
 *
 * Mailbox: when NAVA_PREVIEW_TRANSPORT_ID is not the account's default mailbox, the driver makes it the default with
 * connections.setDefault before opening the pane and always puts the previous default back afterwards
 * (nava-proof-safety.ts withActiveMailbox). The summary records activeMailboxSwitched and restored; a failed restore fails
 * the run. Only the driver's own setDefault calls pass the guard; one from the pane is blocked.
 *
 * Guard: every tRPC request is checked by procedure name. Reads (paneStayLookup.jobStatus and .screenshot among them) and
 * the analysis pass. Exactly one find passes: paneStayLookup.queueFind (HMS_JOB_QUEUE=on: the hms worker reads HMS), or,
 * only after a queueFind that returned no run id (queue off), paneStayLookup.findStay. Every HMS write (cancel preview and
 * commit, quote and booking writes), every guest-name search, every mailbox write, workItems.open/recordEvent and every
 * unknown call is aborted.
 *
 * HMS calls: one read-only find (Guest Stay quick search and the booking record). No HMS write.
 * Rows written: one ai_workflow_run (the queued find job, priority user), which the hms worker updates with its status and
 * snapshot; with the HITL ledger on, the worker may add its hitl_tool_run kind stay_lookup. With the queue off, findStay
 * adds that hitl_tool_run row only.
 *
 * The summary never holds a guest name or the booking number: only dates, statuses and counts.
 *
 * Usage: nava-preview-gate.sh --ae2-find <thread-id>   (signs in, then runs:)
 *   pnpm --dir apps/server-pilot exec tsx scripts/nava-ae2-find-proof.ts --threads <id> --out <dir> --timeout-ms 600000
 *
 * Output: <out>/summary.json, amend.png (the amendment card), pane.png. The last stdout line is the summary as one JSON
 * line. Exit 0 pass, 1 AE2 failed, 2 blocked before the proof could finish.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import {
  batchInput,
  Blocker,
  latestOutcome,
  readPane,
  trpcProcedures,
  visibleText,
  waitFor,
  type Captured,
  type TrpcOutcome,
} from './nava-ae4-override-proof';
import {
  browserMailboxApi,
  captureShots,
  mailboxFailures,
  MailboxSwitchError,
  newMailboxPermit,
  newMailboxSwitch,
  openProofPage,
  openThread,
  STEP_MS,
  unexpectedBlocks,
  withActiveMailbox,
  withMailboxPermit,
  type GuardDecision,
  type MailboxRecord,
} from './nava-proof-kit';
import { ANALYSIS_PROCEDURES, KNOWN_WRITE_PROCEDURES, parseRunConfig, READ_PROCEDURES, redactText, type RunConfig } from './nava-preview-run';

export const QUEUE_FIND_PROCEDURE = 'paneStayLookup.queueFind';
export const SYNC_FIND_PROCEDURE = 'paneStayLookup.findStay';
export const JOB_STATUS_PROCEDURE = 'paneStayLookup.jobStatus';

export type Ae2Config = RunConfig & { threadId: string };

export function parseAe2Config(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Ae2Config {
  const base = parseRunConfig(argv, env, cwd);
  if (base.selection.kind !== 'threads' || base.selection.ids.length !== 1) {
    throw new Error('AE2 runs on exactly one thread: --threads <id>');
  }
  return { ...base, threadId: base.selection.ids[0]! };
}

// ---------------------------------------------------------------------------------------------------------------------
// Request guard

export type Ae2GuardState = {
  queueFinds: number;
  syncFinds: number;
  /** Set once queueFind answered with no run id: the server's job queue is off, so the pane runs findStay next. */
  queueOff: boolean;
  /** The arrival the find request carried (ISO day) or null when it sent none. Undefined before any find. */
  sentArrival: string | null | undefined;
};
export type Ae2BlockReason = 'write' | 'unknown' | 'second_find' | 'sync_find_with_queue';

export function newAe2GuardState(): Ae2GuardState {
  return { queueFinds: 0, syncFinds: 0, queueOff: false, sentArrival: undefined };
}

function arrivalOf(input: unknown): string | null {
  const arrival = (input as { arrival?: unknown } | null)?.arrival;
  return typeof arrival === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(arrival) ? arrival : null;
}

/** Whether one request may go. Exactly one find passes; the state changes only when the whole request is let through. */
export function classifyAe2Request(
  url: string,
  postData: string | null,
  state: Ae2GuardState,
): GuardDecision<Ae2BlockReason> {
  const procedures = trpcProcedures(url);
  if (procedures.length === 0) {
    return { allowed: false, procedures, blocked: [{ procedure: '(none)', reason: 'unknown' }] };
  }
  const blocked: GuardDecision<Ae2BlockReason>['blocked'] = [];
  let queueFinds = 0;
  let syncFinds = 0;
  let sentArrival: string | null | undefined;
  procedures.forEach((procedure, index) => {
    if (READ_PROCEDURES.has(procedure) || ANALYSIS_PROCEDURES.has(procedure)) return;
    if (procedure === QUEUE_FIND_PROCEDURE) {
      if (state.queueFinds + queueFinds >= 1) blocked.push({ procedure, reason: 'second_find' });
      else {
        queueFinds += 1;
        sentArrival = arrivalOf(batchInput(postData, index));
      }
      return;
    }
    if (procedure === SYNC_FIND_PROCEDURE) {
      if (!state.queueOff) blocked.push({ procedure, reason: 'sync_find_with_queue' });
      else if (state.syncFinds + syncFinds >= 1) blocked.push({ procedure, reason: 'second_find' });
      else syncFinds += 1;
      return;
    }
    blocked.push({ procedure, reason: KNOWN_WRITE_PROCEDURES.has(procedure) ? 'write' : 'unknown' });
  });
  const allowed = blocked.length === 0;
  if (allowed) {
    state.queueFinds += queueFinds;
    state.syncFinds += syncFinds;
    if (sentArrival !== undefined) state.sentArrival = sentArrival;
  }
  return { allowed, procedures, blocked };
}

/** Writes the pane sends on open that the proof blocks by design. They do not fail AE2: the card renders without them. */
export const AE2_EXPECTED_BLOCKS: readonly string[] = ['workItems.open (write)', 'workItems.recordEvent (write)'];

// ---------------------------------------------------------------------------------------------------------------------
// The amendment, the job and the card

export type AmendDates = { arrival: string | null; departure: string | null };
export type AmendRead = { kind: string | null; booked: AmendDates; requested: AmendDates };

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null;

/**
 * The amendment the pane reads, from a stored read (workItems.getByMessage: analysis.amendment) or a live one
 * (quoteWorkflow.analyseSelection: amendment). Only its kind and dates are kept. Requested dates are absent on older
 * payloads; then they read as null.
 */
export function amendmentOf(data: unknown): AmendRead | null {
  const view = (data ?? {}) as { amendment?: unknown; analysis?: { amendment?: unknown } };
  const raw = (view.analysis?.amendment ?? view.amendment) as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    booked: { arrival: isoOrNull(raw.arrival), departure: isoOrNull(raw.departure) },
    requested: { arrival: isoOrNull(raw.requestedArrival), departure: isoOrNull(raw.requestedDeparture) },
  };
}

/** One find job as paneStayLookup.jobStatus returns it, without the guest's name or booking number. */
export type FindJob = {
  runId: string | null;
  status: string | null;
  prefetch: boolean;
  attempts: number | null;
  failureClass: string | null;
  /** The arrival the job was queued with (its stored request). */
  requestArrival: string | null;
  outcome: string | null;
  stayArrival: string | null;
  stayDeparture: string | null;
  arrivalMismatch: boolean;
};

export function findJobOf(data: unknown): FindJob | null {
  if (!data || typeof data !== 'object') return null;
  const view = data as Record<string, unknown>;
  const request = (view.request ?? null) as { kind?: unknown; arrival?: unknown } | null;
  if (request && request.kind !== 'find') return null;
  const result = (view.result ?? null) as { outcome?: unknown; stay?: unknown; arrivalMismatch?: unknown } | null;
  const stay = (result?.stay ?? null) as { arrival?: unknown; departure?: unknown } | null;
  return {
    runId: typeof view.runId === 'string' ? view.runId : null,
    status: typeof view.status === 'string' ? view.status : null,
    prefetch: view.prefetch === true,
    attempts: Number.isSafeInteger(view.attempts) ? (view.attempts as number) : null,
    failureClass: typeof view.failureClass === 'string' ? view.failureClass : null,
    requestArrival: isoOrNull(request?.arrival),
    outcome: typeof result?.outcome === 'string' ? result.outcome : null,
    stayArrival: isoOrNull(stay?.arrival),
    stayDeparture: isoOrNull(stay?.departure),
    arrivalMismatch: result?.arrivalMismatch === true,
  };
}

/** The synchronous findStay reply (queue off) as a settled job. */
function syncFindJob(data: unknown): FindJob | null {
  if (!data || typeof data !== 'object') return null;
  return findJobOf({ status: 'done', result: data, runId: (data as { runId?: unknown }).runId ?? null });
}

export const isSettledJob = (job: FindJob | null): boolean => job?.status === 'done' || job?.status === 'failed';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Nov 2026" (amend-find.ts formatStayDate) as 2026-11-01. An ISO day passes through. Anything else is null. */
export function shownDateToIso(text: string | null | undefined): string | null {
  const value = (text ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(value);
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  if (!match || month < 1) return null;
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
}

export type LookupDates = 'booked' | 'requested' | 'indistinct' | 'none' | 'other';

/**
 * Which of the email's dates the find carried. The find sends one arrival: booked when it is the booking's arrival,
 * requested when it is the arrival the guest wants. When both are the same day the run cannot tell them apart.
 */
export function lookupDatesUsed(sent: string | null, amendment: AmendRead | null): LookupDates {
  if (!sent) return 'none';
  const booked = amendment?.booked.arrival ?? null;
  const requested = amendment?.requested.arrival ?? null;
  if (booked && sent === booked && requested === booked) return 'indistinct';
  if (booked && sent === booked) return 'booked';
  if (requested && sent === requested) return 'requested';
  return 'other';
}

// ---------------------------------------------------------------------------------------------------------------------
// Summary

export type Ae2Summary = MailboxRecord & {
  ok: boolean;
  run: string;
  threadId: string;
  /** The type the pane shows (the type picker's choice). */
  paneType: string | null;
  amendmentKind: string | null;
  /** 'pane' when the driver clicked Find; 'stored_job' when the card read back an earlier job and showed no button. */
  requestFrom: 'pane' | 'stored_job' | null;
  /** 'on' when queueFind returned a job; 'off' when it ran through findStay. Null without a find from the pane. */
  queue: 'on' | 'off' | null;
  findCalls: number;
  /** HMS reads this run caused: 1 for a find from the pane, 0 for a stored job. */
  hmsReads: number;
  jobStatus: string | null;
  jobOutcome: string | null;
  failureClass: string | null;
  attempts: number | null;
  found: boolean | null;
  /** The arrival the find request carried. */
  lookupArrival: string | null;
  lookupDates: LookupDates;
  emailBooked: AmendDates;
  emailRequested: AmendDates;
  /** The booking's dates the job read from HMS. */
  hmsArrival: string | null;
  hmsDeparture: string | null;
  /** The dates "Booking in HMS now" shows. */
  shownArrival: string | null;
  shownDeparture: string | null;
  arrivalMismatch: boolean;
  screenshots: { amend: boolean; pane: boolean };
  blocked: string[];
  blocker: string | null;
  failures: string[];
};

/** What keeps the run from passing. Empty means AE2 passed. */
export function ae2Failures(summary: Omit<Ae2Summary, 'ok' | 'failures'>): string[] {
  const failures: string[] = [];
  if (summary.blocker) failures.push(`blocker: ${summary.blocker}`);
  if (summary.found !== true) {
    failures.push(`the booking was not found in HMS (${summary.jobOutcome ?? summary.jobStatus ?? 'no result'})`);
  }
  if (summary.lookupDates === 'none') failures.push('the find sent no arrival');
  else if (summary.lookupDates === 'indistinct') failures.push('the booked and requested arrival are the same day, so the run cannot tell which the find used');
  else if (summary.lookupDates !== 'booked') failures.push(`the find used the ${summary.lookupDates} arrival, not the booked one`);
  if (summary.found === true && (summary.shownArrival !== summary.hmsArrival || summary.shownDeparture !== summary.hmsDeparture)) {
    failures.push('"Booking in HMS now" does not show the dates the job read');
  }
  if (summary.findCalls > 1) failures.push(`expected one find, saw ${summary.findCalls}`);
  failures.push(...mailboxFailures(summary));
  const unexpected = unexpectedBlocks(summary.blocked, AE2_EXPECTED_BLOCKS);
  if (unexpected.length) failures.push(`the guard blocked: ${unexpected.join(', ')}`);
  if (!summary.screenshots.amend) failures.push('the amendment card screenshot is missing');
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser run

export const CARD = '[data-preview-pane] [data-testid="amend-lookup-panel"]';
export const FIND_BUTTON = 'Find this booking in HMS';

function lastJob(captured: Captured, after = 0, runId?: string | null): FindJob | null {
  for (let i = captured.outcomes.length - 1; i >= after; i--) {
    const outcome: TrpcOutcome = captured.outcomes[i]!;
    if (outcome.procedure !== JOB_STATUS_PROCEDURE) continue;
    const job = findJobOf(outcome.data);
    if (job && (!runId || job.runId === runId)) return job;
  }
  return null;
}

/** The arrival and departure "Booking in HMS now" shows, as ISO days. */
async function shownDates(page: Page): Promise<AmendDates> {
  const read = async (field: string) => {
    const text = await page
      .locator(`${CARD} [data-field="${field}"] p`)
      .nth(1)
      .innerText({ timeout: 2_000 })
      .catch(() => '');
    return shownDateToIso(text);
  };
  return { arrival: await read('arrival'), departure: await read('departure') };
}

export async function runAe2(config: Ae2Config, log: (line: string) => void): Promise<Ae2Summary> {
  const { threadId } = config;
  const run = basename(config.outDir) || 'ae2-find';
  mkdirSync(config.outDir, { recursive: true, mode: 0o700 });
  const state = newAe2GuardState();
  const summary: Omit<Ae2Summary, 'ok' | 'failures'> = {
    run,
    threadId,
    paneType: null,
    amendmentKind: null,
    requestFrom: null,
    queue: null,
    findCalls: 0,
    hmsReads: 0,
    jobStatus: null,
    jobOutcome: null,
    failureClass: null,
    attempts: null,
    found: null,
    lookupArrival: null,
    lookupDates: 'none',
    emailBooked: { arrival: null, departure: null },
    emailRequested: { arrival: null, departure: null },
    hmsArrival: null,
    hmsDeparture: null,
    shownArrival: null,
    shownDeparture: null,
    arrivalMismatch: false,
    screenshots: { amend: false, pane: false },
    activeMailboxSwitched: false,
    restored: false,
    blocked: [],
    blocker: null,
  };
  let amendment: AmendRead | null = null;

  const steps = async (page: Page, captured: Captured): Promise<void> => {
    // 1. Open the thread, let the pane read it, and wait for the amendment card.
    await openThread(page, config.baseUrl, threadId);
    summary.paneType = (await readPane(page, threadId))?.intent ?? null;
    log('pane settled');
    const card = page.locator(CARD);
    await card.waitFor({ state: 'visible', timeout: STEP_MS }).catch(() => {
      throw new Blocker('no amendment card: the pane does not read this email as a change or cancellation');
    });
    amendment = await waitFor('the amendment read', 15_000, async () => {
      for (let i = captured.outcomes.length - 1; i >= 0; i--) {
        const read = amendmentOf(captured.outcomes[i]!.data);
        if (read) return read;
      }
      return null;
    }).catch(() => null);
    summary.amendmentKind = amendment?.kind ?? null;
    summary.emailBooked = amendment?.booked ?? summary.emailBooked;
    summary.emailRequested = amendment?.requested ?? summary.emailRequested;

    // 2. The card reads back the latest find job on the thread first. Give that read a moment to land.
    await waitFor('the stored find job', 10_000, async () =>
      captured.outcomes.some((outcome) => outcome.procedure === JOB_STATUS_PROCEDURE) ? true : null,
    ).catch(() => undefined);
    const button = card.getByRole('button', { name: FIND_BUTTON, exact: true });
    // The button is enabled, or gone because the card shows a found booking. A staff job still running keeps it
    // disabled until it settles; any other disabled button (no HMS number in the email) is a blocker after STEP_MS.
    const waitStarted = Date.now();
    const offer = await waitFor(`${FIND_BUTTON} to be enabled`, config.timeoutMs, async () => {
      if (!(await button.isVisible().catch(() => false))) return 'stored' as const;
      if (await button.isEnabled()) return 'ready' as const;
      const inFlight = lastJob(captured);
      if (Date.now() - waitStarted > STEP_MS && !(inFlight && !isSettledJob(inFlight))) {
        throw new Blocker(`${FIND_BUTTON} is disabled: ${await visibleText(page, CARD)}`);
      }
      return null;
    });
    let job: FindJob | null = null;
    if (offer === 'ready') {
      // 3. One find from the pane.
      const before = captured.outcomes.length;
      await button.click();
      summary.requestFrom = 'pane';
      const queued = await waitFor('the find to be queued', STEP_MS, async () => latestOutcome(captured, QUEUE_FIND_PROCEDURE, before)).catch(
        async () => {
          throw new Blocker(`the find was not queued: ${await visibleText(page, CARD)}`);
        },
      );
      if (queued.error) throw new Blocker(`the find was refused: ${redactText(queued.error.message).slice(0, 240)}`);
      const runId = (queued.data as { runId?: unknown } | undefined)?.runId;
      if (typeof runId === 'string') {
        summary.queue = 'on';
        log('find queued');
        job = await waitFor('the find job', config.timeoutMs, async () => {
          const latest = lastJob(captured, before, runId);
          return isSettledJob(latest) ? latest : null;
        });
      } else {
        summary.queue = 'off';
        state.queueOff = true;
        log('job queue off: the pane runs the find directly');
        const sync = await waitFor('the find', config.timeoutMs, async () => latestOutcome(captured, SYNC_FIND_PROCEDURE, before));
        if (sync.error) throw new Blocker(`the find failed: ${redactText(sync.error.message).slice(0, 240)}`);
        job = syncFindJob(sync.data);
      }
      summary.lookupArrival = state.sentArrival ?? null;
    } else {
      // The card already shows a stored lookup, so it offers no Find. Report that job; this run made no HMS call.
      job = await waitFor('the stored find job to settle', config.timeoutMs, async () => {
        const latest = lastJob(captured);
        return isSettledJob(latest) ? latest : null;
      }).catch(async () => {
        throw new Blocker(`${FIND_BUTTON} is not offered and no settled find job is shown: ${await visibleText(page, CARD)}`);
      });
      summary.requestFrom = 'stored_job';
      summary.lookupArrival = job?.requestArrival ?? null;
      log('the card shows a stored find job');
    }

    // 4. The result, as the job holds it and as the card shows it.
    summary.jobStatus = job?.status ?? null;
    summary.jobOutcome = job?.outcome ?? null;
    summary.failureClass = job?.failureClass ?? null;
    summary.attempts = job?.attempts ?? null;
    summary.found = job ? job.status === 'done' && job.outcome === 'found' : null;
    summary.hmsArrival = job?.stayArrival ?? null;
    summary.hmsDeparture = job?.stayDeparture ?? null;
    summary.arrivalMismatch = job?.arrivalMismatch ?? false;
    if (summary.found) {
      await waitFor('"Booking in HMS now"', STEP_MS, async () =>
        (await page.locator(`${CARD} [data-field="arrival"]`).count()) > 0 ? true : null,
      ).catch(() => undefined);
      const shown = await shownDates(page);
      summary.shownArrival = shown.arrival;
      summary.shownDeparture = shown.departure;
    }
    log(`find settled: ${summary.jobStatus ?? 'unknown'} ${summary.jobOutcome ?? ''}`.trim());

    // 5. The amendment card, guest details masked.
    const shots = await captureShots(page, config.outDir, { amend: CARD });
    summary.screenshots = { amend: shots.amend === true, pane: shots.pane === true };
  };

  const permit = newMailboxPermit();
  const mailbox = newMailboxSwitch();
  const { browser, context, page, captured } = await openProofPage(
    config,
    withMailboxPermit((url, postData) => classifyAe2Request(url, postData, state), permit),
  );
  try {
    try {
      // The run's transport is the active mailbox while the pane is open; the previous default comes back after.
      await withActiveMailbox(browserMailboxApi(context, config.baseUrl, permit), config.transportId, mailbox, log, () =>
        steps(page, captured),
      );
    } catch (error) {
      if (!(error instanceof Blocker) && !(error instanceof MailboxSwitchError)) throw error;
      summary.blocker = error.message;
      const shots = await captureShots(page, config.outDir, { amend: CARD }).catch(() => ({}) as Record<string, boolean>);
      summary.screenshots = { amend: shots.amend === true, pane: shots.pane === true };
    }
    await context.close();
  } finally {
    summary.activeMailboxSwitched = mailbox.activeMailboxSwitched;
    summary.restored = mailbox.restored;
    await browser.close();
  }
  summary.findCalls = state.queueFinds + state.syncFinds;
  // A queued find is read by the hms worker; with the queue off, findStay reads HMS. queueFind alone (queue off) does not.
  summary.hmsReads = summary.queue === 'on' ? state.queueFinds : state.syncFinds;
  if (summary.requestFrom === 'pane' && state.sentArrival !== undefined) summary.lookupArrival = state.sentArrival;
  summary.lookupDates = lookupDatesUsed(summary.lookupArrival, amendment);
  summary.blocked = [...new Set(captured.blocked)].slice(0, 30);
  const failures = ae2Failures(summary);
  return { ...summary, ok: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const config = parseAe2Config(process.argv.slice(2), process.env, process.cwd());
  const summary = await runAe2(config, (line) => console.log(line));
  writeFileSync(join(config.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`out: ${config.outDir}`);
  console.log(JSON.stringify(summary));
  // 0 pass, 1 AE2 failed, 2 blocked before the proof could finish.
  process.exitCode = summary.ok ? 0 : summary.blocker ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Error text can echo page content, so print the message only and never the stack.
    console.error(`nava-ae2-find-proof: ${error instanceof Error ? redactText(error.message) : 'failed'}`);
    process.exitCode = 2;
  });
}
