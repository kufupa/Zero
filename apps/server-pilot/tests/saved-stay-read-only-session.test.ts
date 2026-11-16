import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  order: [] as string[],
  genericGuard: vi.fn(),
  strictGuard: vi.fn(),
  screenshot: vi.fn(async () => Buffer.from('synthetic')),
  readShallow: vi.fn(async (_page: unknown, confirmation: string) => ({ confirmation })),
  readRecord: vi.fn(async () => ({ details: { fields: [{ name: 'status', value: 'Reserved' }] } })),
}));

vi.mock('../tooling/hms-cloud/cloud-session.mjs', () => ({
  withCloudReadSession: async (operation: (page: unknown, identity: unknown) => Promise<unknown>, options: Record<string, unknown>) => {
    fixtures.options = options;
    const context = {};
    if (typeof options.prepareContext === 'function') {
      fixtures.order.push('preparing');
      await (options.prepareContext as (context: unknown) => Promise<void>)(context);
    }
    fixtures.order.push('page');
    return operation({ on: () => {}, off: () => {}, screenshot: fixtures.screenshot },
      { propertyCode: 'HRCEN', tenantId: 'THECENTURION_PRD', landingPropertyCode: 'HRCEN',
        origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' });
  },
}));
vi.mock('../tooling/hms-cloud/saved-stay-read-guard.mjs', () => ({ installSavedStayReadGuard: fixtures.strictGuard }));
vi.mock('../tooling/hms-cloud/stay360-confirmation.mjs', () => ({ readConfirmationFromStay360: fixtures.readShallow }));
vi.mock('../tooling/hms-cloud/stay360-record-view.mjs', () => ({ readRecordViewFromStay360: fixtures.readRecord }));

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
      for (const tool of ['prepareFinance', 'amendNote', 'amendContact',
        'openCancel', 'confirmCancel', 'readAmendmentAvailability', 'searchHotelAvailabilityParty',
        'selectHotelAvailabilityParty', 'cancelHotelAvailabilityParty']) {
        expect(await runTool({ tool })).toMatchObject({ outcome: 'refused', issue: 'READ_ONLY_SESSION' });
      }
    }, { readOnly: true, readOnlyConfirmation: '123-1', propertyCode: 'HRCEN' });
    expect(fixtures.options).toMatchObject({ propertyCode: 'HRCEN', startScreen: 'OSRESS' });
    expect(fixtures.order).toEqual(['preparing', 'guard', 'page']);
    expect(fixtures.strictGuard).toHaveBeenCalledOnce();
    expect(fixtures.genericGuard).not.toHaveBeenCalled();
    expect(fixtures.readShallow).toHaveBeenCalledOnce();
    expect(fixtures.readRecord).toHaveBeenCalledOnce();
  });

  it('rejects a writable saved-stay session', async () => {
    await expect(withSavedStayAgentSession(async () => undefined)).rejects.toThrow('READ_ONLY_SESSION_REQUIRED');
    expect(fixtures.order).toEqual([]);
  });

  it('captures a record image only after a guarded read opens that record', async () => {
    await withSavedStayAgentSession(async ({ runTool, screenshotRecord }) => {
      await expect(screenshotRecord()).rejects.toThrow('RECORD_SCREENSHOT_UNAVAILABLE');
      await runTool({ tool: 'read', confirmation: '123-1' });
      await expect(screenshotRecord()).resolves.toEqual(Buffer.from('synthetic'));
      expect(fixtures.screenshot).toHaveBeenCalledWith({ fullPage: true });
    }, { readOnly: true, readOnlyConfirmation: '123-1', propertyCode: 'HRCEN' });
    await withSavedStayAgentSession(async ({ screenshotRecord }) => {
      await expect(screenshotRecord()).rejects.toThrow('RECORD_SCREENSHOT_UNAVAILABLE');
    }, { readOnly: true, readOnlyConfirmation: '123-1', propertyCode: 'HRCEN' });
  });
});
