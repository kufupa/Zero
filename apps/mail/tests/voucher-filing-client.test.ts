import { describe, expect, it, vi } from 'vitest';
import { filingPrepareClientFromTrpc } from '../lib/quote-workflow/voucher-filing-client';

const choice = { workItemId: 'work', messageId: 'message', attachmentId: 'attachment', expectedSessionId: null,
  kind: 'voucher' as const, stay: { confirmation: '123-1', arrival: '2027-01-01', lastName: 'Labtest' } };
const prepared = { status: 'prepared' as const, ...choice, filename: 'proof.pdf',
  stay: { ...choice.stay, firstName: 'Proof' }, formDigest: 'a'.repeat(64) };
const setup = (reply: unknown = prepared) => {
  const prepare = vi.fn(async () => reply), go = vi.fn(async () => ({ status: 'queued', operationId: 'run' }));
  const api = filingPrepareClientFromTrpc({ voucherFiling: { prepare: { mutate: prepare }, go: { mutate: go } } });
  if (!api) throw new Error('missing client');
  return { api, prepare, go };
};

describe('filing prepare client', () => {
  it('stays unavailable if either server route is absent', () => {
    expect(filingPrepareClientFromTrpc({})).toBeNull();
    expect(filingPrepareClientFromTrpc({ voucherFiling: { prepare: { mutate: vi.fn() } } })).toBeNull();
  });

  it('shows the server-prepared form and sends only the reviewed digest on Go', async () => {
    const { api, go } = setup(), result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    expect(result.value.filename).toBe('proof.pdf');
    expect(Object.isFrozen(result.value.stay)).toBe(true);
    expect(await api.go(result.value)).toEqual({ status: 'queued', operationId: 'run' });
    expect(go).toHaveBeenCalledWith({ workItemId: 'work', messageId: 'message', formDigest: 'a'.repeat(64), expectedSessionId: null });
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
    expect(await api.go({ ...result.value })).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('rejects changed selection, malformed forms and unexpected authority fields', async () => {
    for (const response of [
      { ...prepared, workItemId: 'other' }, { ...prepared, messageId: 'other' }, { ...prepared, attachmentId: 'other' },
      { ...prepared, expectedSessionId: 'other' }, { ...prepared, kind: 'proof_of_payment' },
      { ...prepared, stay: { ...prepared.stay, confirmation: '999-1' } },
      { ...prepared, stay: { ...prepared.stay, arrival: '2027-01-02' } },
      { ...prepared, stay: { ...prepared.stay, lastName: 'Other' } },
      { ...prepared, filename: '' }, { ...prepared, formDigest: 'not-a-digest' }, { ...prepared, grantRef: 'not-for-the-pane' },
    ]) expect(await setup(response).api.prepare(choice)).toEqual({ status: 'unavailable' });
  });

  it('treats a lost or refused Go response as needing a check and never retries automatically', async () => {
    const prepare = vi.fn(async () => prepared), go = vi.fn(async () => { throw new Error('network'); });
    const api = filingPrepareClientFromTrpc({ voucherFiling: { prepare: { mutate: prepare }, go: { mutate: go } } });
    if (!api) throw new Error('missing client');
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });
});
