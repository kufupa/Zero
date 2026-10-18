import { createSlotSession, SlotSessionClosedError } from '../src/hms/slot-session.js';
import { describe, expect, it } from 'vitest';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('createSlotSession', () => {
  it('starts down, recover success → ready', async () => {
    const owner = {
      login: async () => {},
      wipeProfile: async () => {
        throw new Error('wipe must not run on recover');
      },
    };
    const session = createSlotSession({ owner });
    expect(session.phase).toBe('down');
    await session.recover();
    expect(session.phase).toBe('ready');
  });

  it('recover failure → down, never fake ready', async () => {
    const owner = {
      login: async () => {
        throw new Error('NAVAAI login failed');
      },
      wipeProfile: async () => {},
    };
    const session = createSlotSession({ owner });
    await expect(session.recover()).rejects.toThrow(/login failed/);
    expect(session.phase).toBe('down');
  });

  it('reset from ready wipes the profile then recovers to ready', async () => {
    const seen: string[] = [];
    const owner = {
      login: async () => {
        seen.push('login');
      },
      wipeProfile: async () => {
        seen.push('wipe');
      },
    };
    const session = createSlotSession({ owner });
    await session.recover();
    expect(session.phase).toBe('ready');
    await session.reset();
    expect(session.phase).toBe('ready');
    expect(seen).toEqual(['login', 'wipe', 'login']);
  });

  it('recover during an in-flight read fails the read closed with no success payload', async () => {
    const hold = deferred();
    const entered = deferred();
    const owner = {
      login: async () => {},
      wipeProfile: async () => {},
    };
    const session = createSlotSession({ owner });
    await session.recover();

    const read = session.withRead(async () => {
      entered.resolve();
      await hold.promise;
      return { payload: 'stale-quote' };
    });
    await entered.promise;
    await session.recover();
    hold.resolve();
    await expect(read).rejects.toBeInstanceOf(SlotSessionClosedError);
    await expect(read).rejects.toMatchObject({ payload: undefined });
    expect(session.phase).toBe('ready');
  });
});
