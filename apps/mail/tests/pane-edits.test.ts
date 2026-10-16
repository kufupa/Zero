/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DRAFT_GROUP_ID } from '../lib/quote-workflow/session';
import {
  overlayRememberedGroups,
  paneEditKey,
  recalledPaneEdits,
  rememberPaneEdits,
  resetPaneEditsForTests,
} from '../lib/quote-workflow/pane-edits';
import type { StayGroupRequirement } from '../lib/quote-workflow/types';

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
  });
});
