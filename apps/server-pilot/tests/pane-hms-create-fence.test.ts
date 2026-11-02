import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { bindAttachDocumentForm } from '../src/ai/pane-hms-write.js';

const input = {
  transportId: 'hotel', workItemId: '31b44b6e-ff0a-43c1-a6eb-82aa2771a235',
  confirmation: '123456-1', arrival: '2027-09-14', lastName: 'Labtest', attachmentId: 'attachment-1',
};

// The legacy binder is disabled before it can inspect or mutate any item. The Cloud binder
// must independently enforce the create fence; these checks do not prove database locking.
describe('legacy attachment binding during create dispatch', () => {
  it.each([{}, { RESERVATIONIST_PANE_SAVE: 'lab' }, { PANE_WRITE_ATTACH: 'on' }])(
    'refuses before reading or changing any work item under %j', async (env) => {
      const access = vi.fn(() => { throw new Error('unexpected database access'); });
      const db = new Proxy({} as DB, { get: access });
      await expect(bindAttachDocumentForm({ ...input, db, env }))
        .resolves.toEqual({ status: 'refused', reason: 'legacy_attach_disabled' });
      expect(access).not.toHaveBeenCalled();
    },
  );
});
