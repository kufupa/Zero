import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/mail/mail-content.tsx', import.meta.url),
  'utf8',
);

describe('MailContent processed-output cache identity', () => {
  it('uses a SHA-256 digest in the exact processed-output query key', () => {
    const keyStart = source.indexOf('const contentQueryKey = [');
    const keyEnd = source.indexOf('] as const;', keyStart);
    if (keyStart < 0 || keyEnd <= keyStart) {
      throw new Error('Could not locate MailContent processed-output query key');
    }
    const queryKey = source.slice(keyStart, keyEnd);

    expect(source).toContain("crypto.subtle.digest('SHA-256'");
    expect(queryKey).toContain("'email-content-v3',");
    expect(queryKey).toContain('id,');
    expect(queryKey).toContain('contentDigest,');
    expect(queryKey).toContain('shouldLoadImages,');
    expect(queryKey).toContain('processingTheme,');
    expect(queryKey).not.toContain('html');
    expect(source).toContain('queryKey: contentQueryKey');
    expect(source).not.toContain('0x811c9dc5');
    expect(source).not.toContain("const processingTheme = 'light';");
    expect(source).toContain('useTheme');
    expect(source).toContain("document.documentElement.classList.contains('dark')");
  });

  it('keeps case-insensitive paper bgcolor selectors in the neutralize stylesheet', () => {
    const css = readFileSync(
      new URL('../lib/mail/mail-paper-neutralize.ts', import.meta.url),
      'utf8',
    );
    expect(css).toContain('[bgcolor="#ffffff" i]');
    expect(css).toContain('[bgcolor="#fff" i]');
    expect(css).toContain('[bgcolor="#fffffe" i]');
    expect(css).toContain('[bgcolor="ffffff" i]');
    expect(css).toContain('[bgcolor="white" i]');
    expect(css).toContain('data-nava-mail-paper');
  });
});
