import { describe, expect, it } from 'vitest';
import {
  createStaffQuoteReadBackMachine,
  staffQuoteReadBackKey,
} from '../components/nava-pane/staff-quote-read-back';

const STAY_A = '2026-11-03:2026-11-05';
const STAY_B = '2026-11-05:2026-11-07';

function key(over: Partial<Parameters<typeof staffQuoteReadBackKey>[0]> = {}) {
  return staffQuoteReadBackKey({
    transportId: 'transport-1',
    messageId: 'mail-1',
    sourceHash: 'ab'.repeat(32),
    selectionEpoch: 1,
    inputRevision: 1,
    stayRevision: 1,
    stayKey: STAY_A,
    ...over,
  });
}

describe('staffQuoteReadBackKey', () => {
  it('joins identity parts with a middle dot', () => {
    expect(key()).toBe(`transport-1·mail-1·${'ab'.repeat(32)}·1·1·1·${STAY_A}`);
  });

  it('changes when any identity part changes', () => {
    expect(key({ messageId: 'mail-2' })).not.toBe(key());
    expect(key({ inputRevision: 2 })).not.toBe(key());
    expect(key({ stayRevision: 2 })).not.toBe(key());
    expect(key({ stayKey: STAY_B })).not.toBe(key());
  });
});

describe('staff quote read-back state machine', () => {
  it('starts idle: not busy, not done', () => {
    const machine = createStaffQuoteReadBackMachine();
    expect(machine.snapshot()).toEqual({ key: '', token: 0, status: 'idle' });
    expect(machine.busy(key())).toBe(false);
    expect(machine.done(key())).toBe(false);
  });

  it('begin bumps the token and marks probing', () => {
    const machine = createStaffQuoteReadBackMachine();
    const first = machine.begin(key());
    expect(first.started).toBe(true);
    expect(first.token).toBe(1);
    expect(machine.snapshot()).toEqual({ key: key(), token: 1, status: 'probing' });
    expect(machine.busy(key())).toBe(true);
    expect(machine.done(key())).toBe(false);
  });

  it('probes each key once: a second begin on the same key is a no-op', () => {
    const machine = createStaffQuoteReadBackMachine();
    const first = machine.begin(key());
    const second = machine.begin(key());
    expect(second.started).toBe(false);
    expect(second.token).toBe(first.token);
    expect(machine.snapshot().status).toBe('probing');
  });

  it('does not probe a key that is already done', () => {
    const machine = createStaffQuoteReadBackMachine();
    const first = machine.begin(key());
    expect(machine.markDone(first.token, key())).toBe(true);
    expect(machine.done(key())).toBe(true);
    expect(machine.busy(key())).toBe(false);
    const again = machine.begin(key());
    expect(again.started).toBe(false);
    expect(machine.snapshot().status).toBe('done');
  });

  it('markRunning and markDone drop on token mismatch', () => {
    const machine = createStaffQuoteReadBackMachine();
    const first = machine.begin(key());
    expect(machine.live(first.token, key())).toBe(true);
    expect(machine.markRunning(first.token + 1, key())).toBe(false);
    expect(machine.snapshot().status).toBe('probing');
    expect(machine.markDone(0, key())).toBe(false);
    expect(machine.done(key())).toBe(false);
  });

  it('stale key after a switch drops in-flight work', () => {
    const machine = createStaffQuoteReadBackMachine();
    const first = machine.begin(key());
    const next = key({ messageId: 'mail-2' });
    machine.forgetStale([next]);
    expect(machine.live(first.token, key())).toBe(false);
    expect(machine.busy(key())).toBe(false);
    expect(machine.busy(next)).toBe(false);
    expect(machine.markDone(first.token, key())).toBe(false);
    expect(machine.done(key())).toBe(false);
  });

  it('key change clears done so the new identity can probe', () => {
    const machine = createStaffQuoteReadBackMachine();
    const firstKey = key();
    const first = machine.begin(firstKey);
    machine.markDone(first.token, firstKey);
    expect(machine.done(firstKey)).toBe(true);

    const nextKey = key({ inputRevision: 2 });
    machine.forgetStale([nextKey]);
    expect(machine.done(firstKey)).toBe(false);
    expect(machine.done(nextKey)).toBe(false);
    const started = machine.begin(nextKey);
    expect(started.started).toBe(true);
    expect(machine.busy(nextKey)).toBe(true);
  });

  it('tracks two stay keys independently', () => {
    const machine = createStaffQuoteReadBackMachine();
    const a = key({ stayKey: STAY_A });
    const b = key({ stayKey: STAY_B });
    const firstA = machine.begin(a);
    expect(machine.busy(a)).toBe(true);
    expect(machine.busy(b)).toBe(false);
    machine.markDone(firstA.token, a);
    const firstB = machine.begin(b);
    expect(machine.done(a)).toBe(true);
    expect(machine.busy(b)).toBe(true);
    machine.markDone(firstB.token, b);
    expect(machine.done(b)).toBe(true);
    expect(machine.begin(a).started).toBe(false);
    expect(machine.begin(b).started).toBe(false);
  });

  it('rememberDone marks a key finished without probing', () => {
    const machine = createStaffQuoteReadBackMachine();
    machine.rememberDone(key());
    expect(machine.done(key())).toBe(true);
    expect(machine.busy(key())).toBe(false);
    expect(machine.begin(key()).started).toBe(false);
  });
});
