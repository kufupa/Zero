/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { enhancedKeyboardShortcuts } from '../config/shortcuts';

describe('Ctrl + A Shortcut Configuration', () => {
  it('registers selectAll in both mail-list and thread-display scopes', () => {
    const threadDisplaySelectAll = enhancedKeyboardShortcuts.find(
      (s) => s.scope === 'thread-display' && s.action === 'selectAll',
    );
    const mailListSelectAll = enhancedKeyboardShortcuts.find(
      (s) => s.scope === 'mail-list' && s.action === 'selectAll',
    );

    expect(mailListSelectAll).toBeDefined();
    expect(mailListSelectAll?.keys).toEqual(['mod', 'a']);

    expect(threadDisplaySelectAll).toBeDefined();
    expect(threadDisplaySelectAll?.keys).toEqual(['mod', 'a']);
    expect(threadDisplaySelectAll?.preventDefault).toBe(true);
  });
});
