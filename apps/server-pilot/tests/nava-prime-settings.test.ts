import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

describe('prime project settings', () => {
  it('disables retry and pins google gemini-3.7-flash', () => {
    const raw = readFileSync(
      path.join(repoRoot, '.prime', 'agent', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(raw) as {
      quietStartup: boolean;
      theme: string;
      defaultProvider: string;
      defaultModel: string;
      defaultThinkingLevel: string;
      retry: { enabled: boolean; maxRetries: number };
      telemetry: { enabled: boolean };
      bundledSkills: { websearch: boolean };
    };
    expect(settings.quietStartup).toBe(true);
    expect(settings.theme).toBe('nava');
    expect(settings.defaultProvider).toBe('google');
    expect(settings.defaultModel).toBe('gemini-3.7-flash');
    expect(settings.defaultThinkingLevel).toBe('medium');
    expect(settings.defaultThinkingLevel).not.toBe('off');
    expect(settings.defaultThinkingLevel).not.toBe('minimal');
    expect(settings.retry.enabled).toBe(false);
    expect(settings.retry.maxRetries).toBe(0);
    expect(settings.telemetry.enabled).toBe(false);
    expect(settings.bundledSkills.websearch).toBe(false);

    const theme = JSON.parse(
      readFileSync(path.join(repoRoot, '.prime', 'agent', 'themes', 'nava.json'), 'utf8'),
    ) as { name: string; vars: { nava: string } };
    expect(theme.name).toBe('nava');
    expect(theme.vars.nava).toBe('#2F6BFF');
  });
});
