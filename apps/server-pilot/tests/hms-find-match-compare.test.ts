import { describe, expect, it } from 'vitest';
import {
  compareHmsFindMatch,
  oracleFromOsressGridRow,
} from '../src/ops/hms-find-match-compare.js';

describe('hms-find-match-compare', () => {
  it('oracle composes name when primaryguest is sentinel', () => {
    const oracle = oracleFromOsressGridRow({
      confirmationnumber: '58995484-1',
      primaryguest: '-1',
      lastname: 'Example',
      firstname: 'Guest',
      arrivaldate: '2026-08-26',
      departuredate: '2026-08-27',
      status: 'Checked Out',
    });
    expect(oracle.guestName).toBe('Example, Guest');
    expect(oracle.ratePlan).toBeNull();
  });

  it('compare fails on sentinel guestName and ratePlan claims', () => {
    const oracle = oracleFromOsressGridRow({
      confirmationnumber: '58995484-1',
      lastname: 'Example',
      firstname: 'Guest',
      arrivaldate: '2026-08-26',
      departuredate: '2026-08-27',
      status: 'Checked Out',
    });
    const bad = compareHmsFindMatch(oracle, {
      ...oracle,
      guestName: '-1',
      label: '-1',
      ratePlan: null,
      claimKeys: ['matches.0.guestName', 'matches.0.ratePlan'],
      unresolvedFields: [],
    });
    expect(bad.allRequiredPass).toBe(false);
    expect(bad.rows.find((r) => r.field === 'guestName.notSentinel')?.pass).toBe(false);
    expect(bad.rows.find((r) => r.field === 'label.notSentinel')?.pass).toBe(false);
    expect(bad.rows.find((r) => r.field === 'claimKeys.ratePlan')?.pass).toBe(false);

    const good = compareHmsFindMatch(oracle, {
      ...oracle,
      label: oracle.guestName,
      ratePlan: null,
      claimKeys: ['matches.0.confirmationNumber', 'matches.0.guestName'],
      unresolvedFields: ['roomType'],
    });
    expect(good.allRequiredPass).toBe(true);
    expect(good.rows.find((r) => r.field === 'label')?.pass).toBe(true);
  });

  it('compare fails when required Match fields sit in unresolvedFields', () => {
    const oracle = oracleFromOsressGridRow({
      confirmationnumber: '58995484-1',
      lastname: 'Example',
      firstname: 'Guest',
      arrivaldate: '2026-08-26',
      departuredate: '2026-08-27',
      status: 'Checked Out',
    });
    const bad = compareHmsFindMatch(oracle, {
      ...oracle,
      label: oracle.guestName,
      ratePlan: null,
      claimKeys: ['matches.0.confirmationNumber'],
      unresolvedFields: ['arrivalDate', 'guestName'],
    });
    expect(bad.allRequiredPass).toBe(false);
    expect(bad.rows.find((r) => r.field === 'unresolvedFields.required')?.pass).toBe(false);
  });
});
