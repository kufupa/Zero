import {
  awaitPendingStaffQuote,
  quoteTraceAsyncEnabled,
  registerPendingStaffQuote,
  runProvisionalQuoteChild,
} from '../src/ai/staff-quote-trace-async.js';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stand-in for the capture child: writes the marker, works for a while, then writes its final file.
function provisionalChild({
  finalAudit = 'complete',
  exitCode = 0,
  workMs = 300,
}: { finalAudit?: string; exitCode?: number; workMs?: number } = {}): string {
  return `
    const fs = require('node:fs');
    const [resultPath, evidence] = process.argv.slice(1);
    fs.writeFileSync(resultPath, JSON.stringify({ evidenceDirectory: evidence, traceFinish: 'pending' }), { mode: 0o600, flag: 'wx' });
    setTimeout(() => {
      fs.writeFileSync(resultPath + '.final', JSON.stringify({ evidenceDirectory: evidence, outcome: 'quote', auditStatus: ${JSON.stringify(finalAudit)} }), { mode: 0o600, flag: 'wx' });
      process.exit(${exitCode});
    }, ${workMs});
  `;
}

const noVerify = async () => undefined;

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('child did not write the expected marker');
}

async function childExited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await delay(20);
  }
  return false;
}

async function run(
  script: string,
  options: {
    previousFinish?: Promise<void>;
    timeoutMs?: number;
    signal?: AbortSignal;
    verifyFinal?: (dir: string) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'trace-async-'));
  const resultPath = join(dir, 'dispatch.json');
  const evidence = join(dir, 'run-1');
  const promise = runProvisionalQuoteChild({
    executable: process.execPath,
    args: ['-e', script, resultPath, evidence],
    env: process.env,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 20_000,
    resultPath,
    previousFinish: options.previousFinish ?? Promise.resolve(),
    verifyFinal: options.verifyFinal ?? noVerify,
  });
  return { dir, resultPath, evidence, promise };
}

describe('provisional staff quote capture', () => {
  it('is enabled only by the exact value on', () => {
    expect(quoteTraceAsyncEnabled({ QUOTE_TRACE_ASYNC: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    for (const value of [undefined, '', '1', 'true', 'ON', 'on ', 'off'])
      expect(quoteTraceAsyncEnabled({ QUOTE_TRACE_ASYNC: value } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('returns at the marker while the trace is still finishing, and settles only after the child exits', async () => {
    const run1 = await run(provisionalChild({ workMs: 400 }));
    try {
      const outcome = await run1.promise;
      if (outcome.kind !== 'provisional') throw new Error('expected a provisional capture');
      expect(outcome.evidenceDirectory).toBe(run1.evidence);
      let settled = false;
      outcome.finished.then(
        () => (settled = true),
        () => (settled = true),
      );
      await delay(20);
      expect(settled).toBe(false);
      await expect(outcome.finished).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('fails the finish, not the capture, when the child exits non-zero after the marker', async () => {
    const run1 = await run(provisionalChild({ exitCode: 1, workMs: 50 }));
    try {
      const outcome = await run1.promise;
      if (outcome.kind !== 'provisional') throw new Error('expected a provisional capture');
      await expect(outcome.finished).rejects.toThrow('staff_quote_trace_finish_failed');
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('refuses a final file whose audit is not complete', async () => {
    const run1 = await run(provisionalChild({ finalAudit: 'incomplete', workMs: 50 }));
    try {
      const outcome = await run1.promise;
      if (outcome.kind !== 'provisional') throw new Error('expected a provisional capture');
      await expect(outcome.finished).rejects.toThrow('staff_quote_trace_finish_incomplete');
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('refuses a final capture that the verifier rejects', async () => {
    const run1 = await run(provisionalChild({ workMs: 50 }), {
      verifyFinal: async () => {
        throw new Error('staff_quote_trace_finish_changed');
      },
    });
    try {
      const outcome = await run1.promise;
      if (outcome.kind !== 'provisional') throw new Error('expected a provisional capture');
      await expect(outcome.finished).rejects.toThrow('staff_quote_trace_finish_changed');
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('keeps the sequential shape when the child exits cleanly without a marker', async () => {
    const run1 = await run(
      `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ evidenceDirectory: process.argv[2] }), { mode: 0o600, flag: 'wx' });`,
    );
    try {
      await expect(run1.promise).resolves.toEqual({ kind: 'settled' });
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('fails the capture when the child exits non-zero before any marker', async () => {
    const run1 = await run('process.exit(2)');
    try {
      await expect(run1.promise).rejects.toThrow('staff_quote_native_unavailable');
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('kills a child that never reaches a marker at the dispatch timeout', async () => {
    const run1 = await run('setTimeout(() => {}, 60000)', { timeoutMs: 300 });
    try {
      await expect(run1.promise).rejects.toThrow('staff_quote_native_unavailable');
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not start a second capture until the previous trace has finished', async () => {
    let release!: () => void;
    const previousFinish = new Promise<void>((resolve) => (release = resolve));
    const marks = await mkdtemp(join(tmpdir(), 'trace-async-order-'));
    const started = join(marks, 'started.txt');
    const second = await run(
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'x'); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ evidenceDirectory: process.argv[2], traceFinish: 'pending' }), { mode: 0o600, flag: 'wx' }); setTimeout(() => { require('node:fs').writeFileSync(process.argv[1] + '.final', JSON.stringify({ evidenceDirectory: process.argv[2], outcome: 'quote', auditStatus: 'complete' }), { mode: 0o600, flag: 'wx' }); process.exit(0); }, 20);`,
      { previousFinish },
    );
    try {
      await delay(250);
      await expect(readFile(started, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      release();
      const outcome = await second.promise;
      expect(outcome.kind).toBe('provisional');
      await expect(readFile(started, 'utf8')).resolves.toBe('x');
    } finally {
      await rm(second.dir, { recursive: true, force: true });
      await rm(marks, { recursive: true, force: true });
    }
  });

  it('a failed previous finish stops the next capture from starting', async () => {
    const previousFinish = Promise.reject(new Error('staff_quote_trace_finish_failed'));
    previousFinish.catch(() => undefined);
    const run1 = await run(provisionalChild({ workMs: 10 }), { previousFinish });
    try {
      await expect(run1.promise).rejects.toThrow('staff_quote_trace_finish_failed');
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  });

  it('an aborted request kills the child and surfaces the abort', async () => {
    const controller = new AbortController();
    const run1 = await run('setTimeout(() => {}, 60000)', { signal: controller.signal });
    try {
      setTimeout(() => controller.abort(new Error('caller_gone')), 100);
      await expect(run1.promise).rejects.toThrow();
    } finally {
      await rm(run1.dir, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(['before', 'after'] as const)(
    'waits for child close after abort %s a provisional capture',
    async (stage) => {
      const controller = new AbortController();
      const script = `
        const fs = require('node:fs');
        const [result, evidence] = process.argv.slice(1);
        process.on('SIGTERM', () => fs.writeFileSync(result + '.term', 'received'));
        fs.writeFileSync(result + '.pid', String(process.pid));
        if (${JSON.stringify(stage)} === 'after') {
          fs.writeFileSync(result, JSON.stringify({ evidenceDirectory: evidence, traceFinish: 'pending' }));
        }
        setInterval(() => { if (fs.existsSync(result + '.release')) process.exit(0); }, 20);
      `;
      const run1 = await run(script, { signal: controller.signal, timeoutMs: 8_000 });
      // Attach a handler immediately: an abort before the capture rejects this promise.
      void run1.promise.catch(() => undefined);
      let pid: number | undefined;
      try {
        pid = Number(await waitForFile(`${run1.resultPath}.pid`));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        let completion: Promise<'resolved' | 'rejected'>;
        if (stage === 'after') {
          const outcome = await run1.promise;
          if (outcome.kind !== 'provisional') throw new Error('expected a provisional capture');
          completion = outcome.finished.then(() => 'resolved' as const, () => 'rejected' as const);
        } else {
          completion = run1.promise.then(() => 'resolved' as const, () => 'rejected' as const);
        }
        controller.abort(new Error('caller_gone'));
        await waitForFile(`${run1.resultPath}.term`);
        expect(await Promise.race([completion, delay(250).then(() => 'pending')])).toBe('pending');
        await writeFile(`${run1.resultPath}.release`, 'release');
        expect(await completion).toBe('rejected');
        expect(await childExited(pid, 1_000)).toBe(true);
      } finally {
        await writeFile(`${run1.resultPath}.release`, 'release').catch(() => undefined);
        if (pid && !(await childExited(pid, 3_000))) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* This owned child may already have exited. */ }
          await childExited(pid, 1_000);
        }
        await run1.promise.catch(() => undefined);
        await rm(run1.dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(['before', 'after'] as const)(
    'forces a child that ignores abort to exit %s a provisional capture',
    async (stage) => {
      const controller = new AbortController();
      const script = `
        const fs = require('node:fs');
        const [result, evidence] = process.argv.slice(1);
        process.on('SIGTERM', () => fs.writeFileSync(result + '.term', 'received'));
        fs.writeFileSync(result + '.pid', String(process.pid));
        if (${JSON.stringify(stage)} === 'after') {
          fs.writeFileSync(result, JSON.stringify({ evidenceDirectory: evidence, traceFinish: 'pending' }));
        }
        setInterval(() => {}, 20);
      `;
      const run1 = await run(script, { signal: controller.signal, timeoutMs: 3_000 });
      void run1.promise.catch(() => undefined);
      let pid: number | undefined;
      let completion: Promise<unknown> | undefined;
      try {
        pid = Number(await waitForFile(`${run1.resultPath}.pid`));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        if (stage === 'after') {
          const outcome = await run1.promise;
          if (outcome.kind !== 'provisional') throw new Error('expected a provisional capture');
          completion = outcome.finished;
        } else {
          completion = run1.promise;
        }
        controller.abort(new Error('caller_gone'));
        await waitForFile(`${run1.resultPath}.term`);
        const settled = completion.then(() => 'resolved', () => 'rejected');
        expect(await Promise.race([settled, delay(7_000).then(() => 'timed out')])).toBe('rejected');
        expect(await childExited(pid, 1_000)).toBe(true);
      } finally {
        if (pid && !(await childExited(pid, 1_000))) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* This owned child may already have exited. */ }
          await childExited(pid, 1_000);
        }
        await completion?.catch(() => undefined);
        await run1.promise.catch(() => undefined);
        await rm(run1.dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it('waits for inherited stderr to close after the direct child exits', async () => {
    const descendant = `
      const fs = require('node:fs');
      const release = process.argv[1];
      setInterval(() => { if (fs.existsSync(release)) process.exit(0); }, 20);
    `;
    const script = `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const [result] = process.argv.slice(1);
      fs.writeFileSync(result + '.pid', String(process.pid));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, result + '.release'],
        { stdio: ['ignore', 'ignore', 2] });
      fs.writeFileSync(result + '.descendant', String(child.pid));
      child.unref();
      process.exit(0);
    `;
    const run1 = await run(script, { timeoutMs: 8_000 });
    let descendantPid: number | undefined;
    try {
      const pid = Number(await waitForFile(`${run1.resultPath}.pid`));
      descendantPid = Number(await waitForFile(`${run1.resultPath}.descendant`));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(await childExited(pid, 3_000)).toBe(true);
      expect(await Promise.race([run1.promise.then(() => 'settled'), delay(250).then(() => 'pending')])).toBe('pending');
      await writeFile(`${run1.resultPath}.release`, 'release');
      await expect(run1.promise).resolves.toEqual({ kind: 'settled' });
    } finally {
      await writeFile(`${run1.resultPath}.release`, 'release').catch(() => undefined);
      if (descendantPid && !(await childExited(descendantPid, 1_000))) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* This owned child may already have exited. */ }
      }
      await run1.promise.catch(() => undefined);
      await rm(run1.dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('pending staff quote finishes', () => {
  it('makes every id for a provisional run wait for its finish', async () => {
    let finish!: () => void;
    registerPendingStaffQuote(
      ['workflow-run-a', 'capture-run-a'],
      new Promise<void>((resolve) => (finish = resolve)),
    );
    let done = false;
    const waiter = awaitPendingStaffQuote('capture-run-a').then(() => (done = true));
    await delay(20);
    expect(done).toBe(false);
    finish();
    await waiter;
    expect(done).toBe(true);
  });

  it('releases waiters when a finish fails, so the database decides what is available', async () => {
    registerPendingStaffQuote(
      ['failed-run'],
      Promise.reject(new Error('staff_quote_trace_finish_failed')),
    );
    await expect(awaitPendingStaffQuote('failed-run')).resolves.toBeUndefined();
  });

  it('never waits for an unknown id', async () => {
    await expect(awaitPendingStaffQuote('no-such-run')).resolves.toBeUndefined();
    await expect(awaitPendingStaffQuote(undefined)).resolves.toBeUndefined();
  });
});
