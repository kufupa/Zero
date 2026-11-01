import { describe, expect, it, vi } from 'vitest';
import { runLabtestAmendSave } from '../tooling/hms-cloud/labtest-amend-save.mjs';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
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

  it('reports uncertain when another save request is blocked after the approved dispatch', async () => {
    const routes = mockPage();
    const response = deferredValue<any>();
    routes.page.waitForResponse.mockReturnValue(response.promise);
    routes.page.waitForTimeout.mockResolvedValue(undefined);
    const frame = { locator: () => ({ count: async () => 0 }) };
    const saveRequest = {
      url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
      method: () => 'POST', postData: () => 'approved=true', frame: () => frame,
    };

    const visitRoutes = async (request: any) => {
      const visitPageRoute = async (index: number): Promise<void> => {
        const route = {
          request: () => request,
          fallback: async () => {
            if (index > 0) return visitPageRoute(index - 1);
            await routes.contextRoutes[0]!({
              request: () => request, abort: vi.fn(), fallback: vi.fn(), continue: vi.fn(),
            });
          },
          abort: vi.fn(),
        };
        await routes.pageRoutes[index]!(route);
      };
      await visitPageRoute(routes.pageRoutes.length - 1);
    };
    const save = {
      click: vi.fn(async () => {
        await visitRoutes(saveRequest);
        await visitRoutes({ ...saveRequest, frame: () => frame });
        response.resolve({ request: () => saveRequest, status: () => 200 });
      }),
    };

    const result = await runLabtestAmendSave(routes.page as never, {
      prepare: async () => ({ frame, save }),
      stage: async () => ({ draft: true }),
      matches: () => true,
      validate: async () => true,
    });

    expect(save.click).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: 'uncertain', httpStatus: 200, blockedRequestsAfterDispatch: 1 });
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
