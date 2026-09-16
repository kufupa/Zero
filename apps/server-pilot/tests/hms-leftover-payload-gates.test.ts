import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { READ_TOOLS, productionActiveReadToolIds } from '../src/hms/read-tools.js';

const V4 = 'a0c42868a03d22cf96734e479f9f4e4e47350b3da2873b3db5b7168f4c89af98';
const CATALOGUE = '5330a94b9383153cbc7be8a9eb37d9050f0a49050c853d7408aaf168042393d9';
const QUOTE12 = resolve(
  process.cwd(),
  '../../.private/hms-read-100-20260915/digests/quote-12-v2.json',
);

describe('leftover payload gates', () => {
  it('quote remains discovery-only until an end-to-end authority proof exists', () => {
    expect(existsSync(QUOTE12)).toBe(true);
    expect(READ_TOOLS.hms_quote_stay.evidenceRefs.liveProofDigest).toBeUndefined();
    expect(productionActiveReadToolIds()).not.toContain('hms_quote_stay');
    expect(V4).not.toBe(READ_TOOLS.hms_quote_stay.evidenceRefs.liveProofDigest);
  });

  it('find may keep v4 until own-conf reburn; quote must not share it', () => {
    expect(READ_TOOLS.hms_find_reservation.evidenceRefs.liveProofDigest).not.toBe(
      READ_TOOLS.hms_quote_stay.evidenceRefs.liveProofDigest,
    );
  });

  it('no live tool uses catalogue markdown as discoveryDigest', () => {
    for (const id of productionActiveReadToolIds()) {
      expect(READ_TOOLS[id].evidenceRefs.discoveryDigest).not.toBe(CATALOGUE);
    }
  });
});
