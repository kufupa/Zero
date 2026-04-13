import { describe, expect, it } from 'vitest';
import { plainTextDraftPreview } from '../lib/mail/draft-preview';

describe('plainTextDraftPreview', () => {
  it('strips tags and decodes common entities', () => {
    const input = '<p>Hi&nbsp;<b>all</b></p><script>x</script>';
    expect(plainTextDraftPreview(input)).toBe('Hi all');
  });

  it('collapses whitespace', () => {
    expect(plainTextDraftPreview('  a\n\tb  ')).toBe('a b');
  });

  it('returns empty string for empty input', () => {
    expect(plainTextDraftPreview('')).toBe('');
  });
});
