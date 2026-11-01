import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  events: [] as string[],
  context: {},
  guardContexts: [] as unknown[],
  recordCalls: [] as unknown[],
  selection: {
    outcome: 'selected_unsaved', nativeId: '90210', searchId: 'org-search-1',
    displayedOrganization: 'Synthetic Company', profileProofToken: 'profile-proof-1',
    nativeIdEvidence: 'form_change_response', selectedField: { name: 'company', value: 'Synthetic Company' },
  },
  saved: { outcome: 'saved_same_form', confirmation: '1234567-1' },
}));

vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', () => ({
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>) => {
    fixtures.events.push('context-open');
    return operation({ context: () => fixtures.context });
  },
}));
vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', () => ({
  installReadOnlyGuard: async (context: unknown) => {
    fixtures.guardContexts.push(context);
    fixtures.events.push('guard');
  },
}));
vi.mock('../tooling/hms-cloud/stay360-confirmation.mjs', () => ({
  readConfirmationFromStay360: async (_page: unknown, confirmation: string) => {
    fixtures.events.push('confirmation');
    return { confirmation };
  },
}));
vi.mock('../tooling/hms-cloud/stay360-record-view.mjs', () => ({
  readRecordViewFromStay360: async () => { fixtures.events.push('record-view'); },
}));
vi.mock('../tooling/hms-cloud/labtest-record.mjs', () => ({
  currentLabtestRecord: async (_page: unknown, expected: unknown, options: unknown) => {
    fixtures.events.push('labtest-record');
    fixtures.recordCalls.push({ expected, options });
    return { partyPreimage: { companyid: '90210', company: 'Synthetic Company' } };
  },
}));
vi.mock('../tooling/hms-cloud/guest-stay-save.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tooling/hms-cloud/guest-stay-save.mjs')>(),
  saveNewLabtestStay: async () => fixtures.saved,
}));
vi.mock('../tooling/hms-cloud/lookup.mjs', () => {
  const unused = async () => ({ outcome: 'input_gap' });
  return {
    openNewGuestStay: unused, searchPrimaryBookingAgency: unused, searchOrganization: unused,
    searchArAccount: unused, selectBookingAgency: unused, selectPrimaryBookingAgency: unused,
    selectOrganization: async () => fixtures.selection, selectArAccount: unused,
    closeGuestStayPartyPicker: unused,
  };
});

import { runBookingLookupTool } from '../tooling/hms-cloud/booking-lookup-session.mjs';

describe('organization readback fresh-context guard', () => {
  beforeEach(() => {
    fixtures.events.length = 0;
    fixtures.guardContexts.length = 0;
    fixtures.recordCalls.length = 0;
  });

  it('installs the read-only fence before searching the saved confirmation', async () => {
    const page = {};
    const session = { page, labtestPreimage: { outcome: 'clear', preimageId: 'preimage-1' } };
    await runBookingLookupTool(session, { tool: 'selectOrganization', nativeId: '90210', searchId: 'org-search-1' });
    await runBookingLookupTool(session, {
      tool: 'saveNewLabtestStay', preimageId: 'preimage-1', guestId: '45678',
      arrival: '2027-01-25', departure: '2027-01-27', roomType: 'DLXKNG', ratePlan: 'BAR',
      guaranteeType: 'NGI', note: 'synthetic org create', organizationSelection: fixtures.selection,
    });

    fixtures.events.length = 0;
    const read = await runBookingLookupTool({ page }, {
      tool: 'readSavedLabtestRecord', confirmation: fixtures.saved.confirmation,
    });

    expect(read).toMatchObject({ outcome: 'read_back_verified', organization: {
      nativeId: '90210', name: 'Synthetic Company',
    } });
    expect(fixtures.guardContexts).toEqual([fixtures.context]);
    expect(fixtures.events).toEqual(['context-open', 'guard', 'confirmation', 'record-view', 'labtest-record']);
    expect(fixtures.recordCalls).toEqual([{
      expected: {
        confirmation: '1234567-1', guestId: '45678', arrival: '2027-01-25', departure: '2027-01-27',
        roomType: 'DLXKNG', ratePlan: 'BAR', note: 'synthetic org create',
      },
      options: { allowUnchangedBusinessParties: true,
        expectedOrganization: { nativeId: '90210', name: 'Synthetic Company' } },
    }]);
  });
});
