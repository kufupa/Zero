import { describe, expect, it, vi } from 'vitest';

const { preview, selected } = vi.hoisted(() => ({ preview: vi.fn(), selected: vi.fn().mockResolvedValue(true) }));
vi.mock('../src/ai/pane-filing-preview.js', () => ({ previewFiling: preview }));
vi.mock('../src/ai/hms-jobs.js', async (original) => ({
  ...(await original<typeof import('../src/ai/hms-jobs.js')>()), isSelectedHmsInboundMessage: selected,
}));
import { appRouter } from '../src/trpc/router.js';

const request = { workItemId: '3f8a2c1e-9b7d-4e6f-8a1b-2c3d4e5f6a7b', sourceMessageId: 'mail-1',
  attachmentId: 'attachment-1', confirmation: '123456-1', arrival: '2027-09-14', lastName: 'Labtest',
  selectedSource: { threadId: 'thread-1', messageId: 'mail-1', sourceHash: 'a'.repeat(64) } };

describe('mounted filing preview', () => {
  it('uses the authenticated actor and selected mailbox, not caller-supplied authority', async () => {
    preview.mockResolvedValueOnce({ status: 'ready', confirmation: request.confirmation,
      arrival: request.arrival, documentName: 'voucher.pdf' });
    const caller = appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
      sessionUser: { id: 'staff-1', email: 'staff@example.test', name: 'Staff' },
      activeTransportId: 'transport-centurion', accessRole: 'owner', transportEmail: 'desk@example.test' } as never);
    await expect(caller.hmsApproval.previewAttach(request)).resolves.toMatchObject({ status: 'ready' });
    expect(preview).toHaveBeenCalledWith({ ...request, actorUserId: 'staff-1', transportId: 'transport-centurion' });
    expect(selected).toHaveBeenCalledTimes(2);
    selected.mockResolvedValueOnce(false);
    await expect(caller.hmsApproval.previewAttach(request)).resolves.toEqual({ status: 'refused', reason: 'source_changed' });
    await expect(caller.hmsApproval.previewAttach({ ...request, actorUserId: 'other' } as never)).rejects.toThrow();
    expect(preview).toHaveBeenCalledTimes(1);
  });
});
