import { describe, expect, it } from 'vitest';
import { isVisibleUserLabel, resolveThreadLabels } from '../hooks/use-labels';

describe('use-labels SPAM filter', () => {
  it('treats SPAM label name as hidden case-insensitively', () => {
    expect(isVisibleUserLabel({ name: 'SPAM' })).toBe(false);
    expect(isVisibleUserLabel({ name: 'spam' })).toBe(false);
    expect(isVisibleUserLabel({ name: 'Spam' })).toBe(false);
    expect(isVisibleUserLabel({ name: 'Work' })).toBe(true);
  });

  it('filters SPAM out of thread label chips while keeping other labels', () => {
    const labels = [
      { id: 'label-spam', name: 'SPAM', type: 'user' as const },
      { id: 'label-work', name: 'Work', type: 'user' as const },
    ];

    expect(resolveThreadLabels(labels, ['label-spam', 'label-work'])).toEqual([
      { id: 'label-work', name: 'Work', type: 'user' },
    ]);
  });

  it('returns empty when only SPAM ids are present on the thread', () => {
    const labels = [{ id: 'label-spam', name: 'SPAM', type: 'user' as const }];

    expect(resolveThreadLabels(labels, ['label-spam'])).toEqual([]);
  });
});
