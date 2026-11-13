import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createMonitoredPostgresPropertyReadLock,
  createMonitoredPropertyReadLock,
  isPropertyReadConnectionHeld,
  isPropertyReadLockDeadline,
  propertyReadLockKey,
  type MonitoredPropertyReadConnection,
} from '../src/hms/property-read-lock.js';
import { execFileWithPropertyLease } from '../src/hms/property-lease-child.js';

function fakeSession() {
  const held = new Set<string>();
  const busy = new Set<string>();
  const listeners = new Set<(cause?: unknown) => void>();
  let pid = 41;
  let missingOnProbe = false;
  let stalledProbe = false;
  const query = vi.fn(async (statement: string) => {
    const acquire = /pg_try_advisory_lock\((-?\d+)\)/.exec(statement);
    if (acquire) {
      const key = acquire[1]!;
      if (busy.has(key)) return [{ pg_try_advisory_lock: false }];
      held.add(key);
      return [{ pg_try_advisory_lock: true }];
    }
    const unlock = /pg_advisory_unlock\((-?\d+)\)/.exec(statement);
    if (unlock) return [{ unlocked: held.delete(unlock[1]!) }];
    if (statement.includes('pg_backend_pid()')) {
      if (stalledProbe) return new Promise<never>(() => {});
      return [{ pid, held: missingOnProbe ? held.size - 1 : held.size }];
    }
    throw new Error('unexpected test query');
  });
  const close = vi.fn(async () => { held.clear(); });
  const connection: MonitoredPropertyReadConnection = {
    query: query as MonitoredPropertyReadConnection['query'],
    close,
    onLoss: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    connection, query, close, held, busy,
    lose: () => { held.clear(); for (const listener of listeners) listener(new Error('closed')); },
    replaceBackend: () => { pid += 1; },
    hideHeldKey: () => { missingOnProbe = true; },
    stallProbe: () => { stalledProbe = true; },
  };
}

function lockFor(session: ReturnType<typeof fakeSession>, propertyCode = 'HRCEN') {
  return createMonitoredPropertyReadLock({
    tenantId: 'pane', tenantIds: ['quote', 'pane', 'legacy', 'quote'], propertyCode,
    connectionFactory: async () => session.connection,
    monitorIntervalMs: 10, monitorTimeoutMs: 200,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path, 'utf8')); } catch { /* child has not started yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('child did not start');
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('child leader did not exit');
}

describe('property-wide monitored lease', () => {
  it('owns each distinct same-property identity on one session and releases them', async () => {
    const session = fakeSession();
    const lock = lockFor(session);
    const expected = ['pane', 'quote', 'legacy'].map((tenant) => propertyReadLockKey(tenant, 'HRCEN'));
    expect(lock.keys).toEqual([...expected].sort((a, b) => Number(a) - Number(b)));
    expect(lockFor(fakeSession(), 'HRDAV').keys).not.toEqual(lock.keys);
    await expect(lock.withLock(async (connection, signal) => {
      expect(signal.aborted).toBe(false);
      for (const key of lock.keys) expect(isPropertyReadConnectionHeld(connection, key)).toBe(true);
      expect(session.held.size).toBe(3);
      return 'finished';
    })).resolves.toBe('finished');
    expect(session.held.size).toBe(0);
    expect(session.close).toHaveBeenCalledOnce();
    expect(isPropertyReadConnectionHeld(session.connection, lock.key)).toBe(false);
  });

  it('does not start work if a later identity is busy, and releases the earlier key', async () => {
    const session = fakeSession();
    const lock = lockFor(session);
    session.busy.add(lock.keys[1]!);
    const callback = vi.fn(async () => 'not reached');
    const error = await lock.withLock(callback, { tryOnce: true }).catch((cause: unknown) => cause);
    expect(isPropertyReadLockDeadline(error)).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(session.held.size).toBe(0);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('refuses a borrowed active session without disturbing its owner', async () => {
    const session = fakeSession();
    const lock = lockFor(session);
    const started = deferred();
    const finish = deferred();
    const first = lock.withLock(async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    try {
      await expect(lock.withLock(async () => 'not reached')).rejects.toMatchObject({
        code: 'PROPERTY_READ_LOCK_LOST',
      });
      expect(session.close).not.toHaveBeenCalled();
      expect(isPropertyReadConnectionHeld(session.connection, lock.key)).toBe(true);
      expect(session.held.size).toBe(3);
    } finally {
      finish.resolve();
      await first;
    }
  });

  it('refuses work if the acquired session cannot prove every key', async () => {
    const session = fakeSession();
    session.hideHeldKey();
    const callback = vi.fn(async () => 'not reached');
    await expect(lockFor(session).withLock(callback)).rejects.toBeInstanceOf(Error);
    expect(callback).not.toHaveBeenCalled();
    expect(session.held.size).toBe(0);
  });

  it.each(['missing key', 'new backend', 'unresponsive session'] as const)('aborts a running lease on %s', async (failure) => {
    const session = fakeSession();
    const started = deferred();
    let observed: AbortSignal | undefined;
    const operation = lockFor(session).withLock(async (_connection, signal) => {
      observed = signal;
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await started.promise;
    if (failure === 'missing key') session.hideHeldKey();
    else if (failure === 'new backend') session.replaceBackend();
    else session.stallProbe();
    await expect(operation).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
    expect(observed?.aborted).toBe(true);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('does not finish a lost lease while its callback is still running', async () => {
    const session = fakeSession();
    const started = deferred();
    const finish = deferred();
    const operation = lockFor(session).withLock(async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    session.lose();
    expect(session.close).not.toHaveBeenCalled();
    expect(isPropertyReadConnectionHeld(session.connection, lockFor(session).key)).toBe(false);
    finish.resolve();
    await expect(operation).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('kills the owned child on session loss and waits for it to exit', async () => {
    const session = fakeSession();
    const dir = await mkdtemp(join(tmpdir(), 'property-lease-child-'));
    const marker = join(dir, 'pid');
    const script = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const operation = lockFor(session).withLock((_connection, signal) =>
      execFileWithPropertyLease(process.execPath, ['-e', script, marker], { timeout: 5_000 }, signal));
    let pid: number | undefined;
    let stopped = false;
    try {
      pid = await waitForPid(marker);
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      session.lose();
      await expect(operation).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
      stopped = true;
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(session.close).toHaveBeenCalledOnce();
    } finally {
      if (pid && !stopped) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
      await operation.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('kills the owned process group even when its leader already exited', async () => {
    const session = fakeSession();
    const dir = await mkdtemp(join(tmpdir(), 'property-lease-descendant-'));
    const marker = join(dir, 'pid');
    const script = "const {spawn}=require('node:child_process'); " +
      "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); " +
      "require('node:fs').writeFileSync(process.argv[1],String(process.pid)); c.unref()";
    const operation = lockFor(session).withLock((_connection, signal) =>
      execFileWithPropertyLease(process.execPath, ['-e', script, marker], { timeout: 5_000 }, signal));
    let pid: number | undefined;
    let stopped = false;
    try {
      pid = await waitForPid(marker);
      await waitForExit(pid);
      session.lose();
      await expect(operation).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
      stopped = true;
      expect(session.close).toHaveBeenCalledOnce();
    } finally {
      if (pid && !stopped) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
      await operation.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses missing primary identities and different property or database scopes', () => {
    const session = fakeSession();
    expect(() => createMonitoredPropertyReadLock({
      tenantId: 'pane', tenantIds: ['quote'], propertyCode: 'HRCEN',
      connectionFactory: async () => session.connection,
    })).toThrow();
    const base = { tenantId: 'pane', propertyCode: 'HRCEN', databaseUrl: 'db-a' };
    expect(() => createMonitoredPostgresPropertyReadLock({ ...base, identities: [
      { ...base }, { tenantId: 'quote', propertyCode: 'HRCEN', databaseUrl: 'db-b' },
    ] })).toThrow('property lease identity scope mismatch');
    expect(() => createMonitoredPostgresPropertyReadLock({ ...base, identities: [
      { ...base }, { tenantId: 'quote', propertyCode: 'HRDAV', databaseUrl: 'db-a' },
    ] })).toThrow('property lease identity scope mismatch');
  });
});

describe('lease child output', () => {
  it('returns bounded stdout and stderr after a successful child exits', async () => {
    const controller = new AbortController();
    await expect(execFileWithPropertyLease(process.execPath,
      ['-e', "process.stdout.write('hello'); process.stderr.write('warning')"],
      { timeout: 4_000 }, controller.signal,
    )).resolves.toEqual({ stdout: 'hello', stderr: 'warning' });
  });

  it('terminates a child that exceeds its output limit', async () => {
    const controller = new AbortController();
    await expect(execFileWithPropertyLease(process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000)"],
      { timeout: 4_000, maxBuffer: 128 }, controller.signal,
    )).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });
});
