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

  it('polls still_processing, finds by conf#, and matches normalized fields', async () => {
    const source = await createLabStaySource();
    const start = source.indexOf('// --- create-readback-rules ---');
    const end = source.indexOf('// --- end-create-readback-rules ---');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const rules = await import(`data:text/javascript,${encodeURIComponent(source.slice(start, end))}`);
    expect(rules.saveStillProcessingDecision({
      reason: 'still_processing',
      maskVisible: true,
      confirmationNumber: '',
      elapsedMs: 0,
    })).toBe('poll');
    expect(rules.saveStillProcessingDecision({
      reason: 'still_processing',
      maskVisible: true,
      confirmationNumber: '',
      elapsedMs: 60_000,
    })).toBe('stop');
    expect(rules.readbackSearchPlan({
      confirmed: true,
      confirmationNumber: '66865808-1',
    })).toEqual({
      by: 'confirmation',
      confirmation: '66865808-1',
    });
    expect(rules.compareReadbackStay({
      firstName: 'Proof',
      lastName: 'Labtest',
      arrival: '2027-12-08',
      departure: '2027-12-09',
      roomType: 'STQN',
      adults: 1,
    }, {
      firstName: 'proof',
      lastName: 'labtest',
      arrival: '08-DEC-2027',
      departure: '2027-12-09',
      roomType: 'STQN',
      adults: 1,
    })).toEqual({ readbackMatch: true, mismatches: [], unknownOutcome: null });
    const expected = {
      firstName: 'Proof',
      lastName: 'Labtest',
      arrival: '2027-12-08',
      departure: '2027-12-09',
      roomType: 'STQN',
      adults: 1,
    };
    const otherLabtest = {
      ...expected,
      firstName: 'Ada',
      confirmation: '66865808-1',
      status: 'Reserved',
    };
    expect(rules.confirmationLookupReady(
      { outcome: 'found', stay: otherLabtest },
      '82126330-1',
    )).toBe(false);
    expect(rules.confirmationLookupReady(
      { outcome: 'not_found', stay: otherLabtest },
      '66865808-1',
    )).toBe(false);
    expect(rules.dropUnsearchedStay(
      { outcome: 'not_found', stay: otherLabtest },
      '66865808-1',
    ).stay).toBeNull();
    expect(rules.compareReadbackStay(expected, otherLabtest).readbackMatch).toBe(false);
    expect(paneCommitOutcome(rules.mergeReadbackCompare({
      confNo: '66865808-1',
      readbackMatch: true,
      mismatches: [],
      unknownOutcome: null,
    }, expected, otherLabtest))).toBe('committed_unverified');
    const alreadyMatched = {
      confNo: '66865808-1',
      readbackMatch: true as const,
      mismatches: [] as [],
      unknownOutcome: null as string | null,
    };
    for (const lastStay of [
      null,
      { ...expected, status: 'Cancelled', confirmation: '66865808-1' },
      { ...expected, status: 'Reserved', confirmation: '999-1' },
    ]) {
      const merged = rules.mergeReadbackCompare(alreadyMatched, expected, lastStay);
      expect(merged.readbackMatch).toBeNull();
      expect(merged.unknownOutcome).toBe('unresolved');
      expect(paneCommitOutcome(merged)).toBe('committed_unverified');
    }
    expect(rules.reconcileSaveInput({
      confirmed: false,
      confirmationNumber: '66865808-1',
      reason: 'still_processing',
    }).confirmed).toBe(false);
    expect(rules.readbackSearchPlan({
      confirmed: false,
      confirmationNumber: '66865808-1',
      reason: 'still_processing',
    })).toEqual({ by: 'guest' });
    expect(paneCommitOutcome({ readbackMatch: true })).toBe('committed');
    expect(source).toContain('waitWhileStillProcessing(');
    expect(source).toContain('compareReadbackStay(');
    expect(source.match(/clickTip\(page, '\^Save'/g)?.length).toBe(1);
  });
});
