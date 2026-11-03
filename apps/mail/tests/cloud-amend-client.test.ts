import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import { cloudAmendClientFromTrpc, type CloudAmendRequest } from '../lib/quote-workflow/cloud-amend-client';

const digest = 'a'.repeat(64);
const request: CloudAmendRequest = { workItemId: '00000000-0000-4000-8000-000000000001',
  source: { threadId: 'thread', messageId: 'message', sourceHash: 'b'.repeat(64) },
  confirmation: '12345678-1', arrival: '2027-05-02', changes: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' } };
const bound = { status: 'bound', formDigest: digest, previewDigest: 'c'.repeat(64), readAt: '2026-11-03T00:00:00.000Z' };
const view = { status: 'needs_you', form: { action: 'amend', cloudAmend: { bound: true },
  confirmation: request.confirmation, arrival: request.arrival, fields: request.changes }, formDigest: digest,
  before: null, snapshot: { readAt: bound.readAt, stale: false }, grant: null, run: null, needsCheck: false };

function routes(ready = true) {
  const api = {
    cloudAmendReady: { query: vi.fn().mockResolvedValue({ ready }) },
    bindCloudAmend: { mutate: vi.fn().mockResolvedValue(bound) },
    cloudAmendState: { query: vi.fn().mockResolvedValue(view) },
    approveCloudAmend: { mutate: vi.fn().mockResolvedValue({ grantId: 'grant', runId: 'run', hmsReadAt: bound.readAt, expiresAt: bound.readAt }) },
    reviewCloudAmend: { mutate: vi.fn().mockResolvedValue({ runId: 'run', status: 'needs_you' }) },
    cloudAmendEvidence: { query: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'evidence_unavailable' }) },
  };
  return { api, trpc: { hmsApproval: api } };
}

beforeEach(() => setMailCacheScope({ userId: 'staff', activeTransportId: 'hotel' }));
afterEach(() => setMailCacheScope({ userId: null, activeTransportId: null }));
const selected = () => ({ transportId: 'hotel', signal: new AbortController().signal, isCurrent: () => true });

describe('source-bound Cloud amend client', () => {
  it('does not expose preparation when the server says the writer is held', async () => {
    const { api, trpc } = routes(false);
    expect(await cloudAmendClientFromTrpc(trpc, request, selected())).toBeNull();
    expect(api.bindCloudAmend.mutate).not.toHaveBeenCalled();
    expect(api.approveCloudAmend.mutate).not.toHaveBeenCalled();
  });

  it('pins the displayed form and exact source to one Go, including when its response is lost', async () => {
    const { api, trpc } = routes();
    const client = await cloudAmendClientFromTrpc(trpc, request, selected());
    expect(client).not.toBeNull();
    expect(await client!.prepare()).toBe(true);
    expect(await client!.approval.writeState({ workItemId: request.workItemId })).toEqual(view);
    api.approveCloudAmend.mutate.mockRejectedValueOnce(new Error('response lost'));
    await expect(client!.approval.approve({ workItemId: request.workItemId, formDigest: digest })).rejects.toThrow('response lost');
    await expect(client!.approval.approve({ workItemId: request.workItemId, formDigest: digest })).rejects.toThrow('state_changed');
    expect(api.approveCloudAmend.mutate).toHaveBeenCalledTimes(1);
    expect(api.approveCloudAmend.mutate).toHaveBeenCalledWith({ workItemId: request.workItemId,
      source: request.source, formDigest: digest }, expect.objectContaining({ context: { activeTransportId: 'hotel' } }));
    client!.dispose();
  });

  it('refuses a different displayed amendment and a failed rebind', async () => {
    const { api, trpc } = routes();
    const client = await cloudAmendClientFromTrpc(trpc, request, selected());
    expect(await client!.prepare()).toBe(true);
    api.cloudAmendState.query.mockResolvedValueOnce({ ...view, form: { ...view.form, fields: { ...request.changes, adults: 4 } } });
    await expect(client!.approval.writeState({ workItemId: request.workItemId })).rejects.toThrow('state_changed');
    api.bindCloudAmend.mutate.mockResolvedValueOnce({ status: 'refused', reason: 'hms_changed' });
    expect(await client!.prepare()).toBe(false);
    await expect(client!.approval.approve({ workItemId: request.workItemId, formDigest: digest })).rejects.toThrow('state_changed');
    expect(api.approveCloudAmend.mutate).not.toHaveBeenCalled();
    client!.dispose();
  });

  it('permanently invalidates a pending preparation on a mailbox switch, even after switching back', async () => {
    const { api, trpc } = routes();
    const client = await cloudAmendClientFromTrpc(trpc, request, selected());
    let finish: (value: unknown) => void = () => {};
    api.bindCloudAmend.mutate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = client!.prepare();
    setMailCacheScope({ userId: 'staff', activeTransportId: 'other' });
    setMailCacheScope({ userId: 'staff', activeTransportId: 'hotel' });
    finish(bound);
    expect(await pending).toBe(false);
    await expect(client!.approval.approve({ workItemId: request.workItemId, formDigest: digest })).rejects.toThrow('state_changed');
    expect(api.approveCloudAmend.mutate).not.toHaveBeenCalled();
  });
});
