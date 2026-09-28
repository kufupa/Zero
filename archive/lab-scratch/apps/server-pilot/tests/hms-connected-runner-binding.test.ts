import { describe, expect, it } from 'vitest';
import {
  bindConnectedRunnerParent,
  connectedRunnerParentEvidenceId,
  isConnectedRunnerParentBound,
} from '../src/hms/connected-runner-binding.js';

const RESERVATION_REF = 'resref-current';
const PARENT_EVIDENCE_ID = '00000000-0000-4000-8000-000000000001';

const detailDump = {
  schemaVersion: 1 as const,
  surface: 'guest_stay_detail' as const,
  keys: ['confirmationnumber', 'reservationstayid'],
  values: {
    confirmationnumber: 'CONF-current',
    reservationstayid: 'STAY-current',
  },
};

function successfulDetail(scopeRef = RESERVATION_REF) {
  return {
    status: 'ok',
    completeness: 'complete',
    scopeRef,
  };
}

function bound() {
  return bindConnectedRunnerParent({
    reservationRef: RESERVATION_REF,
    detailResult: successfulDetail(),
    detailDump,
    reservationStayId: 'STAY-current',
    parentEvidenceId: PARENT_EVIDENCE_ID,
  });
}

describe('connected runner parent binding', () => {
  it('clears a previously bound parent when the next find has no match', () => {
    expect(isConnectedRunnerParentBound(bound(), RESERVATION_REF)).toBe(true);

    const cleared = bindConnectedRunnerParent({
      reservationRef: null,
      detailResult: null,
      detailDump: null,
      reservationStayId: null,
      parentEvidenceId: null,
    });

    expect(isConnectedRunnerParentBound(cleared, RESERVATION_REF)).toBe(false);
    expect(cleared.reservationRef).toBeNull();
    expect(cleared.detailDump).toBeNull();
  });

  it('clears a previously bound parent when detail fails or is not scope-bound', () => {
    expect(isConnectedRunnerParentBound(bound(), RESERVATION_REF)).toBe(true);

    const cleared = bindConnectedRunnerParent({
      reservationRef: RESERVATION_REF,
      detailResult: { status: 'manual_required', completeness: 'unknown', scopeRef: RESERVATION_REF },
      detailDump,
      reservationStayId: 'STAY-current',
      parentEvidenceId: PARENT_EVIDENCE_ID,
    });
    const wrongScope = bindConnectedRunnerParent({
      reservationRef: RESERVATION_REF,
      detailResult: successfulDetail('resref-other'),
      detailDump,
      reservationStayId: 'STAY-current',
      parentEvidenceId: PARENT_EVIDENCE_ID,
    });

    expect(isConnectedRunnerParentBound(cleared, RESERVATION_REF)).toBe(false);
    expect(isConnectedRunnerParentBound(wrongScope, RESERVATION_REF)).toBe(false);
    expect(cleared.reservationRef).toBeNull();
    expect(wrongScope.reservationRef).toBeNull();
  });

  it('reuses a scope-verified detail evidence reference for child binding', () => {
    expect(
      connectedRunnerParentEvidenceId({
        ...successfulDetail(),
        evidence: [
          {
            evidenceRef: 'hms-read-detail:evidence-1',
            artifactRef: 'artifact:detail-1',
            scopeVerified: true,
          },
        ],
      }),
    ).toBe('hms-read-detail:evidence-1');
  });

  it('does not synthesize a parent id when detail evidence is absent or unverified', () => {
    expect(
      connectedRunnerParentEvidenceId({
        ...successfulDetail(),
        evidence: [
          {
            evidenceRef: 'hms-read-detail:evidence-unverified',
            artifactRef: null,
            scopeVerified: false,
          },
        ],
      }),
    ).toBeNull();
    expect(connectedRunnerParentEvidenceId(successfulDetail())).toBeNull();
  });
});
