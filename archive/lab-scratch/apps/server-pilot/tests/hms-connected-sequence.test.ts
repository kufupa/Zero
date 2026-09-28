import {
  buildConnectedSequenceSummary,
  hashConnectedMatchedIdentity,
  parseConnectedSequenceCasePaths,
  connectedSequenceIdentityPassed,
} from '../src/hms/connected-sequence.js';
import { describe, expect, it } from 'vitest';

describe('connected standalone sequence inputs', () => {
  it('accepts exactly three non-empty case paths', () => {
    expect(parseConnectedSequenceCasePaths(JSON.stringify(['a.json', 'b.json', 'a.json']))).toEqual(
      ['a.json', 'b.json', 'a.json'],
    );
    expect(parseConnectedSequenceCasePaths(undefined)).toBeNull();
  });

  it('rejects malformed or non-three-case sequences', () => {
    expect(() => parseConnectedSequenceCasePaths('{')).toThrow(/JSON array/);
    expect(() => parseConnectedSequenceCasePaths(JSON.stringify(['a.json', 'b.json']))).toThrow(
      /exactly 3/,
    );
    expect(() => parseConnectedSequenceCasePaths(JSON.stringify(['a.json', '', 'a.json']))).toThrow(
      /non-empty/,
    );
    expect(() => parseConnectedSequenceCasePaths(JSON.stringify(['a.json', 2, 'a.json']))).toThrow(
      /strings/,
    );
  });
});

describe('connected standalone sequence identity summary', () => {
  it('gates sequence success on every identity check and closed proof contexts', () => {
    const checks = {
      source: 'actual_matched_search_record' as const,
      recordIdentityChecked: true,
      aToBDifferent: true,
      aToASame: true,
    };
    const stats = { browserLaunches: 1, contextsCreated: 3, contextsClosed: 3 };
    expect(connectedSequenceIdentityPassed({ identityCheck: checks, runtimeStats: stats })).toBe(
      true,
    );
    for (const key of ['recordIdentityChecked', 'aToBDifferent', 'aToASame'] as const) {
      expect(
        connectedSequenceIdentityPassed({
          identityCheck: { ...checks, [key]: false },
          runtimeStats: stats,
        }),
      ).toBe(false);
    }
    expect(
      connectedSequenceIdentityPassed({
        identityCheck: checks,
        runtimeStats: { ...stats, contextsClosed: 2 },
      }),
    ).toBe(false);
    expect(
      connectedSequenceIdentityPassed({
        identityCheck: checks,
        runtimeStats: { ...stats, contextsCreated: 0, contextsClosed: 0 },
      }),
    ).toBe(false);
  });
  it('hashes actual detail identity, not context-bound opaque reservation refs', () => {
    const first = hashConnectedMatchedIdentity({
      match: { reservationRef: 'opaque-a', arrival: { value: '2026-09-17' } },
      detailValues: {
        confirmationnumber: 'CONF-A',
        reservationstayid: 'STAY-A',
        propertycode: 'HRCEN',
      },
    });
    const sameRecord = hashConnectedMatchedIdentity({
      match: { reservationRef: 'opaque-b', arrival: { value: '2026-09-17' } },
      detailValues: {
        confirmationnumber: ' conf-a ',
        reservationstayid: 'stay-a',
        propertycode: 'hrcen',
      },
    });
    const otherRecord = hashConnectedMatchedIdentity({
      match: { reservationRef: 'opaque-c', arrival: { value: '2026-09-18' } },
      detailValues: {
        confirmationnumber: 'CONF-B',
        reservationstayid: 'STAY-B',
        propertycode: 'HRCEN',
      },
    });

    expect(first).toBeTruthy();
    expect(sameRecord).toBe(first);
    expect(otherRecord).not.toBe(first);
  });

  it('falls back to actual nested match facts when detail values are absent', () => {
    const hash = hashConnectedMatchedIdentity({
      match: {
        reservationRef: 'opaque-only',
        referenceKind: { value: 'confirmation' },
        arrival: { data: '2026-09-17' },
        departure: { value: '2026-09-20' },
        roomType: { value: 'DLX' },
      },
    });

    expect(hash).toBeTruthy();
    expect(hashConnectedMatchedIdentity({ match: { reservationRef: 'different' } })).toBeNull();
  });

  it('checks actual matched-record hashes for A to B and A to A', () => {
    const summary = buildConnectedSequenceSummary({
      outputPath: '/tmp/sequence.json',
      runtimeStats: { browserLaunches: 1, contextsCreated: 3, contextsClosed: 3 },
      cases: [
        {
          caseId: 'case-a-1',
          outputPath: '/tmp/sequence.json.case-1.json',
          status: 'completed_with_outcomes',
          runnerStatus: 'completed',
          actualMatchedIdentitySha256: 'hash-a',
        },
        {
          caseId: 'case-b',
          outputPath: '/tmp/sequence.json.case-2.json',
          status: 'completed_with_outcomes',
          runnerStatus: 'completed',
          actualMatchedIdentitySha256: 'hash-b',
        },
        {
          caseId: 'case-a-2',
          outputPath: '/tmp/sequence.json.case-3.json',
          status: 'completed_with_outcomes',
          runnerStatus: 'completed',
          actualMatchedIdentitySha256: 'hash-a',
        },
      ],
    });

    expect(summary.identityCheck).toEqual({
      source: 'actual_matched_search_record',
      recordIdentityChecked: true,
      aToBDifferent: true,
      aToASame: true,
    });
    expect(summary.cases).toEqual([
      {
        index: 1,
        caseIdSha256: expect.any(String),
        outputPath: '/tmp/sequence.json.case-1.json',
        status: 'completed_with_outcomes',
        runnerStatus: 'completed',
        actualMatchedIdentitySha256: 'hash-a',
      },
      {
        index: 2,
        caseIdSha256: expect.any(String),
        outputPath: '/tmp/sequence.json.case-2.json',
        status: 'completed_with_outcomes',
        runnerStatus: 'completed',
        actualMatchedIdentitySha256: 'hash-b',
      },
      {
        index: 3,
        caseIdSha256: expect.any(String),
        outputPath: '/tmp/sequence.json.case-3.json',
        status: 'completed_with_outcomes',
        runnerStatus: 'completed',
        actualMatchedIdentitySha256: 'hash-a',
      },
    ]);
  });

  it('fails identity checks when matched-record hashes are missing or repeated', () => {
    const summary = buildConnectedSequenceSummary({
      outputPath: '/tmp/sequence.json',
      runtimeStats: { browserLaunches: 1, contextsCreated: 0, contextsClosed: 0 },
      cases: [
        {
          caseId: 'a',
          outputPath: 'a',
          status: 'manual_required',
          runnerStatus: 'manual_required',
          actualMatchedIdentitySha256: null,
        },
        {
          caseId: 'b',
          outputPath: 'b',
          status: 'completed',
          runnerStatus: 'completed',
          actualMatchedIdentitySha256: 'same',
        },
        {
          caseId: 'a',
          outputPath: 'c',
          status: 'completed',
          runnerStatus: 'completed',
          actualMatchedIdentitySha256: 'same',
        },
      ],
    });

    expect(summary.identityCheck).toEqual({
      source: 'actual_matched_search_record',
      recordIdentityChecked: false,
      aToBDifferent: false,
      aToASame: false,
    });
  });
});
