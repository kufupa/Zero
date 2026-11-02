import { describe, expect, it } from 'vitest';
import { createReservation } from '../tooling/hms-cloud/create-reservation.mjs';

// A synthetic tool adapter exercises the create wrapper, not the native HMS UI.
type Guest = { nativeId: string; firstName: string; lastName: string };
type ToolCall = { tool: string; searchId?: string; offset?: number; limit?: number; nativeId?: string };

const requestedGuest = { firstName: 'First', lastName: 'Guest' };
const prepare = { mode: 'prepare', propertyCode: 'HRCEN', guest: { search: requestedGuest } };
const guest = (nativeId: string, firstName = 'Other'): Guest => ({
  nativeId, firstName, lastName: 'Guest',
});

function syntheticSession(rows: Guest[], closeOutcome = 'closed_unsaved') {
  const calls: ToolCall[] = [];
  let selected: Guest | undefined;
  const runTool = async (request: ToolCall) => {
    calls.push(structuredClone(request));
    switch (request.tool) {
      case 'searchGuestProfiles':
        return {
          outcome: rows.length ? 'matches' : 'no_match', searchId: 'guest-search',
          candidates: rows.slice(0, 25), hasMoreLoaded: rows.length > 25,
          coverage: { loaded: rows.length, total: rows.length, possiblyTruncated: false },
          correlation: { verifiedFields: ['firstname', 'lastname'] },
        };
      case 'inspectGuestProfileCandidates':
        return {
          outcome: 'current', searchId: request.searchId,
          candidates: rows.slice(request.offset, (request.offset ?? 0) + (request.limit ?? 0)),
        };
      case 'closeGuestProfilePicker':
        return closeOutcome === 'closed_unsaved' ? { outcome: closeOutcome }
          : { outcome: closeOutcome, issue: 'GUEST_PICKER_CLOSE_FAILED' };
      case 'selectGuestProfile':
        selected = rows.find((row) => row.nativeId === request.nativeId);
        return { outcome: 'selected_unsaved', nativeId: request.nativeId };
      case 'readGuestStayForm':
        return { outcome: 'ok', fields: selected ? [
          { name: 'guestid', value: selected.nativeId },
          { name: 'firstname', value: selected.firstName },
          { name: 'lastname', value: selected.lastName },
          { name: 'emailaddress', value: '' },
        ] : [] };
      default:
        throw new Error(`Unexpected synthetic tool: ${request.tool}`);
    }
  };
  return {
    calls,
    withSession: async (operation: (session: { runTool: typeof runTool }) => Promise<unknown>) =>
      operation({ runTool }),
  };
}

describe('first-time guest lookup safety', () => {
  it('keeps a verified empty search unresolved and closes the picker without creating a profile', async () => {
    const session = syntheticSession([]);
    const result = await createReservation(prepare, { withSession: session.withSession });

    expect(result.outcome).toBe('needs_input');
    expect(result.issue).toBe('guest_not_found');
    expect(result.missing).toContain('guest');
    expect(result.approvalReady).toBe(false);
    expect(session.calls.map(({ tool }) => tool)).toEqual([
      'searchGuestProfiles', 'closeGuestProfilePicker', 'readGuestStayForm',
    ]);
  });

  it('does not continue when the empty-search picker fails to close', async () => {
    const session = syntheticSession([], 'execution_failure');
    const result = await createReservation(prepare, { withSession: session.withSession });

    expect(result.outcome).toBe('uncertain');
    expect(result.issue).toBe('GUEST_PICKER_CLOSE_FAILED');
    expect(result.approvalReady).toBe(false);
    expect(session.calls.map(({ tool }) => tool)).toEqual([
      'searchGuestProfiles', 'closeGuestProfilePicker',
    ]);
  });

  it('refuses a duplicate beyond the initial results rather than selecting the visible match', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => guest(String(index), `Other${index}`));
    rows[0] = guest('0', 'First');
    rows[50] = guest('50', 'First');
    const session = syntheticSession(rows);
    const result = await createReservation(prepare, { withSession: session.withSession });

    expect(result.outcome).toBe('needs_input');
    expect(result.issue).toBe('guest_ambiguous');
    expect(result.approvalReady).toBe(false);
    expect(result.guestCandidates).toHaveLength(51);
    expect(session.calls.filter(({ tool }) => tool === 'inspectGuestProfileCandidates')).toEqual([
      { tool: 'inspectGuestProfileCandidates', searchId: 'guest-search', offset: 0, limit: 50 },
      { tool: 'inspectGuestProfileCandidates', searchId: 'guest-search', offset: 50, limit: 50 },
    ]);
    expect(session.calls.some(({ tool }) => tool === 'selectGuestProfile' || tool === 'saveNewLabtestStay')).toBe(false);
    expect(session.calls.some(({ tool }) => tool === 'closeGuestProfilePicker')).toBe(true);
  });

  it('selects an existing unique match found after the initial results without saving', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => guest(String(index), `Other${index}`));
    rows[50] = guest('50', 'First');
    const session = syntheticSession(rows);
    const result = await createReservation(prepare, { withSession: session.withSession });

    expect(result.approvalReady).toBe(false);
    expect(result.applied.guest).toMatchObject({ nativeId: '50', ...requestedGuest });
    expect(session.calls.find(({ tool }) => tool === 'selectGuestProfile')).toEqual({
      tool: 'selectGuestProfile', searchId: 'guest-search', nativeId: '50',
    });
    expect(session.calls.some(({ tool }) => tool === 'saveNewLabtestStay')).toBe(false);
  });
});
