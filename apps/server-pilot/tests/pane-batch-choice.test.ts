import { describe, expect, it } from 'vitest';
import { matchesPaneBatchChoices, paneBatchChoiceDigest, updatePaneBatchChoiceSnapshot } from '../src/ai/pane-batch-choice.js';
import type { BatchManifest } from '../src/ai/hms-batch-manifest.js';
import type { PaneBatchChoiceSnapshot } from '../src/ai/pane-batch-choice.js';

const source = { transportId: 'transport', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' };
const cursor = { extractionId: '22222222-2222-4222-8222-222222222222', revision: 1, revisionHead: 1, seq: 3 };
const context = { source, cursor, sourceDigest: 'a'.repeat(64), propertyCode: 'HRCEN' };
const first = { identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 }, roomType: 'STQN' };
const second = { identity: { ...first.identity, roomIndex: 2 }, roomType: 'STWN' };
const allowed = () => true;
const current = (snapshot: PaneBatchChoiceSnapshot) => ({ ...context, cursor: snapshot.cursor, sourceDigest: snapshot.sourceDigest });
function add(previous: PaneBatchChoiceSnapshot | null, expectedGeneration: string | null, choice = first,
  nextContext = previous ? current(previous) : context, selected = [first.identity, second.identity]) {
  return updatePaneBatchChoiceSnapshot({ previous, expectedGeneration, context: nextContext, choice, selected,
    actorUserId: 'staff', isActiveChild: allowed });
}
function manifest(): BatchManifest {
  const room: BatchManifest['rooms'][number] = { allocationId: 'a', identity: first.identity,
    guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] },
    roomType: 'STQN', ratePlan: 'BAR', amount: { status: 'unknown' }, agency: null, organization: null,
    guaranteeType: 'NGI', sourceOfBusiness: null, note: null, track: null, marketSegment: null,
    guestOptIn: false, booker: null, cmsSend: false, cmsMessageId: null, cmsRecipient: null };
  return { version: 'hms-batch/1', propertyCode: 'HRCEN', source,
    rooms: [room, { ...structuredClone(room), allocationId: 'b', identity: second.identity, roomType: second.roomType }] };
}

describe('server-owned batch room-choice snapshot', () => {
  it('keeps separate choices for two children in the same source row', () => {
    const a = add(null, null), b = add(a, a.generation, second);
    expect(b.choices).toHaveLength(2);
    expect(b.choices.map((choice) => choice.roomType)).toEqual(['STQN', 'STWN']);
    expect(b.generation).not.toBe(a.generation);
    expect(matchesPaneBatchChoices({ snapshot: b, context: current(b), expectedGeneration: b.generation, manifest: manifest() })).toBe(true);
  });
  it('rejects stale generation and replaces only the explicitly selected child', () => {
    const a = add(null, null);
    expect(() => add(a, null, second)).toThrow('batch_choice_stale');
    const b = add(a, a.generation, second);
    const c = add(b, b.generation, { ...first, roomType: 'STWN' });
    expect(c.choices).toHaveLength(2);
    expect(c.choices.find((item) => item.identity.roomIndex === 1)?.roomType).toBe('STWN');
    expect(matchesPaneBatchChoices({ snapshot: c, context: current(c), expectedGeneration: c.generation, manifest: manifest() })).toBe(false);
  });
  it('invalidates old choices after source edits or undo even if revision returns to the same value', () => {
    const a = add(null, null), b = add(a, a.generation, second);
    const changed = { ...current(b), cursor: { ...b.cursor, seq: b.cursor.seq + 2 } };
    expect(matchesPaneBatchChoices({ snapshot: b, context: changed, expectedGeneration: b.generation, manifest: manifest() })).toBe(false);
    const c = add(b, b.generation, first, changed);
    expect(c.choices).toHaveLength(1);
    expect(matchesPaneBatchChoices({ snapshot: c, context: current(c), expectedGeneration: c.generation, manifest: manifest() })).toBe(false);
  });
  it('drops sibling choices on extraction relink and requires fresh child selections', () => {
    const a = add(null, null), b = add(a, a.generation, second);
    const relinked = { ...current(b), sourceDigest: 'b'.repeat(64),
      cursor: { ...b.cursor, extractionId: '33333333-3333-4333-8333-333333333333' } };
    expect(matchesPaneBatchChoices({ snapshot: b, context: relinked, expectedGeneration: b.generation, manifest: manifest() })).toBe(false);
    const next = add(b, b.generation, first, relinked);
    expect(next.choices.map((choice) => choice.identity.roomIndex)).toEqual([1]);
    expect(matchesPaneBatchChoices({ snapshot: next, context: { ...relinked, cursor: next.cursor },
      expectedGeneration: next.generation, manifest: manifest() })).toBe(false);
  });
  it('rejects another work item, unknown property, invalid room or inactive child', () => {
    const a = add(null, null);
    expect(() => add(a, a.generation, first, { ...context, source: { ...source, transportId: 'other' } }))
      .toThrow('batch_choice_source_mismatch');
    expect(() => add(null, null, first, { ...context, propertyCode: 'UNKNOWN' })).toThrow('batch_choice_invalid');
    expect(() => add(null, null, { ...first, roomType: 'NOPE' })).toThrow('batch_choice_invalid');
    expect(() => updatePaneBatchChoiceSnapshot({ previous: null, expectedGeneration: null, context, choice: first,
      actorUserId: 'staff', selected: [first.identity], isActiveChild: () => false })).toThrow('batch_choice_invalid');
  });
  it('rejects mismatched source, extraction, room, generation and duplicate identities', () => {
    const a = add(null, null), b = add(a, a.generation, second), m = manifest();
    const check = (snapshot: unknown, ctx = current(b), generation = b.generation, candidate: unknown = m) =>
      matchesPaneBatchChoices({ snapshot, context: ctx, expectedGeneration: generation, manifest: candidate });
    expect(check(b, { ...current(b), cursor: { ...b.cursor, extractionId: '33333333-3333-4333-8333-333333333333' } })).toBe(false);
    expect(check(b, { ...current(b), source: { ...source, messageId: 'other' } })).toBe(false);
    expect(check(b, current(b), a.generation)).toBe(false);
    const changed = structuredClone(m); changed.rooms[1]!.roomType = 'STQN';
    expect(check(b, current(b), b.generation, changed)).toBe(false);
    expect(check({ ...b, choices: [...b.choices, b.choices[0]] })).toBe(false);
  });
  it('preserves pane history, advances sequence and prunes deselected children', () => {
    const a = add(null, null), b = add(a, a.generation, second);
    expect(b.cursor).toMatchObject({ revision: cursor.revision, revisionHead: cursor.revisionHead, seq: cursor.seq + 2 });
    const third = { identity: { ...first.identity, roomIndex: 3 }, roomType: 'STQN' };
    const c = add(b, b.generation, third, current(b), [second.identity, third.identity]);
    expect(c.choices.map((choice) => choice.identity.roomIndex)).toEqual([2, 3]);
  });
  it('changes the digest whenever the child choices change', () => {
    const a = add(null, null), b = add(a, a.generation, second);
    expect(paneBatchChoiceDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(paneBatchChoiceDigest(a)).not.toBe(paneBatchChoiceDigest(b));
  });
});
