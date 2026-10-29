import { describe, expect, it } from 'vitest';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { recordFieldEvent, storedAnalysis, validFieldValue } from '../src/ai/work-items.js';
import { workItem } from '../src/db/schema/work.js';

const payload: MailExtractionPayload = {
  contact: { name: null, email: null, phone: null },
  agency: null,
  endClient: null,
  confirmationNumbers: [],
  stays: [{
    id: 's_1', hotel: 'Centurion', requested: { arrival: '2027-10-20', departure: '2027-10-21' },
    booked: null, totalRooms: 1,
    rows: [{ id: 'r_1', roomType: 'Standard King', rooms: 1, adultsPerRoom: 2,
      childrenPerRoom: 1, childAges: [8], board: 'bb' }],
  }],
  missing: [],
};

describe('saved child occupancy', () => {
  it('records a copied row and its later corrections without changing the original on reopen', async () => {
    let item = { extractionId: 'extract-1', state: {} as Record<string, unknown>, revision: 0, revisionHead: 0, revisionSeq: 0 };
    const events: Array<Record<string, unknown>> = [];
    const tx = {
      select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: () =>
        table === workItem ? { for: async () => [item] } : Promise.resolve([{ payload, version: 'v1' }]),
      }) }) }),
      insert: () => ({ values: async (event: Record<string, unknown>) => { events.push(event); } }),
      update: () => ({ set: (values: Partial<typeof item>) => ({ where: async () => { item = { ...item, ...values }; } }) }),
    };
    const db = { transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx) };
    const row = 'stays[s_1].rows[r_copy]';
    const write = (field: string, value: unknown) => recordFieldEvent(db as never, {
      transportId: 'centurion', workItemId: 'wi-1', userId: 'staff',
      type: 'field.edit', fieldPath: `${row}.${field}`, value,
    });

    expect(await write('childrenPerRoom', 1)).toEqual({ status: 'recorded', aiValue: null, value: 1 });
    expect(await write('childAges', [8])).toMatchObject({ status: 'recorded' });
    expect(await write('childrenPerRoom', 2)).toMatchObject({ status: 'recorded' });
    expect(await write('childAges', [8, 11])).toMatchObject({ status: 'recorded' });
    expect(await write('childrenPerRoom', -1)).toEqual({ status: 'invalid_value' });
    expect(events).toHaveLength(4);
    const reopened = storedAnalysis({ kind: 'quote', payload, attachments: [] }, item.state);
    expect(reopened.analysis.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'r_1', childrenPerRoom: 1, childrenAges: [8] }),
      expect.objectContaining({ id: 'r_copy', childrenPerRoom: 2, childrenAges: [8, 11] }),
    ]));
    expect(reopened.refs.r_copy).toEqual({ stayId: 's_1', rowId: 'r_copy' });
  });

  it('keeps a cleared age list unknown and only accepts bounded whole child counts', () => {
    const state = { 'stays[s_1].rows[r_1].childrenPerRoom': 0, 'stays[s_1].rows[r_1].childAges': null };
    expect(storedAnalysis({ kind: 'quote', payload, attachments: [] }, state).analysis.groups[0]).toMatchObject({
      childrenPerRoom: null, childrenAges: [],
    });
    expect([0, 6, -1, 7, 1.5, null].map((value) => validFieldValue('childrenPerRoom', value)))
      .toEqual([true, true, false, false, false, true]);
  });
});
