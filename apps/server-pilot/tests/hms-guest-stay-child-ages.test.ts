import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const formSource = readFileSync(new URL('../tooling/hms-cloud/guest-stay-form.mjs', import.meta.url), 'utf8');
const origin = formSource.match(/const CLOUD_ORIGIN = '([^']+)'/)?.[1];
const validatePath = formSource.match(/const CHILD_AGE_VALIDATE = '([^']+)'/)?.[1];
if (!origin || !validatePath) throw new Error('Test request configuration unavailable');
const { setGuestStayChildAges } = await import('../tooling/hms-cloud/guest-stay-form.mjs' as string);

type Request = { method: () => string; url: () => string; postData: () => string };
type Route = { request: () => Request; abort: () => Promise<void>; fallback: () => Promise<void> };
type Handler = (route: Route) => Promise<void>;
type Fault = 'up' | 'down' | null;

// A synthetic Ext-style page lets the real request guard and age action run together.
function fakeGuestStay({ fault = null, initialCount = '' }: { fault?: Fault; initialCount?: string } = {}) {
  const handlers: Handler[] = [];
  const clicks: string[] = [];
  const fields: Record<string, string> = { children: '', child1: '0', child2: '0', child3: '0' };
  let spin = initialCount;
  let popupOpen = false;
  let applied = 0;
  let submittedCount: string | null = null;
  let validationAllowed = false;
  let resolveResponse: ((response: unknown) => void) | null = null;

  const request = (path: string, params: Record<string, unknown>): Request => ({
    method: () => 'POST',
    url: () => new URL(path, origin).href,
    postData: () => new URLSearchParams({ params: JSON.stringify(params), ONLY_DATA_REQUIRED: 'true' }).toString(),
  });
  const dispatch = async (req: Request) => {
    let allowed = true;
    const next = async (index: number): Promise<void> => {
      if (index < 0) return;
      await handlers[index]({ request: () => req, abort: async () => { allowed = false; }, fallback: () => next(index - 1) });
    };
    await next(handlers.length - 1);
    return allowed;
  };
  const respond = (req: Request, data: object, allowed: boolean) => {
    if (!resolveResponse) throw new Error('Response was not awaited');
    const resolve = resolveResponse;
    resolveResponse = null;
    resolve({ request: () => req, url: () => req.url(), ok: () => allowed, json: async () => data });
  };
  const readParams = { propertyCode: 'HRCEN', reservationStayId: '', childAges: [] };
  const trigger = {
    count: async () => 1,
    click: async () => {
      const req = request('/web/base/OSRESV.HDR.getChildAges', readParams);
      const allowed = await dispatch(req);
      popupOpen = allowed;
      respond(req, readParams, allowed);
    },
  };
  const spinner = {
    count: async () => 1,
    inputValue: async () => spin,
    locator: () => ({ locator: (selector: string) => ({
      click: async () => {
        const direction = selector.endsWith('.up') ? 'up' : 'down';
        clicks.push(direction);
        spin = direction === 'up' ? (fault === 'up' ? '2' : '1') : (fault === 'down' ? '1' : '0');
      },
    }) }),
  };
  const apply = async () => {
    applied += 1;
    submittedCount = spin;
    const req = request(validatePath, { ...readParams, adultCount: '1', childCount: spin,
      updateChildCategories: true, activeChildCategories: [], confirmChildCategory: false, childCategoryCounts: {} });
    validationAllowed = await dispatch(req);
    if (validationAllowed) { fields.children = spin; popupOpen = false; }
    respond(req, { ...readParams, childCount: Number(spin), confirmChildCategory: false }, validationAllowed);
  };
  const popup = {
    count: async () => Number(popupOpen),
    waitFor: async () => {},
    locator: (selector: string) => {
      if (selector === 'input[name="updatechildcategories"]') return { count: async () => 1, evaluate: async () => true };
      if (selector === 'input[name="children"]') return spinner;
      if (selector === 'a.x-btn:visible') return { filter: () => ({ click: apply }) };
      throw new Error('Unexpected popup locator');
    },
  };
  const page = {
    on: () => {}, off: () => {},
    route: async (_pattern: string, handler: Handler) => { handlers.push(handler); },
    unroute: async (_pattern: string, handler: Handler) => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
    waitForTimeout: async () => {},
    waitForResponse: () => new Promise((resolve) => { resolveResponse = resolve; }),
    evaluate: async (_fn: unknown, options?: unknown) => options ? null :
      Object.entries(fields).map(([name, value]) => ({ id: name, name, value })),
    locator: (selector: string) => {
      if (selector === '.x-window:visible:not(.x-menu)') return { count: async () => 0 };
      if (selector === '.x-window[id^="childagespopup"]:visible') return popup;
      if (selector === '[data-qtip="Enter Child Ages"]:visible') return trigger;
      const name = /^input\[name="([^"]+)"\]/.exec(selector)?.[1];
      if (name && Object.hasOwn(fields, name)) return {
        count: async () => 1,
        inputValue: async () => fields[name],
        evaluate: async () => [{ value: '0' }, { value: '1' }],
      };
      throw new Error('Unexpected page locator');
    },
  };
  return { page, clicks, result: () => ({ applied, submittedCount, validationAllowed }) };
}

describe('empty child ages on an unsaved stay', () => {
  it('establishes zero and passes the real validation request guard', async () => {
    const fixture = fakeGuestStay();
    const result = await setGuestStayChildAges(fixture.page, { propertyCode: 'HRCEN', childAges: [] });
    expect(result.outcome).toBe('updated_unsaved');
    expect(result.actualChildAges).toEqual([]);
    expect(fixture.clicks).toEqual(['up', 'down']);
    expect(fixture.result()).toEqual({ applied: 1, submittedCount: '0', validationAllowed: true });
  });

  it('does not cycle an already explicit zero', async () => {
    const fixture = fakeGuestStay({ initialCount: '0' });
    const result = await setGuestStayChildAges(fixture.page, { propertyCode: 'HRCEN', childAges: [] });
    expect(result.outcome).toBe('updated_unsaved');
    expect(fixture.clicks).toEqual([]);
    expect(fixture.result()).toEqual({ applied: 1, submittedCount: '0', validationAllowed: true });
  });

  it.each(['up', 'down'] as const)('does not apply after a wrong %s readback', async (fault) => {
    const fixture = fakeGuestStay({ fault });
    const result = await setGuestStayChildAges(fixture.page, { propertyCode: 'HRCEN', childAges: [] });
    expect(result.outcome).toBe('action_uncertain');
    expect(result.issue).toBe('CHILD_COUNT_READBACK_MISMATCH');
    expect(fixture.clicks).toEqual(fault === 'up' ? ['up'] : ['up', 'down']);
    expect(fixture.result()).toEqual({ applied: 0, submittedCount: null, validationAllowed: false });
  });
});
