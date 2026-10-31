import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  confirmation: 'LABTEST-1',
  amend: vi.fn(),
  readShallow: vi.fn(async () => ({ ok: true, confirmation: 'LABTEST-1' })),
  readRecord: vi.fn(async () => ({ details: { fields: [{ name: 'status', value: 'Reserved' }] } })),
}));

vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', () => ({
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>) =>
    operation({ context: () => ({}), on: () => {} }),
}));
vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', () => ({ installReadOnlyGuard: async () => {} }));
vi.mock('../tooling/hms-cloud/hms-readers.mjs', () => ({ readShallow: fixture.readShallow, readRecord: fixture.readRecord }));
vi.mock('../tooling/hms-cloud/guest-stay-amend-contact.mjs', () => ({ amendLabtestContact: fixture.amend }));
vi.mock('../tooling/hms-cloud/guest-stay-amend.mjs', () => ({ amendLabtestNote: vi.fn() }));
vi.mock('../tooling/hms-cloud/guest-stay-cancel.mjs', () => ({ openLabtestCancellation: vi.fn(), confirmLabtestCancellation: vi.fn() }));

import { withSavedStayAgentSession } from '../tooling/hms-cloud/saved-stay-agent-session.mjs';

describe('saved-stay Booker contact session', () => {
  it('requires the current matching reserved record and seals after dispatch', async () => {
    fixture.amend.mockReset().mockResolvedValue({ outcome: 'awaiting_readback' });
    await withSavedStayAgentSession(async ({ runTool }) => {
      expect(await runTool({ tool: 'amendContact' })).toMatchObject({ outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' });
      expect((await runTool({ tool: 'read', confirmation: fixture.confirmation })).outcome).toBe('ok');
      expect(await runTool({ tool: 'amendContact', expected: { confirmation: 'OTHER' } })).toMatchObject({ outcome: 'refused', issue: 'CURRENT_RECORD_MISMATCH' });
      const expected = { confirmation: fixture.confirmation, guestId: 'fake' };
      expect(await runTool({ tool: 'amendContact', expected, field: 'bookerContact', value: 'Synthetic' })).toMatchObject({ outcome: 'awaiting_readback' });
      expect(fixture.amend).toHaveBeenCalledTimes(1);
      expect(fixture.amend.mock.calls[0]!.slice(1)).toEqual([expected, { field: 'bookerContact', value: 'Synthetic' }]);
      expect(await runTool({ tool: 'read', confirmation: fixture.confirmation })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
    });
  });

  it('allows input correction but seals on an uncertain writer failure', async () => {
    fixture.amend.mockReset().mockResolvedValueOnce({ outcome: 'input_gap', issue: 'CONTACT_VALUE_INVALID' }).mockRejectedValueOnce(new Error('write failed'));
    await withSavedStayAgentSession(async ({ runTool }) => {
      await runTool({ tool: 'read', confirmation: fixture.confirmation });
      const expected = { confirmation: fixture.confirmation };
      expect(await runTool({ tool: 'amendContact', expected, field: 'bookerContact', value: '' })).toMatchObject({ outcome: 'input_gap' });
      expect(await runTool({ tool: 'amendContact', expected, field: 'bookerContact', value: 'Synthetic' })).toMatchObject({ outcome: 'uncertain' });
      expect(await runTool({ tool: 'amendContact', expected, field: 'bookerContact', value: 'Synthetic' })).toMatchObject({ outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' });
    });
  });
});
