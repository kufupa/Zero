import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { bindAttachDocumentForm } from '../src/ai/pane-hms-write.js';

const itemId = '31b44b6e-ff0a-43c1-a6eb-82aa2771a235';
const item = { id: itemId, state: {}, status: 'needs_you', sourceMessageId: 'message-1' };
const input = {
  transportId: 'hotel', workItemId: itemId, confirmation: '123456-1', arrival: '2027-09-14',
  lastName: 'Labtest', attachmentId: 'attachment-1', env: { RESERVATIONIST_PANE_SAVE: 'lab' },
};

function fakeDb(rows: unknown[][]) {
  const operations: string[] = [];
  let index = 0;
  const tx = {
    select: vi.fn(() => {
      const current = index++;
      const query = {
        from: () => query, where: () => query,
        limit: (count: number) => {
          if (count !== 2) return query;
          operations.push(`read:${current}`);
          return Promise.resolve(rows[current]);
        },
        for: async (mode: string) => { operations.push(`lock:${current}:${mode}`); return rows[current]; },
      };
      return query;
    }),
    update: vi.fn(() => { throw new Error('unexpected_mutation'); }),
  };
  const db = { transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx) } as unknown as DB;
  return { db, operations, update: tx.update };
}

// Mocked operation ordering does not prove PostgreSQL lock behavior.
describe('attach form binding during create dispatch', () => {
  it('refuses an active or malformed fence before reading the attachment or changing the form', async () => {
    for (const value of [null, { version: 'pane-create-fence/v1' }]) {
      const fake = fakeDb([[item], [{ id: itemId }], [{ id: 'fence', value }]]);
      await expect(bindAttachDocumentForm({ ...input, db: fake.db }))
        .resolves.toEqual({ status: 'refused', reason: 'write_in_flight' });
      expect(fake.operations).toEqual(['lock:0:update', 'lock:1:update', 'read:2']);
      expect(fake.update).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing item without reading a fence or changing the form', async () => {
    const fake = fakeDb([[]]);
    await expect(bindAttachDocumentForm({ ...input, db: fake.db }))
      .resolves.toEqual({ status: 'refused', reason: 'not_found' });
    expect(fake.operations).toEqual(['lock:0:update']);
    expect(fake.update).not.toHaveBeenCalled();
  });
});
