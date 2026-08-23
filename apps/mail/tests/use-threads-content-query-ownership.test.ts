import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../hooks/use-threads.ts', import.meta.url), 'utf8');

describe('useThread content-query ownership', () => {
  it('does not start invisible content processing for the latest message', () => {
    expect(source).not.toContain('trpc.mail.processEmailContent');
    expect(source).not.toContain('email-content-v2');
  });
});
