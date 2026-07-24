import { describe, expect, it, beforeEach } from 'vitest';
import {
  flushComposeBeforeLeave,
  getComposeFlush,
  registerComposeFlush,
} from '../lib/mail/compose-flush-registry';

describe('compose-flush-registry', () => {
  beforeEach(() => {
    registerComposeFlush(null);
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

  it('flushComposeBeforeLeave is no-op when empty', async () => {
    await expect(flushComposeBeforeLeave()).resolves.toBeUndefined();
  });
});
