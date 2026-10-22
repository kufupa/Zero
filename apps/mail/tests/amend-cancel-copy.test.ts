import { describe, expect, it } from 'vitest';
import {
  AMEND_CANCEL_COPY,
  AMEND_SAVE_COPY,
  canPreviewAmendFromCapabilities,
  canPreviewCancelFromCapabilities,
  cancellationChargeCopy,
  classifyAmendPayment,
  cancelledText,
  cancelOutcomeNote,
  changedAmendRows,
  viewAfterAmendCommit,
  viewAfterAmendPreview,
  viewAfterCommit,
  viewAfterPreview,
  type AmendRun,
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
    // The done line a commit gets when the CLI reports cancelled with a charge: the charge text and the staff step.
    const done = viewAfterCommit(
      run({ outcome: 'cancelled', statusAfter: 'Cancelled', penaltyText: CHARGE, previewDigest: null }),
      run(),
      CONFIRMATION,
    );
    expect(done).toMatchObject({ kind: 'done' });
    expect(done.kind === 'done' && done.text).toContain(`HMS shows a cancellation charge: ${CHARGE.replace(/\.$/, '')}.`);
    expect(done.kind === 'done' && done.text).toContain('Check HMS and deal with that charge there.');
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

describe('canPreviewCancelFromCapabilities', () => {
  it('stays off when paneSave is missing or false', () => {
    expect(canPreviewCancelFromCapabilities(undefined)).toBe(false);
    expect(canPreviewCancelFromCapabilities(null)).toBe(false);
    expect(canPreviewCancelFromCapabilities({})).toBe(false);
    expect(canPreviewCancelFromCapabilities({ paneSave: false })).toBe(false);
    expect(canPreviewCancelFromCapabilities({ paneSave: false, paneSaveMode: 'lab' })).toBe(false);
    expect(canPreviewCancelFromCapabilities({ paneSave: false, paneSaveMode: 'on' })).toBe(false);
  });

  it('is on for lab and on, including a server that only sends paneSave', () => {
    expect(canPreviewCancelFromCapabilities({ paneSave: true })).toBe(true);
    expect(canPreviewCancelFromCapabilities({ paneSave: true, paneSaveMode: 'lab' })).toBe(true);
    expect(canPreviewCancelFromCapabilities({ paneSave: true, paneSaveMode: 'on' })).toBe(true);
  });
});

describe('canPreviewAmendFromCapabilities', () => {
  it('is on only when paneSave is lab', () => {
    expect(canPreviewAmendFromCapabilities(undefined)).toBe(false);
    expect(canPreviewAmendFromCapabilities({ paneSave: true })).toBe(false);
    expect(canPreviewAmendFromCapabilities({ paneSave: true, paneSaveMode: 'on' })).toBe(false);
    expect(canPreviewAmendFromCapabilities({ paneSave: false, paneSaveMode: 'lab' })).toBe(false);
    expect(canPreviewAmendFromCapabilities({ paneSave: true, paneSaveMode: 'lab' })).toBe(true);
  });
});

describe('changed amend rows', () => {
  it('keeps only fields that differ from HMS', () => {
    expect(
      changedAmendRows(
        { arrival: '2027-09-14', departure: '2027-09-16', roomType: 'DLXKNG', adults: 1, children: 0 },
        { arrival: '2027-09-15', departure: '2027-09-16', roomType: 'DLXKNG', adults: 1, children: 0 },
      ).map((row) => row.field),
    ).toEqual(['arrival']);
  });
});

describe('amend preview and commit views', () => {
  const amendRun = (overrides: Partial<AmendRun> = {}): AmendRun => ({
    outcome: 'previewed',
    screenshots: [],
    runId: null,
    previewDigest: 'a'.repeat(64),
    changedFieldsReadback: null,
    ...overrides,
  });

  it('a previewed run with a digest is ready to approve', () => {
    expect(viewAfterAmendPreview(amendRun(), CONFIRMATION)).toMatchObject({ kind: 'ready' });
  });

  it('a stale digest sends staff back to preview', () => {
    expect(viewAfterAmendCommit(amendRun({ outcome: 'amend_digest_mismatch' }), CONFIRMATION)).toEqual({
      kind: 'idle',
      note: AMEND_SAVE_COPY.previewAgain,
    });
  });

  it('a payment refusal tells staff to change the booking in HMS', () => {
    expect(viewAfterAmendCommit(amendRun({ outcome: 'refused_payment_unknown' }), CONFIRMATION)).toEqual({
      kind: 'idle',
      note: AMEND_SAVE_COPY.handleInHms,
    });
  });
});

describe('classifyAmendPayment', () => {
  const unpaid = {
    status: 'Reserved',
    guaranteeType: 'Non-Guaranteed Individual',
    depositReceived: '0',
  };

  it('is unpaid only with provisional status, deposit 0, and a non-paying guarantee', () => {
    expect(classifyAmendPayment(unpaid)).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '0.00' })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: 'Non-Guaranteed Indi...' })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: null })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '' })).toBe('unpaid');
  });

  it('fails closed for paid, guaranteed, and missing fields', () => {
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '80.00' })).toBe('paid');
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: 'Guaranteed By Agent' })).toBe('guaranteed');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: null, guaranteeType: 'Guaranteed By Agent' })).not.toBe(
      'unpaid',
    );
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: null })).toBe('unknown');
    expect(classifyAmendPayment({ ...unpaid, status: 'Confirmed' })).toBe('unknown');
    expect(classifyAmendPayment({ ...unpaid, status: 'Confirmed', depositReceived: null })).not.toBe('unpaid');
  });
});
