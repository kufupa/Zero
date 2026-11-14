import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { checkCancelInput, commitCancel, paneCancelDigest, paneCancelMessage, paneStayCancelEnabled, previewCancel } from '../src/ai/pane-stay-cancel.js';
import { PANE_PAID_BOOKING_COPY } from '../src/ai/pane-stay-save.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { appRouter } from '../src/trpc/router.js';

const cloud = vi.hoisted(() => ({ preview: vi.fn(), commit: vi.fn() }));
vi.mock('../src/ai/pane-cloud-cancel.js', async (original) => ({
  ...await original<typeof import('../src/ai/pane-cloud-cancel.js')>(),
  previewCloudCancel: cloud.preview, commitCloudCancel: cloud.commit,
}));
const stay = { confirmation: '57291630-1', arrival: '2027-09-14' };
const source = { threadId: 'thread', messageId: 'message', sourceHash: 'a'.repeat(64) };
const bound = { ...stay, owner: 'user-ropperman:transport-davinci', transportId: 'transport-davinci',
  actorUserId: 'user-ropperman', sessionId: 'staff-session', sessionProfile: 'legacy' as const,
  workItemId: '00000000-0000-4000-8000-000000000001', source };
const digestOf = (input: typeof stay) => createHash('sha256').update(JSON.stringify({ arrival: input.arrival, confirmation: input.confirmation })).digest('hex');
function mailboxCaller() {
  return appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(), sessionUser: {
    id: 'user-ropperman', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman',
    sessionId: 'staff-session', sessionProfile: 'legacy',
  }, activeTransportId: 'transport-davinci', transportEmail: 'davinci@legacyhotels.co.za', accessRole: 'owner' } as never);
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('pane stay cancel', () => {
  it('uses the cancel policy flags without inheriting the Create flag', () => {
    expect(paneStayCancelEnabled({})).toBe(false);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(false);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'lab' })).toBe(true);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe(true);
    expect(paneStayCancelEnabled({ PANE_WRITE_CREATE: 'on' })).toBe(false);
    expect(paneStayCancelEnabled({ PANE_WRITE_CANCEL_UNPAID: 'lab' })).toBe(true);
  });

  it('classifies inputs with the 2027 floor and format checks', () => {
    expect(checkCancelInput(stay)).toBeNull();
    expect(checkCancelInput({ ...stay, arrival: '2027-01-01' })).toBeNull();
    expect(checkCancelInput({ ...stay, arrival: '2026-12-31' })).toBe('refused_not_lab');
    expect(checkCancelInput({ ...stay, arrival: '2026-12-31' }, { allowRealGuest: true })).toBeNull();
    expect(checkCancelInput({ ...stay, confirmation: '57291630' })).toBe('refused_input_invalid');
    expect(checkCancelInput({ ...stay, arrival: '14-SEP-2027' })).toBe('refused_input_invalid');
    expect(checkCancelInput({ ...stay, arrival: '2027-02-30' })).toBe('refused_input_invalid');
  });

  it('refuses malformed input and a blank or flag-shaped reason before preparation', async () => {
    await expect(previewCancel({ ...bound, confirmation: 'ABC' })).resolves.toMatchObject({ outcome: 'refused_input_invalid' });
    await expect(previewCancel({ ...bound, arrival: '2027-02-30' })).resolves.toMatchObject({ outcome: 'refused_input_invalid' });
    for (const reason of ['   ', '--mode']) await expect(commitCancel({ ...bound, reason })).resolves.toMatchObject({ outcome: 'refused_reason_missing' });
    expect(cloud.preview).not.toHaveBeenCalled(); expect(cloud.commit).not.toHaveBeenCalled();
  });

  it('digest is sha256 of the canonical confirmation and arrival', () => {
    expect(paneCancelDigest(stay)).toBe(digestOf(stay));
    expect(paneCancelDigest({ ...stay, arrival: '2027-09-15' })).not.toBe(paneCancelDigest(stay));
  });

  it('holds source-less cancellation before native preparation for both properties', async () => {
    await expect(previewCancel({ ...stay, owner: bound.owner })).resolves.toMatchObject({ outcome: 'refused_source_changed' });
    await expect(previewCancel({ ...stay, owner: 'staff:transport-centurion', transportId: 'transport-centurion' })).resolves.toMatchObject({ outcome: 'refused_source_changed' });
    await expect(previewCancel({ ...bound, owner: 'another-user:transport-davinci' })).resolves.toMatchObject({ outcome: 'refused_source_changed' });
    await expect(previewCancel({ ...bound, sessionId: undefined })).resolves.toMatchObject({ outcome: 'refused_source_changed' });
    expect(cloud.preview).not.toHaveBeenCalled();
  });

  it('prepares the exact source, staff session and authenticated selected property', async () => {
    const prepared = { outcome: 'preview_ok', previewDigest: digestOf(stay), reasons: ['Duplicate Booking'] };
    cloud.preview.mockResolvedValue(prepared);
    await expect(previewCancel(bound)).resolves.toEqual(prepared);
    expect(cloud.preview).toHaveBeenCalledWith(expect.objectContaining({ target: DAVINCI_HMS_READ_TARGET,
      source, workItemId: bound.workItemId, actorUserId: bound.actorUserId, sessionId: bound.sessionId,
      transportId: bound.transportId, confirmation: stay.confirmation, arrival: stay.arrival }));
    await previewCancel({ ...bound, transportId: 'transport-centurion', owner: 'user-ropperman:transport-centurion' });
    expect(cloud.preview).toHaveBeenLastCalledWith(expect.objectContaining({ target: CENTURION_HMS_READ_TARGET }));
    await previewCancel({ ...bound, propertyCode: 'HRDAVS' });
    expect(cloud.preview).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ propertyCode: 'HRDAVS' }) }));
  });

  it('requires a preview and queues the durable Cloud approval with the trimmed selected reason', async () => {
    await expect(commitCancel({ ...bound, reason: 'Duplicate Booking' })).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    expect(cloud.commit).not.toHaveBeenCalled();
    const queued = { outcome: 'cancel_queued', previewDigest: digestOf(stay) };
    cloud.commit.mockResolvedValue(queued);
    await expect(commitCancel({ ...bound, reason: '  Duplicate   Booking ', previewDigest: digestOf(stay), cancellationNote: 'Staff requested' })).resolves.toEqual(queued);
    expect(cloud.commit).toHaveBeenCalledWith(expect.objectContaining({ source, sessionId: bound.sessionId,
      reason: 'Duplicate Booking', previewDigest: digestOf(stay), cancellationNote: 'Staff requested', target: DAVINCI_HMS_READ_TARGET }));
  });

  it('preserves unresolved native cancel and penalty messages', () => {
    expect(paneCancelMessage('cancel_unconfirmed')).toContain('Check HMS before trying again');
    expect(paneCancelMessage('cancel_penalty_pending')).toContain('Check HMS before anything else');
    expect(paneCancelMessage('refused_not_unpaid')).toBe(PANE_PAID_BOOKING_COPY);
    expect(paneCancelMessage('cancelled')).toBeNull();
  });

  it('an unknown transport or cross-group selected property refuses before native preparation', async () => {
    await expect(previewCancel({ ...bound, transportId: 'transport-unknown' })).resolves.toMatchObject({ outcome: 'refused_unknown_transport', runId: null, previewDigest: null });
    await expect(previewCancel({ ...bound, propertyCode: 'HRCEN' })).resolves.toMatchObject({ outcome: 'refused_unknown_transport' });
    expect(cloud.preview).not.toHaveBeenCalled();
  });
});

describe('paneStayCancel route validation', () => {
  it('rejects caller-selected unknown keys, missing preview digests and flag-shaped reasons', async () => {
    const caller = mailboxCaller();
    await expect(caller.paneStayCancel.previewCancel({ ...stay, propertyCode: 'OTHER' } as never)).rejects.toThrow();
    await expect(caller.paneStayCancel.commitCancel({ ...stay, reason: '--force', previewDigest: digestOf(stay) })).rejects.toThrow();
    await expect(caller.paneStayCancel.commitCancel({ ...stay, reason: 'Duplicate Booking' } as never)).rejects.toThrow();
    await expect(caller.paneStayCancel.commitCancel({ ...stay, reason: 'Duplicate Booking', previewDigest: 'ABC' })).rejects.toThrow();
    expect(cloud.commit).not.toHaveBeenCalled();
  });

  it('validates the run id and PNG name strictly and answers unavailable for unknown runs', async () => {
    const caller = mailboxCaller();
    await expect(caller.paneStayCancel.paneStayScreenshot({ runId: '../etc', name: 'filled.png' })).rejects.toThrow();
    await expect(caller.paneStayCancel.paneStayScreenshot({ runId: '00000000-0000-4000-8000-000000000000', name: '../filled.png' })).rejects.toThrow();
    await expect(caller.paneStayCancel.paneStayScreenshot({ runId: '00000000-0000-4000-8000-000000000000', name: 'filled.png', extra: true } as never)).rejects.toThrow();
    await expect(caller.paneStayCancel.paneStayScreenshot({ runId: '00000000-0000-4000-8000-000000000000', name: 'filled.png' })).resolves.toEqual({ status: 'unavailable', reason: 'screenshot_unavailable' });
  });
});
