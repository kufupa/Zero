/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DRAFT_GROUP_ID } from '../lib/quote-workflow/session';
import { staffQuoteGroupsFromStay } from '../lib/quote-workflow/staff-quote-bind';
import {
  overlayRememberedGroups,
  paneEditKey,
  recalledPaneEdits,
  rememberPaneEdits,
  resetPaneEditsForTests,
} from '../lib/quote-workflow/pane-edits';
import { HRCEN_PROPERTY_CODE, HRDAV_PROPERTY_CODE, type StayGroupRequirement } from '../lib/quote-workflow/types';

const GROUP: StayGroupRequirement = {
  id: 'r_1',
  stayId: 's_1',
  arrivalDate: '2026-11-03',
  departureDate: '2026-11-05',
  quantity: 2,
  adults: 3,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: { adults: 'staff_corrected' },
};

afterEach(() => {
  resetPaneEditsForTests();
  sessionStorage.clear();
});

describe('pane edits', () => {
  it('remembers groups by transport and message, including after the in-memory map is dropped', () => {
    const key = paneEditKey('transport-1', '<quote-request@example.invalid>');
    rememberPaneEdits(key, [GROUP]);
    expect(recalledPaneEdits(key)?.[0]?.adults).toBe(3);

    resetPaneEditsForTests({ keepSession: true });
    expect(recalledPaneEdits(key)?.[0]?.adults).toBe(3);
    expect(recalledPaneEdits(paneEditKey('transport-1', '<other@example.invalid>'))).toBeNull();
  });

  it('lays remembered rows over a fresh analysis so an email switch does not drop the edit', () => {
    const extracted = { ...GROUP, adults: 2, fields: { adults: 'extracted' as const } };
    expect(overlayRememberedGroups([extracted], [GROUP])).toEqual([GROUP]);
    expect(overlayRememberedGroups([extracted], null)).toEqual([extracted]);
    const draft = { ...GROUP, id: DRAFT_GROUP_ID };
    expect(overlayRememberedGroups([extracted], [draft])).toEqual([extracted]);
    const extra = { ...GROUP, id: 'r_2', adults: 1 };
    expect(overlayRememberedGroups([extracted, extra], [GROUP])).toEqual([GROUP]);
  });

  it('treats the saved list as complete, including an empty list after every room is removed', () => {
    const key = paneEditKey('transport-1', '<quote-request@example.invalid>');
    const extracted = { ...GROUP, adults: 2, fields: { adults: 'extracted' as const } };
    const extra = { ...GROUP, id: 'r_2', adults: 1 };
    rememberPaneEdits(key, []);
    expect(recalledPaneEdits(key)).toEqual([]);
    expect(overlayRememberedGroups([extracted, extra], [])).toEqual([]);
    expect(overlayRememberedGroups([extracted, extra], [GROUP])).toEqual([GROUP]);
  });

  it('repairs an old remembered row only from the same saved room and meal preference', () => {
    const old = { ...GROUP, childrenPerRoom: 0, roomPreference: 'Standard Twin' };
    const saved = { ...old, adults: 2, sourcePreference: { roomType: 'Standard Twin', board: null } };
    expect(overlayRememberedGroups([saved], [old], true)).toEqual([{ ...old, sourcePreference: saved.sourcePreference }]);
    expect(overlayRememberedGroups([saved], [old])).toEqual([old]);
    const restored = overlayRememberedGroups([saved], [old], true);
    expect(staffQuoteGroupsFromStay(restored, HRCEN_PROPERTY_CODE)).toMatchObject({
      ok: [{ sourcePreference: saved.sourcePreference, childrenPerRoom: 0 }],
    });
    const davinci = staffQuoteGroupsFromStay(restored, HRDAV_PROPERTY_CODE);
    expect(davinci).toHaveProperty('ok');
    if ('ok' in davinci) expect(davinci.ok[0]).not.toHaveProperty('sourcePreference');
    for (const mismatch of [
      { ...saved, roomPreference: 'King' },
      { ...saved, board: 'dinner_bb' as const },
      { ...saved, stayId: 'other' },
      { ...saved, sourcePreference: undefined },
    ]) expect(overlayRememberedGroups([mismatch], [old], true)).toEqual([old]);
    expect(overlayRememberedGroups([saved, saved], [old], true)).toEqual([old]);
    const alreadyBound = { ...old, sourcePreference: { roomType: 'Earlier', board: null } };
    expect(overlayRememberedGroups([saved], [alreadyBound], true)).toEqual([alreadyBound]);
  });
});
