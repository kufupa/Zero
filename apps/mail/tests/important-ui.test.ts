import { describe, expect, it } from 'vitest';
import { hasImportantTag, resolveImportantState } from '../lib/mail/important-ui';

describe('important-ui helpers', () => {
  it('detects IMPORTANT tags case-insensitively', () => {
    expect(hasImportantTag([{ name: 'IMPORTANT' }])).toBe(true);
    expect(hasImportantTag([{ name: 'important' }])).toBe(true);
  });

  it('detects category_important tags after normalization', () => {
    expect(hasImportantTag([{ name: 'CATEGORY_IMPORTANT' }])).toBe(true);
    expect(hasImportantTag([{ name: ' category_important ' }])).toBe(true);
  });

  it('uses optimistic value when present', () => {
    expect(
      resolveImportantState({
        optimisticImportant: true,
        latestTags: [],
      }),
    ).toBe(true);

    expect(
      resolveImportantState({
        optimisticImportant: false,
        latestTags: [{ name: 'IMPORTANT' }],
      }),
    ).toBe(false);
  });

  it('falls back to latest message tags when no optimistic state exists', () => {
    expect(
      resolveImportantState({
        optimisticImportant: null,
        latestTags: [{ name: 'IMPORTANT' }],
      }),
    ).toBe(true);
  });

  it('falls back to all message tags when latest tags are missing', () => {
    expect(
      resolveImportantState({
        optimisticImportant: null,
        latestTags: [],
        messages: [{ tags: [{ name: 'foo' }] }, { tags: [{ name: 'IMPORTANT' }] }],
      }),
    ).toBe(true);
  });

  it('returns false when optimistic state and tags are not important', () => {
    expect(
      resolveImportantState({
        optimisticImportant: null,
        latestTags: [{ name: 'STARRED' }],
        messages: [{ tags: [{ name: 'INBOX' }] }],
      }),
    ).toBe(false);
  });
});
