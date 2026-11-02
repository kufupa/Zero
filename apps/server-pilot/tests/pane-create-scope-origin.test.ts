import { describe, expect, it } from 'vitest';
import { paneOwnRowsFromEvents } from '../src/ai/pane-create-scope-origin.js';

const identity = { stayId: 's1', rowId: 's1_row', roomIndex: 1 };
const path = 'stays[s1].rows[s1_row].count';
const row = { workItemId: 'item', transportId: 'transport', sourceMessageId: 'message', eventWorkItemId: 'item',
  eventId: 'event', actorKind: 'user', eventType: 'field.edit', fieldPath: path, value: 1, aiSource: 'v1',
  evidence: { extractionId: 'extraction', paneSeq: 1, paneState: { [path]: 1 } }, extractionId: 'extraction',
  extractionMessageId: 'message', extractorVersion: 'v1', extractionStatus: 'succeeded', extraction: { stays: [] } };
const project = (rows: Array<typeof row>, other = identity) => paneOwnRowsFromEvents({
  workItemId: 'item', transportId: 'transport', identity: other, rows,
});

describe('own-row event provenance', () => {
  it('projects a same-item user event tied to its exact source extraction', () => {
    expect(project([row])).toEqual([{ eventId: 'event', extractionId: 'extraction', fieldPath: path, value: 1, extraction: row.extraction }]);
  });
  it('rejects events from another item, mailbox, message, actor, version, or extraction', () => {
    for (const patch of [{ workItemId: 'other' }, { eventWorkItemId: 'other' }, { transportId: 'other' },
      { sourceMessageId: 'other' }, { extractionMessageId: 'other' }, { actorKind: 'system' },
      { eventType: 'field.accept' }, { fieldPath: 'stays[s1].rows[r1].count' }, { aiSource: 'v2' },
      { extractionId: 'other' }, { extractionStatus: 'failed' }]) {
      expect(project([{ ...row, ...patch }])).toEqual([]);
    }
  });
  it('requires a revision after-state matching the recorded field value and own-row identity', () => {
    expect(project([{ ...row, evidence: { ...row.evidence, paneSeq: 0 } }])).toEqual([]);
    expect(project([{ ...row, evidence: { ...row.evidence, paneState: { [path]: 2 } } }])).toEqual([]);
    expect(project([{ ...row, evidence: { ...row.evidence, paneState: {} } }])).toEqual([]);
    expect(project([row], { ...identity, rowId: 'other' })).toEqual([]);
    expect(project([row], { ...identity, roomIndex: 2 })).toEqual([]);
  });
});
