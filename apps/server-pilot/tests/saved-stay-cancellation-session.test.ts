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

vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', () => ({
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>, options?: { headless?: boolean; signal?: AbortSignal }) => {
    fixtures.pageOptions = options;
    return operation({ context: () => ({}), on: () => {} });
  },
}));
vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', () => ({
  installReadOnlyGuard: async () => {},
}));
vi.mock('../tooling/hms-cloud/hms-readers.mjs', () => ({
  readShallow: fixtures.readShallow,
  readRecord: fixtures.readRecord,
}));
vi.mock('../tooling/hms-cloud/guest-stay-cancel.mjs', () => ({
  openLabtestCancellation: fixtures.openCancel,
  confirmLabtestCancellation: fixtures.confirmCancel,
}));
vi.mock('../tooling/hms-cloud/guest-stay-amend.mjs', () => ({
  amendLabtestNote: vi.fn(),
}));

import { withSavedStayAgentSession } from '../tooling/hms-cloud/saved-stay-agent-session.mjs';

describe('saved-stay cancellation preparation', () => {
  it('passes the execution abort signal through to the page owner', async () => {
    const controller = new AbortController();
    await withSavedStayAgentSession(async () => undefined, { signal: controller.signal });
    expect(fixtures.pageOptions).toMatchObject({ headless: true, signal: controller.signal });
  });

  it('requires a full read and uses a private snapshot without entering cancellation', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      expect(await runTool({ tool: 'prepareCancellation' })).toMatchObject({
        outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED',
      });
      expect(await runTool({ tool: 'prepareFinance' })).toMatchObject({
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

  it('prepares a privacy-reduced display-only finance view from the exact current read', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: fixtures.confirmation });
      const result = await runTool({ tool: 'prepareFinance' });
      expect(result).toMatchObject({
        outcome: 'prepared_for_human_review',
        target: { confirmation: fixtures.confirmation, verified: true },
        recordView: {
          basis: 'stay360_display_only_not_ledger',
          balance: { amount: { state: 'observed_zero', value: '0.00' }, currency: { value: 'ZAR' } },
          depositReceived: { amount: { state: 'observed', value: '125.00' } },
          depositDue: { amount: { state: 'observed', value: '300.00' } },
        },
        folioCard: {
          basis: '1a_folio_card_display_only',
          balance: { state: 'observed', value: 'R1,234.50' },
          depositReceived: { state: 'observed_zero', value: 'R0.00' },
        },
        interpretation: {
          ledgerBalance: 'not_established',
          depositCleared: 'not_established',
          depositDue: 'not_verified',
          transactionHistory: 'not_read',
        },
      });
      expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
      expect(JSON.stringify(result)).not.toContain('TEST-GUEST-NAME');
      expect(fixtures.openCancel).not.toHaveBeenCalled();
      expect(fixtures.confirmCancel).not.toHaveBeenCalled();
    });
  });

  it('reports invalid requested scope without consuming the current read', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
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
