import { describe, expect, it, vi } from 'vitest';
import { runLabtestAmendSave } from '../tooling/hms-cloud/labtest-amend-save.mjs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockPage(delayContextRoute = false) {
  const pageRoutes: Array<(route: any) => Promise<void>> = [];
  const contextRoutes: Array<(route: any) => Promise<void>> = [];
  const contextEntered = deferred(), releaseContext = deferred(), latePageRoute = deferred();
  const context = {
    route: vi.fn(async (_url: string, handler: (route: any) => Promise<void>) => {
      contextRoutes.push(handler);
      contextEntered.resolve();
      if (delayContextRoute) await releaseContext.promise;
    }),
    unroute: vi.fn(),
  };
  const page = {
    context: () => context,
    route: vi.fn(async (_url: string, handler: (route: any) => Promise<void>) => {
      pageRoutes.push(handler);
      if (pageRoutes.length === 2) latePageRoute.resolve();
    }),
    unroute: vi.fn(), on: vi.fn(), off: vi.fn(), locator: vi.fn(),
    waitForResponse: vi.fn(), waitForTimeout: vi.fn(),
  };
  return { page, pageRoutes, contextRoutes, contextEntered, releaseContext, latePageRoute };
}

const callbacks = (save: { click: ReturnType<typeof vi.fn> }, delayContextRoute = false) => ({
  timeoutMs: delayContextRoute ? 100 : 1_000,
  prepare: async () => ({ frame: {}, save }),
  stage: vi.fn(async () => ({ draft: true })),
  matches: vi.fn(() => true),
  validate: vi.fn(async () => ({ ok: false, issue: 'AMEND_DRAFT_CHANGED' })),
});

describe('shared Labtest amendment save lifecycle', () => {
  it('does not click Save when the staged draft is rejected', async () => {
    const { page } = mockPage();
    const save = { click: vi.fn() };
    const result = await runLabtestAmendSave(page as never, callbacks(save));

    expect(result).toMatchObject({ outcome: 'not_dispatched', issue: 'AMEND_DRAFT_CHANGED' });
    expect(save.click).not.toHaveBeenCalled();
  });

  it('quarantines a route chain that finishes installing after timeout and refuses page reuse', async () => {
    const routes = mockPage(true);
    const save = { click: vi.fn() };
    const work = runLabtestAmendSave(routes.page as never, callbacks(save, true));
    await routes.contextEntered.promise;
    const result = await work;

    expect(result).toMatchObject({ outcome: 'not_dispatched', issue: 'AMEND_TIMEOUT' });
    expect(save.click).not.toHaveBeenCalled();

    routes.releaseContext.resolve();
    await routes.latePageRoute.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = {
      url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
      method: () => 'POST', postData: () => '', frame: () => ({}),
    };
    const pageRoute = { request: () => request, fallback: vi.fn(), abort: vi.fn() };
    await routes.pageRoutes[1](pageRoute);
    expect(pageRoute.fallback).toHaveBeenCalledOnce();

    const fenceRoute = { request: () => request, fallback: vi.fn(), abort: vi.fn() };
    await routes.pageRoutes[0](fenceRoute);
    expect(fenceRoute.abort).toHaveBeenCalledOnce();

    const contextRoute = { request: () => request, fallback: vi.fn(), abort: vi.fn() };
    await routes.contextRoutes[0](contextRoute);
    expect(contextRoute.abort).toHaveBeenCalledOnce();

    const reused = await runLabtestAmendSave(routes.page as never, callbacks(save));
    expect(reused).toMatchObject({ outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' });
  });
});
