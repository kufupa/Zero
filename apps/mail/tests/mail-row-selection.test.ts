import { describe, expect, it } from 'vitest';
import {
  getMailRowSelectionClasses,
  isMailRowActive,
  type MailRowSelectionInput,
} from '../lib/mail/mail-row-selection';

const baseInput: MailRowSelectionInput = {
  isMailSelected: false,
  isMailBulkSelected: false,
  isKeyboardFocused: false,
  isKeyboardNavigationActive: false,
};

describe('mail row selection', () => {
  it('keeps URL-selected rows active when keyboard navigation is idle', () => {
    const input = { ...baseInput, isMailSelected: true };

    expect(isMailRowActive(input)).toBe(true);
    expect(getMailRowSelectionClasses(input)).toContain('bg-primary/10');
    expect(getMailRowSelectionClasses(input)).toContain('ring-1');
    expect(getMailRowSelectionClasses(input)).toContain('ring-inset');
  });

  it('ignores the stale URL-selected row while keyboard navigation is active', () => {
    const input = {
      ...baseInput,
      isMailSelected: true,
      isKeyboardNavigationActive: true,
    };

    expect(isMailRowActive(input)).toBe(false);
    expect(getMailRowSelectionClasses(input)).toBe('');
  });

  it('gives the keyboard-focused row the stronger active treatment', () => {
    const input = {
      ...baseInput,
      isKeyboardFocused: true,
      isKeyboardNavigationActive: true,
    };

    const classes = getMailRowSelectionClasses(input);

    expect(isMailRowActive(input)).toBe(true);
    expect(classes).toContain('bg-primary/15');
    expect(classes).toContain('ring-2');
    expect(classes).toContain('ring-primary/70');
  });

  it('preserves bulk-selection styling independently of keyboard focus', () => {
    const input = {
      ...baseInput,
      isMailBulkSelected: true,
      isKeyboardNavigationActive: true,
    };

    expect(isMailRowActive(input)).toBe(true);
    expect(getMailRowSelectionClasses(input)).toContain('bg-primary/10');
    expect(getMailRowSelectionClasses(input)).toContain('ring-1');
  });

  it('returns no active classes for an unselected row', () => {
    expect(getMailRowSelectionClasses(baseInput)).toBe('');
  });
});
