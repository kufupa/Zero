import { describe, expect, it } from 'vitest';
import {
  AMEND_CANCEL_COPY,
  cancellationChargeCopy,
  cancelledText,
  cancelOutcomeNote,
  viewAfterCommit,
  viewAfterPreview,
  type CancelRun,
} from '../lib/quote-workflow/amend-cancel';

const CHARGE = 'Cancellation Penalty of 2060.00 may be added to account.';
const CONFIRMATION = '57291630-1';

function run(overrides: Partial<CancelRun> = {}): CancelRun {
  return {
    outcome: 'preview_ok',
    statusBefore: 'Reserved',
    statusAfter: 'Reserved',
    reasons: ['Test Reservations'],
    penaltyText: null,
    screenshots: [],
    runId: null,
    previewDigest: 'a'.repeat(64),
    ...overrides,
  };
}

describe('cancellation charge copy', () => {
  it('names the HMS charge and says staff cancel it in HMS, with one full stop', () => {
    expect(cancellationChargeCopy(CHARGE)).toBe(
      'HMS shows a cancellation charge: Cancellation Penalty of 2060.00 may be added to account. Cancel this one in HMS yourself.',
    );
    expect(cancellationChargeCopy(null)).toBe(
      'HMS shows a cancellation charge. Cancel this one in HMS yourself.',
    );
  });

  it('a penalty refusal gives that copy, not the generic failure, and offers no commit', () => {
    const refused = run({ outcome: 'refused_penalty', penaltyText: CHARGE, previewDigest: null });
    expect(cancelOutcomeNote('refused_penalty', CONFIRMATION, CHARGE)).toBe(cancellationChargeCopy(CHARGE));
    expect(viewAfterPreview(refused, CONFIRMATION)).toEqual({
      kind: 'idle',
      note: cancellationChargeCopy(CHARGE),
    });
    expect(viewAfterCommit(refused, run(), CONFIRMATION)).toEqual({
      kind: 'idle',
      note: cancellationChargeCopy(CHARGE),
    });
  });

  it('a charge that opens after the OK is shown on the done line, with the staff step', () => {
    expect(cancelledText('Cancelled', CHARGE)).toBe(
      'Cancelled in HMS – status now Cancelled. HMS shows a cancellation charge: Cancellation Penalty of 2060.00 may be added to account. Check HMS and deal with that charge there.',
    );
    expect(cancelledText('Cancelled')).toBe('Cancelled in HMS – status now Cancelled');
    expect(
      viewAfterCommit(
        run({ outcome: 'cancelled', statusAfter: 'Cancelled', penaltyText: CHARGE, previewDigest: null }),
        run(),
        CONFIRMATION,
      ),
    ).toMatchObject({ kind: 'done' });
  });
});

describe('cancel outcome copy', () => {
  it('a real guest refused by the lab guard gets the test-only line', () => {
    expect(cancelOutcomeNote('refused_not_lab', CONFIRMATION)).toBe(AMEND_CANCEL_COPY.testOnly);
  });

  it('a refused reason asks for another reason, and a clean preview offers the commit', () => {
    expect(
      viewAfterCommit(run({ outcome: 'refused_reason_missing', previewDigest: null }), run(), CONFIRMATION),
    ).toEqual({ kind: 'ready', run: run(), reason: '', note: AMEND_CANCEL_COPY.reasonRefused });
    expect(viewAfterPreview(run(), CONFIRMATION)).toMatchObject({ kind: 'ready', reason: '' });
  });
});
