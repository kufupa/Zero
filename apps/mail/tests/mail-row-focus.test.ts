/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { focusThreadElement, getFocusableThreadElement } from '../lib/mail/mail-row-focus';

afterEach(() => {
  cleanup();
});

describe('mail row focus helpers', () => {
  it('resolves an inner thread row to its focusable draggable wrapper', () => {
    const wrapper = document.createElement('div');
    wrapper.tabIndex = 0;
    const thread = document.createElement('div');
    thread.dataset.threadId = 'thread-a';
    wrapper.appendChild(thread);

    expect(getFocusableThreadElement(thread)).toBe(wrapper);
  });

  it('returns a focusable thread element directly', () => {
    const thread = document.createElement('div');
    thread.tabIndex = 0;

    expect(getFocusableThreadElement(thread)).toBe(thread);
  });

  it('is null-safe for missing and detached non-focusable rows', () => {
    const thread = document.createElement('div');

    expect(getFocusableThreadElement(null)).toBeNull();
    expect(getFocusableThreadElement(thread)).toBeNull();
  });

  it('focuses the wrapper without requesting a scroll', () => {
    const wrapper = document.createElement('div');
    wrapper.tabIndex = 0;
    const thread = document.createElement('div');
    wrapper.appendChild(thread);
    document.body.appendChild(wrapper);
    const focus = vi.spyOn(wrapper, 'focus');

    expect(focusThreadElement(thread)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(wrapper);
  });
});
