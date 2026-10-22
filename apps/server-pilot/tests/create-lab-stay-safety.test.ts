import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { paneCommitOutcome } from '../tooling/playwright-quote/create-proof-rules.mjs';

async function createLabStaySource(): Promise<string> {
  return readFile(new URL('../tooling/playwright-quote/create-lab-stay.mjs', import.meta.url), 'utf8');
}

describe('create-lab-stay write safety', () => {
  it('checks HRCEN on every write, not only proof', async () => {
    const source = await createLabStaySource();
    expect(source).toContain("secret.expectedPropertyCode !== 'HRCEN'");
    expect(source).toContain('PROPERTY_HRCEN_REQUIRED');
    expect(source).not.toContain('proofMode && secret.expectedPropertyCode');
    expect(source).not.toContain('PROOF_PROPERTY_HRCEN_REQUIRED');
  });

  it('captures before.png and wires pane-commit to proof reconcile', async () => {
    const source = await createLabStaySource();
    expect(source).toContain("shot(page, dir, 'before.png')");
    expect(source).toContain('const verifySave = proofMode || stop.paneCommit');
    expect(source).toContain('runProofReadback');
    expect(source).toContain('paneCommitOutcome(proof)');
    expect(source).not.toContain("result.outcome = 'committed'");
  });

  it('dismisses JS dialogs so a vanished dialog does not crash, and never accepts', async () => {
    const source = await createLabStaySource();
    expect(source).toMatch(/page\.on\(['"]dialog['"]/);
    expect(source).toMatch(/dismiss\(\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
    expect(source).not.toMatch(/dialog\.accept\(/);
  });

  it('never reports committed when readback did not match', () => {
    expect(paneCommitOutcome({ readbackMatch: true })).toBe('committed');
    expect(paneCommitOutcome({ readbackMatch: false })).toBe('committed_unverified');
    expect(paneCommitOutcome({ readbackMatch: null, unknownOutcome: 'unresolved' })).toBe(
      'committed_unverified',
    );
  });
});
