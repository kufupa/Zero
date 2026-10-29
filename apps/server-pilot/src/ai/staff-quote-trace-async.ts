/**
 * Provisional staff quote capture, enabled only by QUOTE_TRACE_ASYNC=on.
 *
 * The child process writes result.provisional.json and a marker once the quote is captured, then
 * finishes the browser trace. The parent treats the capture as provisional until the child has
 * exited cleanly and its final result.json matches. Every later step that uses the run waits here.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export function quoteTraceAsyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QUOTE_TRACE_ASYNC === 'on';
}

/**
 * Child-side script. Same shape as the sequential script in staff-quote-installation.ts, but it
 * reports the capture as soon as fetchQuote hands it over, then waits for the trace to finish.
 */
export const PROVISIONAL_QUOTE_SCRIPT =
  "import {writeFileSync} from 'node:fs';const {fetchQuote}=await import(process.argv[2]);let early=false;const result=await fetchQuote({requestPath:process.argv[3],outputDir:process.argv[4],onCaptured:provisional=>{early=true;writeFileSync(process.argv[1],JSON.stringify({evidenceDirectory:provisional.evidenceDirectory,traceFinish:'pending'}),{mode:0o600,flag:'wx'});}});writeFileSync(process.argv[1]+'.final',JSON.stringify({evidenceDirectory:result.evidenceDirectory,outcome:result.outcome,auditStatus:result.audit?.status??null}),{mode:0o600,flag:'wx'});if(!early)writeFileSync(process.argv[1],JSON.stringify({evidenceDirectory:result.evidenceDirectory}),{mode:0o600,flag:'wx'});process.exit(0);";

const pendingFinishes = new Map<string, Promise<void>>();

/** Registers one run's trace finish under every id a caller may use for it. Never rejects. */
export function registerPendingStaffQuote(keys: readonly string[], finish: Promise<void>): void {
  const settled = finish.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) pendingFinishes.set(key, settled);
  void settled.then(() => {
    for (const key of keys) if (pendingFinishes.get(key) === settled) pendingFinishes.delete(key);
  });
}

/** Resolves once a provisional run has finished its trace. Resolves at once for any other id. */
export async function awaitPendingStaffQuote(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await pendingFinishes.get(key);
}

export type ProvisionalChildOutcome =
  | { kind: 'provisional'; evidenceDirectory: string; finished: Promise<void> }
  | { kind: 'settled' };

type Marker = { evidenceDirectory: string; traceFinish: 'pending' };
type Exit = { code: number | null } | { error: Error };

async function readMarker(path: string): Promise<Marker | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  const value = parsed as Partial<Marker> | null;
  return value && typeof value.evidenceDirectory === 'string' && value.traceFinish === 'pending'
    ? { evidenceDirectory: value.evidenceDirectory, traceFinish: 'pending' }
    : null;
}

/**
 * Starts one capture child and returns as soon as the quote is captured, or when the child exits
 * without a provisional capture (kind 'settled'; the caller then reads resultPath as before).
 * A new child waits for the previous capture's finish, so two browser sessions never overlap.
 * `finished` settles only after the child exited 0, its final file says quote with a complete
 * audit, and verifyFinal accepts the final capture. It never rejects unhandled.
 */
export async function runProvisionalQuoteChild(input: {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  resultPath: string;
  previousFinish: Promise<void>;
  verifyFinal: (evidenceDirectory: string) => Promise<void>;
}): Promise<ProvisionalChildOutcome> {
  await input.previousFinish;
  input.signal.throwIfAborted();
  const child = spawn(input.executable, input.args, {
    env: input.env,
    signal: input.signal,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Drained, not collected: stderr carries phase events only and must never block the child.
  child.stderr?.resume();
  const state: { exit: Exit | null } = { exit: null };
  const closed = new Promise<void>((resolve) => {
    // An abort can emit an error before the child and its pipes have closed.
    child.once('error', (error) => {
      state.exit ??= { error };
    });
    child.once('close', (code) => {
      state.exit ??= { code };
      resolve();
    });
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs);
  void closed.then(() => clearTimeout(timer));
  let marker: Marker | null = null;
  for (;;) {
    marker = await readMarker(input.resultPath);
    if (marker || state.exit) break;
    await delay(25);
  }
  if (!marker) {
    await closed;
    if (state.exit && 'code' in state.exit && state.exit.code === 0) return { kind: 'settled' };
    input.signal.throwIfAborted();
    throw new Error('staff_quote_native_unavailable');
  }
  const provisional = marker;
  const finished = closed.then(async () => {
    const exit = state.exit;
    if (!exit || !('code' in exit) || exit.code !== 0)
      throw new Error('staff_quote_trace_finish_failed');
    const final = JSON.parse(await readFile(`${input.resultPath}.final`, 'utf8')) as {
      evidenceDirectory?: string;
      outcome?: string;
      auditStatus?: string | null;
    };
    if (
      final.outcome !== 'quote' ||
      final.auditStatus !== 'complete' ||
      final.evidenceDirectory !== provisional.evidenceDirectory
    )
      throw new Error('staff_quote_trace_finish_incomplete');
    await input.verifyFinal(provisional.evidenceDirectory);
  });
  finished.catch(() => undefined);
  return { kind: 'provisional', evidenceDirectory: provisional.evidenceDirectory, finished };
}
