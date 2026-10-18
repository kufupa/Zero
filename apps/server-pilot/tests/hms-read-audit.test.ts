import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  HmsReadActorRequiredError,
  hmsReadAuditMetrics,
} from '../src/hms/hms-read-target.js';
import { describe, expect, it } from 'vitest';

describe('hmsReadAuditMetrics', () => {
  it('staff-kicked read stamps actorUserId plus HRCEN or HRDAV slot', () => {
    expect(
      hmsReadAuditMetrics({
        actorKind: 'user',
        actorUserId: 'staff-1',
        target: CENTURION_HMS_READ_TARGET,
      }),
    ).toEqual({
      actorKind: 'user',
      actorUserId: 'staff-1',
      propertyCode: 'HRCEN',
      slotId: 'centurion',
    });
    expect(
      hmsReadAuditMetrics({
        actorKind: 'user',
        actorUserId: 'staff-1',
        target: DAVINCI_HMS_READ_TARGET,
      }),
    ).toMatchObject({ actorKind: 'user', actorUserId: 'staff-1', propertyCode: 'HRDAV', slotId: 'davinci' });
  });

  it('prefetch stamps system plus property, never a staff user id', () => {
    expect(
      hmsReadAuditMetrics({ actorKind: 'system', target: CENTURION_HMS_READ_TARGET }),
    ).toEqual({
      actorKind: 'system',
      actorUserId: null,
      propertyCode: 'HRCEN',
      slotId: 'centurion',
    });
  });

  it('H1 stamps h1 plus slot and never a staff user id', () => {
    expect(hmsReadAuditMetrics({ actorKind: 'h1', target: CENTURION_HMS_READ_TARGET })).toMatchObject({
      actorKind: 'h1',
      actorUserId: null,
      propertyCode: 'HRCEN',
    });
  });

  it('missing actor on a staff-kicked read fails closed; never unknown; never NAVAAI', () => {
    expect(() =>
      hmsReadAuditMetrics({ actorKind: 'user', target: CENTURION_HMS_READ_TARGET }),
    ).toThrow(HmsReadActorRequiredError);
    expect(() =>
      hmsReadAuditMetrics({ actorKind: 'user', actorUserId: '', target: DAVINCI_HMS_READ_TARGET }),
    ).toThrow(HmsReadActorRequiredError);
    const staff = hmsReadAuditMetrics({
      actorKind: 'user',
      actorUserId: 'staff-1',
      target: CENTURION_HMS_READ_TARGET,
    });
    expect(JSON.stringify(staff)).not.toMatch(/unknown/i);
    expect(JSON.stringify(staff)).not.toMatch(/NAVAAI/i);
  });
});

describe('H1 UI proof path', () => {
  it('does not write a slot CDP audit row claiming an attach it did not do', () => {
    const proof = readFileSync(
      fileURLToPath(new URL('../scripts/nava-quote-proof.ts', import.meta.url)),
      'utf8',
    );
    const kit = readFileSync(
      fileURLToPath(new URL('../scripts/nava-proof-kit.ts', import.meta.url)),
      'utf8',
    );
    expect(`${proof}\n${kit}`).toMatch(/chromium\.launch/);
    expect(proof).not.toMatch(/hmsReadAuditMetrics/);
    expect(proof).not.toMatch(/HMS_STAGEHAND_CDP_URL/);
    expect(kit).not.toMatch(/HMS_STAGEHAND_CDP_URL/);
  });
});
