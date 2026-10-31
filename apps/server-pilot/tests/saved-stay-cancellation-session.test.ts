import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const confirmation = '12345678-1';
  const shallow = {
    ok: true,
    confirmation,
    searchResults: { displayed: 1, total: 1, complete: true },
    details: {
      confirmationInHeader: confirmation,
      cards: [{ title: 'Stay', fields: [{ name: 'status', value: 'Reserved' }] }],
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
      ],
    },
  };
  return {
    confirmation, shallow, record,
    readShallow: vi.fn(async () => structuredClone(shallow)),
    readRecord: vi.fn(async () => structuredClone(record)),
    openCancel: vi.fn(),
    confirmCancel: vi.fn(),
  };
});

vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', () => ({
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>) =>
    operation({ context: () => ({}), on: () => {} }),
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
  it('requires a full read and uses a private snapshot without entering cancellation', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
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
