import { describe, expect, it } from 'vitest';
import { createReservation } from '../tooling/hms-cloud/create-reservation.mjs';

// Synthetic tools exercise the create wrapper, not the native HMS UI or a save.
type Guest = { nativeId: string; firstName: string; lastName: string };
type ToolCall = { tool: string; searchId?: string; offset?: number; limit?: number; nativeId?: string;
  propertyCode?: string; field?: string; value?: string };
type Options = { closeOutcome?: string; omitGuestId?: boolean; initialGuestId?: string;
  initialFirst?: string; initialLast?: string; changeGuestIdAfterFirst?: boolean;
  mismatchAfterLast?: boolean; mismatchOnFinal?: boolean; possiblyTruncated?: boolean; failFirst?: boolean;
  failLast?: boolean; malformedAfterFirst?: boolean; duplicateGuestId?: boolean; disabledFirst?: boolean;
  searchOutcome?: string; serverMoreRecords?: boolean | null; reportedTotal?: number };
const requestedGuest = { firstName: 'First', lastName: 'Guest' };
const prepare = { mode: 'prepare', propertyCode: 'HRCEN', guest: { search: requestedGuest } };
const guest = (nativeId: string, firstName = 'Other'): Guest => ({ nativeId, firstName, lastName: 'Guest' });

function syntheticSession(rows: Guest[], options: Options = {}) {
  const calls: ToolCall[] = [];
  let selected: Guest | undefined;
  let guestId = options.initialGuestId ?? '';
  let firstName = options.initialFirst ?? '';
  let lastName = options.initialLast ?? '';
  let lastWritten = false;
  let reads = 0;
  const runTool = async (request: ToolCall) => {
    calls.push(structuredClone(request));
    switch (request.tool) {
      case 'searchGuestProfiles':
        return {
          outcome: options.searchOutcome ?? (rows.length ? 'matches' : 'no_match'), searchId: 'guest-search',
          candidates: rows.slice(0, 25), hasMoreLoaded: rows.length > 25,
          coverage: { loaded: rows.length, total: options.reportedTotal ?? rows.length,
            serverMoreRecords: options.serverMoreRecords === undefined ? false : options.serverMoreRecords,
            possiblyTruncated: options.possiblyTruncated ?? false },
          correlation: { verifiedFields: ['firstname', 'lastname'] },
        };
      case 'inspectGuestProfileCandidates':
        return { outcome: 'current', searchId: request.searchId,
          candidates: rows.slice(request.offset, (request.offset ?? 0) + (request.limit ?? 0)) };
      case 'closeGuestProfilePicker':
        return !options.closeOutcome ? { outcome: 'closed_unsaved' }
          : { outcome: options.closeOutcome, issue: 'GUEST_PICKER_CLOSE_FAILED' };
      case 'selectGuestProfile':
        selected = rows.find((row) => row.nativeId === request.nativeId);
        return { outcome: 'selected_unsaved', nativeId: request.nativeId };
      case 'setGuestStayText':
        if (request.field === 'firstName') {
          if (options.failFirst) return { outcome: 'uncertain', issue: 'TEXT_ACTION_UNCERTAIN' };
          firstName = request.value ?? '';
          if (options.changeGuestIdAfterFirst) guestId = 'profile-19';
        } else if (request.field === 'lastName') {
          if (options.failLast) return { outcome: 'input_gap', issue: 'TEXT_FIELD_UNSUPPORTED' };
          lastName = request.value ?? '';
          lastWritten = true;
        } else throw new Error(`Unexpected field: ${request.field}`);
        return { outcome: 'updated_unsaved', field: request.field, requested: request.value, actual: request.value };
      case 'readGuestStayForm':
        reads++;
        if (options.malformedAfterFirst && reads === 2) return { outcome: 'ok', fields: {} };
        return { outcome: 'ok', fields: [
          ...(!options.omitGuestId ? [{ name: 'guestid', value: selected?.nativeId ?? guestId }] : []),
          ...(options.duplicateGuestId ? [{ name: 'guestid', value: '' }] : []),
          { name: 'firstname', value: selected?.firstName ?? firstName, disabled: options.disabledFirst ?? false, readOnly: false },
          { name: 'lastname', value: selected?.lastName ?? (lastWritten && (options.mismatchAfterLast || (options.mismatchOnFinal && reads === 4)) ? 'Changed' : lastName), disabled: false, readOnly: false },
          { name: 'emailaddress', value: '' },
        ] };
      default: throw new Error(`Unexpected synthetic tool: ${request.tool}`);
    }
  };
  return { calls, withSession: async (operation: (session: { runTool: typeof runTool }) => Promise<unknown>) =>
    operation({ runTool }) };
}

const names = (session: ReturnType<typeof syntheticSession>) => session.calls.map(({ tool }) => tool);

describe('first-time guest lookup safety', () => {
  it('stages names only after a verified empty search and closed picker while keeping guest unresolved', async () => {
    const session = syntheticSession([]);
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('needs_input');
    expect(result.issue).toBe('guest_not_found');
    expect(result.missing).toContain('guest');
    expect(result.approvalReady).toBe(false);
    expect(result.applied.guest).toBeUndefined();
    expect(result.guestNameDraft).toMatchObject({ firstName: 'First', lastName: 'Guest', profileStatus: 'unverified' });
    expect(names(session)).toEqual(['searchGuestProfiles', 'closeGuestProfilePicker', 'readGuestStayForm',
      'setGuestStayText', 'readGuestStayForm', 'setGuestStayText', 'readGuestStayForm', 'readGuestStayForm']);
    expect(session.calls.filter(({ tool }) => tool === 'setGuestStayText')).toEqual([
      { tool: 'setGuestStayText', propertyCode: 'HRCEN', field: 'firstName', value: 'First' },
      { tool: 'setGuestStayText', propertyCode: 'HRCEN', field: 'lastName', value: 'Guest' },
    ]);
  });

  it.each(['NGI', 'GTDAGT'])('does not treat staged name text as a verified guest for %s guarantee', async (guaranteeType) => {
    const session = syntheticSession([]);
    const result = await createReservation({ ...prepare, guaranteeType }, { withSession: session.withSession });
    expect(result.outcome).toBe('needs_input');
    expect(result.approvalReady).toBe(false);
    expect(result.missing).toContain('guest');
    expect(result.missing).toContain('guaranteeType.staging');
    expect(result.guestNameDraft).toMatchObject({ ...requestedGuest, profileStatus: 'unverified' });
    expect(names(session)).not.toContain('selectGuestStayDropdown');
    expect(names(session)).not.toContain('saveNewLabtestStay');
  });

  it('does not continue when the empty-search picker fails to close', async () => {
    const session = syntheticSession([], { closeOutcome: 'execution_failure' });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.issue).toBe('GUEST_PICKER_CLOSE_FAILED');
    expect(result.approvalReady).toBe(false);
    expect(names(session)).toEqual(['searchGuestProfiles', 'closeGuestProfilePicker']);
  });

  it.each<[string, Options]>([
    ['missing guest ID', { omitGuestId: true }],
    ['duplicate guest ID', { duplicateGuestId: true }],
    ['disabled first name', { disabledFirst: true }],
    ['nonblank guest ID', { initialGuestId: 'profile-19' }],
    ['nonblank first name', { initialFirst: 'Existing' }],
    ['nonblank last name', { initialLast: 'Existing' }],
    ['incomplete search', { possiblyTruncated: true }],
    ['unknown more-records marker', { serverMoreRecords: null }],
    ['nonzero search total', { reportedTotal: 1 }],
    ['nonempty search outcome', { searchOutcome: 'matches' }],
  ])('does not stage on %s', async (_label, options) => {
    const session = syntheticSession([], options);
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.approvalReady).toBe(false);
    expect(result.applied.guest).toBeUndefined();
    expect(result.guestNameDraft).toBeUndefined();
    expect(names(session)).not.toContain('setGuestStayText');
  });

  it('does not stage if a requested first name is absent', async () => {
    const session = syntheticSession([]);
    const result = await createReservation({ ...prepare, guest: { search: { lastName: 'Guest' } } }, { withSession: session.withSession });
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
    expect(names(session)).not.toContain('setGuestStayText');
  });

  it('stops on an uncertain first-name action without retrying', async () => {
    const session = syntheticSession([], { failFirst: true });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
    expect(session.calls.filter(({ tool }) => tool === 'setGuestStayText')).toHaveLength(1);
  });

  it('reports uncertain when the second edit is refused after the first edit', async () => {
    const session = syntheticSession([], { failLast: true });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
    expect(session.calls.filter(({ tool }) => tool === 'setGuestStayText')).toHaveLength(2);
  });

  it('stops when the intermediate form evidence is malformed', async () => {
    const session = syntheticSession([], { malformedAfterFirst: true });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
    expect(session.calls.filter(({ tool }) => tool === 'setGuestStayText')).toHaveLength(1);
  });

  it('stops before the second field if guest identity changes', async () => {
    const session = syntheticSession([], { changeGuestIdAfterFirst: true });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
    expect(session.calls.filter(({ tool }) => tool === 'setGuestStayText')).toHaveLength(1);
  });

  it('reports a final name mismatch as uncertain instead of a staged name', async () => {
    const session = syntheticSession([], { mismatchAfterLast: true });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
    expect(session.calls.filter(({ tool }) => tool === 'setGuestStayText')).toHaveLength(2);
  });

  it('checks names again on the final form after both edits', async () => {
    const session = syntheticSession([], { mismatchOnFinal: true });
    const result = await createReservation(prepare, { withSession: session.withSession });
    expect(result.outcome).toBe('uncertain');
    expect(result.approvalReady).toBe(false);
    expect(result.guestNameDraft).toBeUndefined();
  });

  it('never stages a name when email correlation is unverified', async () => {
    const session = syntheticSession([]);
    const result = await createReservation({ ...prepare, guest: { search: { ...requestedGuest, email: 'guest@example.test' } } },
      { withSession: session.withSession });
    expect(result.issue).toBe('guest_email_unverified');
    expect(result.approvalReady).toBe(false);
    expect(names(session)).not.toContain('setGuestStayText');
  });

  it('refuses a duplicate beyond the initial results rather than selecting the visible match', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => guest(String(index), `Other${index}`));
    rows[0] = guest('0', 'First'); rows[50] = guest('50', 'First');
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
    expect(names(session)).not.toContain('selectGuestProfile');
    expect(names(session)).not.toContain('setGuestStayText');
    expect(names(session)).toContain('closeGuestProfilePicker');
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
    expect(names(session)).not.toContain('setGuestStayText');
  });

  it('refuses committing an unapproved real guest before opening a session', async () => {
    const session = syntheticSession([]);
    const result = await createReservation({ ...prepare, mode: 'commit' }, { withSession: session.withSession });
    expect(result.outcome).toBe('refused');
    expect(result.issue).toBe('trusted_staff_create_authorization_unavailable');
    expect(result.approvalReady).toBe(false);
    expect(session.calls).toEqual([]);
  });
});
