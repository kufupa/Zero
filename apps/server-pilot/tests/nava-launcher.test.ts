import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

describe('scripts/nava launcher', () => {
  it('is valid bash, stages demo TUI, and skips Gemini unless NAVA_USE_PRIME=1', () => {
    const script = path.join(repoRoot, 'scripts', 'nava');
    const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('nava-dashboard-tui.ts');
    const tui = readFileSync(path.join(repoRoot, 'scripts', 'nava-dashboard-tui.ts'), 'utf8');
    expect(tui).toContain("from '@earendil-works/pi-tui'");
    expect(tui).toContain('nava-demo-script');
    expect(tui).toContain('NAVA_DEMO_SPEED');
    expect(tui).toContain('startAnalysis');
    expect(tui).toContain('nava-hermes-bridge');
    expect(tui).toContain('ensureNavaCorpusChat');
    expect(tui).toContain('NAVA_CORPUS_SESSION_DEFAULT');
    expect(tui).toContain("NAVA_CHAT_BACKEND === 'azure'");
    expect(tui).toContain('enterChat');
    expect(tui).toContain('tui.stop()');
    expect(tui).not.toContain('preserveAltScreen');
    expect(source).toContain('NAVA_USE_PRIME');
    expect(source).toContain(
      'exec "$PRIME" --provider google --model gemini-3.7-flash --thinking medium --theme nava',
    );
    expect(source).not.toContain('--thinking off');
    expect(source).not.toContain('--thinking minimal');
    expect(source).toContain('NAVA_SKIP_PRIME');
    expect(source).toContain('NAVA_ALLOW_DUMP=0');
    expect(source).toContain('missing or unreadable dump');
    // Default path exits after TUI unless USE_PRIME=1
    expect(source).toMatch(/NAVA_USE_PRIME:-.*!= "1"/);
  });
});
