import { describe, expect, it } from 'vitest';
import { projectCloudCancellationPreview, runCloudCancellationPreview } from '../src/ai/hms-cloud-cancellation-preview.js';
import { CENTURION_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';

describe('Cloud cancellation preview projection', () => {
  it('projects a read-only cancellation preview and drops private record fields', () => {
    const cancellationRequest = { confirmation: '123456-1', arrival: '2027-01-10' };
    const raw = {
      outcome: 'prepared_for_human_review',
      target: { confirmation: '123456-1', verified: true },
      stay: {
        status: { state: 'observed', value: 'Reserved' },
        arrivalDate: { state: 'observed', value: '10-Jan-2027' },
        departureDate: { state: 'observed', value: '12-Jan-2027' },
      },
      party: { bookingAgency: { value: 'Private Agency' } },
      money: { balance: { amount: { state: 'observed', value: '999.00' } } },
      roomScope: { requested: 'unspecified', state: 'unresolved', complete: false },
      policy: { state: 'unknown' },
      fee: { state: 'unknown_precommit', amount: null, currency: null },
      action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
      observedAt: '2026-11-02T10:00:00.000Z',
    };
    const result = projectCloudCancellationPreview(cancellationRequest, raw);
    expect(result).toEqual(expect.objectContaining({
      outcome: 'prepared_for_human_review',
      target: { confirmation: '123456-1', verified: true },
      stay: {
        status: { state: 'observed', value: 'Reserved' },
        arrivalDate: { state: 'observed', value: '2027-01-10' },
        departureDate: { state: 'observed', value: '2027-01-12' },
      },
      roomScope: { requested: 'unspecified', state: 'unresolved', complete: false },
      policy: { state: 'unknown' },
      fee: { state: 'unknown_precommit', amount: null, currency: null },
      action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
      moduleStatus: { outcome: 'prepared_for_human_review', issue: null },
    }));
    expect(JSON.stringify(result)).not.toContain('Private Agency');
    expect(JSON.stringify(result)).not.toContain('999.00');
  });

  it('maps native hint mismatch to identity refusal', () => {
    const result = projectCloudCancellationPreview(
      { confirmation: '123456-1', arrival: '2027-01-10' },
      { outcome: 'read_failed', issue: 'CONFIRMATION_HINT_MISMATCH' },
    );
    expect(result).toEqual(expect.objectContaining({
      outcome: 'refused_identity_mismatch', reason: 'CONFIRMATION_HINT_MISMATCH',
    }));
  });

  it('refuses an unsupported target before opening a Cloud session', async () => {
    const result = await runCloudCancellationPreview({
      request: { confirmation: '123456-1' },
      target: { ...CENTURION_HMS_READ_TARGET, browserSlot: 'davinci' },
      transportId: 'transport-centurion',
    });
    expect(result).toEqual({ outcome: 'target_unverified', issue: 'CLOUD_READ_TARGET_UNSUPPORTED' });
  });

  it('preserves preflight refusal status and blocks arrival mismatches', () => {
    const request = { confirmation: '123456-1', arrival: '2027-01-10' };
    const refused = projectCloudCancellationPreview(request, {
      outcome: 'target_unverified', issue: 'RECORD_TARGET_MISMATCH', rawRecord: 'private',
    });
    expect(refused).toEqual(expect.objectContaining({
      outcome: 'target_unverified',
      reason: 'RECORD_TARGET_MISMATCH',
      moduleStatus: { outcome: 'target_unverified', issue: 'RECORD_TARGET_MISMATCH' },
    }));
    expect(JSON.stringify(refused)).not.toContain('private');

    const prepared = {
      outcome: 'prepared_for_human_review',
      target: { confirmation: '123456-1', verified: true },
      stay: {
        status: { state: 'observed', value: 'Reserved' },
        arrivalDate: { state: 'observed', value: '10-Jan-2027' },
        departureDate: { state: 'observed', value: '12-Jan-2027' },
      },
      roomScope: { requested: 'unspecified', state: 'unresolved', complete: false },
      policy: { state: 'unknown' },
      fee: { state: 'unknown_precommit', amount: null, currency: null },
      action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
    };
    const mismatch = projectCloudCancellationPreview({ ...request, arrival: '2027-01-11' }, prepared);
    expect(mismatch.outcome).toBe('refused_identity_mismatch');
    expect(mismatch.reason).toBe('REQUESTED_ARRIVAL_MISMATCH');
  });
});
