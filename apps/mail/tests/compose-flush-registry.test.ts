import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  flushComposeBeforeLeave,
  flushComposeBeforeSwitch,
  registerComposeUnsavedCheck,
  registerComposePendingRecipientCheck,
  registerComposeSwitchLock,
  runComposeSwitch,
  getComposeFlush,
  registerComposeFlush,
} from '../lib/mail/compose-flush-registry';

describe('compose-flush-registry', () => {
  beforeEach(() => {
    registerComposeFlush(null);
    registerComposeUnsavedCheck(null);
    registerComposePendingRecipientCheck(null);
    registerComposeSwitchLock(null);
  });

  it('registers and returns flush fn', () => {
    const fn = async () => {};
    registerComposeFlush(fn);
    expect(getComposeFlush()).toBe(fn);
  });

  it('flushComposeBeforeLeave invokes registered fn', async () => {
    let called = false;
    registerComposeFlush(async () => {
      called = true;
    });
    await flushComposeBeforeLeave();
    expect(called).toBe(true);
  });

  it('refuses a switch when flushing throws or leaves the reply dirty', async () => {
    registerComposeFlush(async () => { throw new Error('failed'); });
    await expect(flushComposeBeforeSwitch()).resolves.toBe(false);
    registerComposeFlush(async () => {});
    registerComposeUnsavedCheck(() => true);
    await expect(flushComposeBeforeSwitch()).resolves.toBe(false);
    registerComposeUnsavedCheck(() => false);
    await expect(flushComposeBeforeSwitch()).resolves.toBe(true);
  });

  it('permits a synchronously acknowledged revision but blocks a later edit', async () => {
    let localRevision = 1;
    let savedRevision = 0;
    registerComposeUnsavedCheck(() => localRevision > savedRevision);
    registerComposeFlush(async () => { savedRevision = localRevision; });
    await expect(flushComposeBeforeSwitch()).resolves.toBe(true);
    registerComposeFlush(async () => { savedRevision = localRevision; localRevision += 1; });
    await expect(flushComposeBeforeSwitch()).resolves.toBe(false);
  });

  it('keeps the switch guard through both flush and asynchronous commit', async () => {
    let flush!: () => void;
    let commit!: () => void;
    registerComposeFlush(() => new Promise<void>((resolve) => { flush = resolve; }));
    const first = runComposeSwitch(() => new Promise<void>((resolve) => { commit = resolve; }));
    await expect(runComposeSwitch(() => { throw new Error('should not run'); })).resolves.toBe('busy');
    flush();
    await vi.waitFor(() => expect(typeof commit).toBe('function'));
    await expect(runComposeSwitch(() => { throw new Error('should not run'); })).resolves.toBe('busy');
    commit();
    await expect(first).resolves.toBe('switched');
    registerComposeFlush(null);
    await expect(runComposeSwitch(() => {})).resolves.toBe('switched');
  });

  it('holds the editor lock throughout asynchronous flush and selection', async () => {
    const lock = vi.fn(); let flush!: () => void; let finish!: () => void;
    registerComposeSwitchLock(lock);
    registerComposeFlush(() => new Promise<void>((resolve) => { flush = resolve; }));
    const pending = runComposeSwitch(() => new Promise<void>((resolve) => { finish = resolve; }));
    expect(lock.mock.calls).toEqual([[true]]);
    flush(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(lock.mock.calls).toEqual([[true]]);
    finish(); await pending;
    expect(lock.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps unfinished recipient text without attempting a save or switch', async () => {
    const save = vi.fn(); const commit = vi.fn();
    registerComposeFlush(save); registerComposePendingRecipientCheck(() => true);
    await expect(runComposeSwitch(commit)).resolves.toBe('unfinished_recipient');
    expect(save).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it('releases the switch guard after a failed commit', async () => {
    await expect(runComposeSwitch(() => { throw new Error('selection failed'); })).resolves.toBe('switch_failed');
    await expect(runComposeSwitch(() => {})).resolves.toBe('switched');
  });

  it('flushComposeBeforeLeave is no-op when empty', async () => {
    await expect(flushComposeBeforeLeave()).resolves.toBeUndefined();
  });
});
