import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const confirmation = '12345678-1';
  const shallow = {
    ok: true,
    confirmation,
    searchResults: { displayed: 1, total: 1, complete: true },
    details: {
      confirmationInHeader: confirmation,
      cards: [
        { title: 'Stay', fields: [{ name: 'status', value: 'Reserved' }] },
        { title: 'Folio', fields: [
          { name: 'foliobalance', value: 'R1,234.50' },
          { name: 'depositreceived', value: 'R0.00' },
          { name: 'depositamount', value: 'R500.00' },
          { name: 'depositduedate', value: 'Tue 02-Feb-2027' },
        ] },
      ],
      visibleFormFields: [],
    },
  };
  const record = {
    details: {
      confirmationInRecord: confirmation,
      activeTab: 'Record View',
      fields: [
        { name: 'status', value: 'Reserved' },
        { name: 'arrivaldate', value: '2027-02-03' },
        { name: 'departuredate', value: '2027-02-05' },
        { name: 'nights', value: '2' },
        { name: 'balance', value: '0.00' },
        { name: 'balancecurr', value: 'ZAR' },
        { name: 'depositreceived', value: '125.00' },
        { name: 'depositreceivedcurrency', value: 'ZAR' },
        { name: 'udfchar02', value: '300.00' },
        { name: 'udfdate02', value: '2027-02-01' },
        { name: 'firstname', value: 'TEST-GUEST-NAME', section: 'Guest' },
      ],
    },
  };
  return {
    confirmation, shallow, record,
    readShallow: vi.fn(async () => structuredClone(shallow)),
    readRecord: vi.fn(async () => structuredClone(record)),
    openCancel: vi.fn(),
    confirmCancel: vi.fn(),
    pageOptions: undefined as { headless?: boolean; signal?: AbortSignal } | undefined,
  };
});

vi.mock('../tooling/hms-cloud/cloud-session.mjs', () => ({
  withCloudReadSession: async (operation: (page: unknown, identity: unknown) => Promise<unknown>, options?: { signal?: AbortSignal; prepareContext?: (context: unknown) => Promise<void> }) => {
    fixtures.pageOptions = options;
    await options?.prepareContext?.({});
    return operation({ on: () => {}, off: () => {} }, { propertyCode: 'HRCEN', tenantId: 'THECENTURION_PRD',
      landingPropertyCode: 'HRCEN', origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' });
  },
}));
vi.mock('../tooling/hms-cloud/saved-stay-read-guard.mjs', () => ({ installSavedStayReadGuard: vi.fn() }));
vi.mock('../tooling/hms-cloud/stay360-confirmation.mjs', () => ({ readConfirmationFromStay360: fixtures.readShallow }));
vi.mock('../tooling/hms-cloud/stay360-record-view.mjs', () => ({ readRecordViewFromStay360: fixtures.readRecord }));
import { withSavedStayAgentSession } from '../tooling/hms-cloud/saved-stay-agent-session.mjs';

const withTestSession = (operation: Parameters<typeof withSavedStayAgentSession>[0], options: Record<string, unknown> = {}) =>
  withSavedStayAgentSession(operation, { readOnly: true, readOnlyConfirmation: fixtures.confirmation, propertyCode: 'HRCEN', ...options });

describe('saved-stay cancellation preparation', () => {
  it('passes the execution abort signal through to the page owner', async () => {
    const controller = new AbortController();
    await withTestSession(async () => undefined, { signal: controller.signal });
    expect(fixtures.pageOptions).toMatchObject({ propertyCode: 'HRCEN', startScreen: 'OSRESS', signal: controller.signal });
  });

  it('requires a full read and uses a private snapshot without entering cancellation', async () => {
    await withTestSession(async ({ runTool }) => {
      expect(await runTool({ tool: 'prepareCancellation' })).toMatchObject({
        outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED',
      });
      const read = await runTool({ tool: 'read', confirmation: fixtures.confirmation });
      expect(read.outcome).toBe('ok');
      read.record.details.fields[0].value = 'Cancelled';
      read.shallow.confirmation = 'changed-by-caller';
      const result = await runTool({ tool: 'prepareCancellation', requestedScope: 'specific_room' });
      expect(result).toMatchObject({
        outcome: 'prepared_for_human_review',
        target: { confirmation: fixtures.confirmation, verified: true },
        stay: { status: { state: 'observed', value: 'Reserved' } },
        roomScope: { requested: 'specific_room', complete: false },
        action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
      });
      expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
      expect(fixtures.openCancel).not.toHaveBeenCalled();
      expect(fixtures.confirmCancel).not.toHaveBeenCalled();
    });
  });

  it('reports invalid requested scope without consuming the current read', async () => {
    await withTestSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: fixtures.confirmation });
      expect(await runTool({ tool: 'prepareCancellation', requestedScope: 'everywhere' })).toMatchObject({
        outcome: 'input_gap', issue: 'REQUESTED_SCOPE_INVALID',
      });
      expect(await runTool({ tool: 'prepareCancellation' })).toMatchObject({
        outcome: 'prepared_for_human_review', roomScope: { requested: 'unspecified' },
      });
    });
  });
});
