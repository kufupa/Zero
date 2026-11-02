import { describe, expect, it, beforeEach } from 'vitest';
import {
  flushComposeBeforeLeave,
  flushComposeBeforeSwitch,
  registerComposeUnsavedCheck,
  getComposeFlush,
  registerComposeFlush,
} from '../lib/mail/compose-flush-registry';

describe('compose-flush-registry', () => {
  beforeEach(() => {
    registerComposeFlush(null);
    registerComposeUnsavedCheck(null);
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

  it('flushComposeBeforeLeave is no-op when empty', async () => {
    await expect(flushComposeBeforeLeave()).resolves.toBeUndefined();
  });
});
