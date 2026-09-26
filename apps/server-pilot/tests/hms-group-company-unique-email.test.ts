import { describe, expect, it } from 'vitest';
import {
  surfaceOnlyProbesPass,
  uniqueEmailSoftPass,
} from '../src/hms/group-company-unique-email-gate.js';

describe('group-company unique-email gate', () => {
  it('rejects 4 surface probes without email ids', () => {
    expect(surfaceOnlyProbesPass(4, 0)).toBe(false);
    expect(uniqueEmailSoftPass([], 10).pass).toBe(false);
  });

  it('passes when 10 distinct emails have lstHit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      emailId: `e${i}`,
      code: `G${i}`,
      lstHit: true,
    }));
    expect(uniqueEmailSoftPass(rows, 10)).toEqual({ uniqueOk: 10, pass: true });
    expect(surfaceOnlyProbesPass(4, 10)).toBe(true);
  });

  it('rejects hardcoded org unused by email (no code)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      emailId: `e${i}`,
      code: '',
      lstHit: true,
    }));
    expect(uniqueEmailSoftPass(rows, 10).pass).toBe(false);
  });
});
