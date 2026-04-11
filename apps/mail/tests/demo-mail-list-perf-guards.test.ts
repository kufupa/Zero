import { describe, expect, it } from 'vitest';
import { MailList, areMailLabelsEqual } from '../components/mail/mail-list';

type MemoExoticComponent = typeof MailList & {
  compare: null | ((prev: unknown, next: unknown) => boolean);
};

describe('demo mail list perf guards', () => {
  it('does not force MailList memo to always skip parent updates', () => {
    expect((MailList as MemoExoticComponent).compare).toBeNull();
  });

  it('compares MailLabels arrays deterministically by id and name pairs', () => {
    const prev = [
      { id: 'a', name: 'STARRED' },
      { id: 'b', name: 'important' },
    ];
    const next = [
      { id: 'a', name: 'STARRED' },
      { id: 'b', name: 'important' },
    ];

    expect(areMailLabelsEqual(prev, next)).toBe(true);
  });

  it('detects added labels in MailLabels memo comparison', () => {
    expect(
      areMailLabelsEqual(
        [{ id: 'a', name: 'STARRED' }],
        [
          { id: 'a', name: 'STARRED' },
          { id: 'b', name: 'important' },
        ],
      ),
    ).toBe(false);
  });

  it('detects label name/id changes in MailLabels memo comparison', () => {
    expect(
      areMailLabelsEqual(
        [{ id: 'a', name: 'STARRED' }],
        [{ id: 'a', name: 'INBOX' }],
      ),
    ).toBe(false);
  });

  it('detects label order changes in MailLabels memo comparison', () => {
    expect(
      areMailLabelsEqual(
        [
          { id: 'a', name: 'STARRED' },
          { id: 'b', name: 'important' },
        ],
        [
          { id: 'b', name: 'important' },
          { id: 'a', name: 'STARRED' },
        ],
      ),
    ).toBe(false);
  });

  it('treats missing MailLabels arrays as stable empty lists', () => {
    expect(areMailLabelsEqual(undefined, undefined)).toBe(true);
    expect(areMailLabelsEqual(null, undefined)).toBe(true);
    expect(areMailLabelsEqual([], null)).toBe(true);
    expect(areMailLabelsEqual([{ id: 'a', name: 'STARRED' }], null)).toBe(false);
  });
});
