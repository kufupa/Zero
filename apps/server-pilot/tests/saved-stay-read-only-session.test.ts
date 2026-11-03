import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  order: [] as string[],
  genericGuard: vi.fn(),
  strictGuard: vi.fn(),
  readShallow: vi.fn(async (_page: unknown, confirmation: string) => ({ confirmation })),
  readRecord: vi.fn(async () => ({ details: { fields: [{ name: 'status', value: 'Reserved' }] } })),
}));

vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', () => ({
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) => {
    fixtures.options = options;
    const context = {};
    if (typeof options.prepareContext === 'function') {
      fixtures.order.push('preparing');
      await (options.prepareContext as (context: unknown) => Promise<void>)(context);
    }
    fixtures.order.push('page');
    return operation({ context: () => context, on: () => {} });
  },
}));
vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', () => ({ installReadOnlyGuard: fixtures.genericGuard }));
vi.mock('../tooling/hms-cloud/saved-stay-read-guard.mjs', () => ({ installSavedStayReadGuard: fixtures.strictGuard }));
vi.mock('../tooling/hms-cloud/hms-readers.mjs', () => ({ readShallow: fixtures.readShallow, readRecord: fixtures.readRecord }));

import { withSavedStayAgentSession } from '../tooling/hms-cloud/saved-stay-agent-session.mjs';

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.options = undefined;
  fixtures.order = [];
  fixtures.strictGuard.mockImplementation(async () => { fixtures.order.push('guard'); });
});

describe('strict saved-stay read session', () => {
  it('installs its fence before the page and refuses every non-read tool', async () => {
    await withSavedStayAgentSession(async ({ runTool }) => {
      expect(await runTool({ tool: 'read', confirmation: '123-1' })).toMatchObject({ outcome: 'ok' });
      expect(await runTool({ tool: 'read', confirmation: '999-1' })).toMatchObject({
        outcome: 'refused', issue: 'READ_ONLY_CONFIRMATION_MISMATCH' });
      for (const tool of ['prepareCancellation', 'prepareFinance', 'amendNote', 'amendContact',
        'openCancel', 'confirmCancel', 'readAmendmentAvailability', 'searchHotelAvailabilityParty',
        'selectHotelAvailabilityParty', 'cancelHotelAvailabilityParty']) {
        expect(await runTool({ tool })).toMatchObject({ outcome: 'refused', issue: 'READ_ONLY_SESSION' });
      }
    }, { readOnly: true, readOnlyConfirmation: '123-1' });
    expect(fixtures.options).toMatchObject({ headless: true, blockServiceWorkers: true });
    expect(fixtures.order).toEqual(['preparing', 'guard', 'page']);
    expect(fixtures.strictGuard).toHaveBeenCalledOnce();
    expect(fixtures.genericGuard).not.toHaveBeenCalled();
    expect(fixtures.readShallow).toHaveBeenCalledOnce();
    expect(fixtures.readRecord).toHaveBeenCalledOnce();
  });

  it('leaves the existing writable-session setup unchanged', async () => {
    await withSavedStayAgentSession(async () => undefined);
    expect(fixtures.order).toEqual(['page']);
    expect(fixtures.options).not.toHaveProperty('prepareContext');
    expect(fixtures.genericGuard).toHaveBeenCalledOnce();
    expect(fixtures.strictGuard).not.toHaveBeenCalled();
  });
});
