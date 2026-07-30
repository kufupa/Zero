import { describe, expect, it } from 'vitest';
import {
  requestPolicyManifestSchema,
  requestRuleSchema,
} from '../src/hms/contracts.js';
import {
  BLOCK_CODES,
  FixtureRequestRecorder,
  contextCreationOptions,
  createBrowserEventGuards,
  enforceRequestPolicy,
  evaluateObservedRequest,
  type PolicyRoute,
} from '../src/hms/request-policy.js';

const ORIGIN = 'http://127.0.0.1:17888';

const reservationSearchRule = requestRuleSchema.parse({
  id: 'reservation-search',
  origin: ORIGIN,
  method: 'POST',
  path: '/web/reservation/search',
  resourceTypes: ['xhr', 'fetch'],
  fixedQuery: { screen: 'guestStay' },
  variableQuery: {
    confirmationNumber: { pattern: '[A-Z0-9]{1,16}', maxLength: 16 },
  },
  contentType: 'application/x-www-form-urlencoded',
  fixedBody: {
    action: 'search',
    tenant: 'FIXTURE',
    property: 'centurion',
  },
  variableBody: {
    surname: { pattern: "[A-Za-z'\\-]{1,40}", maxLength: 40 },
  },
  maxBodyBytes: 4096,
  redirectPolicy: 'same-reviewed-chain',
});

const loginGetRule = requestRuleSchema.parse({
  id: 'login-page',
  origin: ORIGIN,
  method: 'GET',
  path: '/login',
  resourceTypes: ['document'],
  redirectPolicy: 'same-reviewed-chain',
});

const roomAvailabilityRule = requestRuleSchema.parse({
  id: 'room-availability',
  origin: ORIGIN,
  method: 'GET',
  path: '/availability/rooms',
  resourceTypes: ['document'],
  fixedQuery: { view: 'inventory' },
  variableQuery: {
    startDate: { pattern: '\\d{4}-\\d{2}-\\d{2}', maxLength: 10 },
  },
  redirectPolicy: 'same-reviewed-chain',
});

const manifest = requestPolicyManifestSchema.parse({
  rules: [loginGetRule, reservationSearchRule, roomAvailabilityRule],
});

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function makeRoute(input: {
  url: string;
  method?: string;
  resourceType?: string;
  headers?: Record<string, string>;
  postData?: string | null;
  redirectedFrom?: string | null;
}): PolicyRoute & {
  continued: boolean;
  aborted: boolean;
  abortError?: string;
} {
  const state = {
    continued: false,
    aborted: false,
    abortError: undefined as string | undefined,
  };
  const route: PolicyRoute & typeof state = {
    ...state,
    request() {
      return {
        url: () => input.url,
        method: () => input.method ?? 'GET',
        resourceType: () => input.resourceType ?? 'document',
        headers: () => input.headers ?? {},
        postData: () => input.postData ?? null,
        redirectedFrom: () =>
          input.redirectedFrom
            ? { url: () => input.redirectedFrom as string }
            : null,
        isNavigationRequest: () =>
          (input.resourceType ?? 'document') === 'document',
      };
    },
    async continue() {
      state.continued = true;
      route.continued = true;
    },
    async abort(errorCode?: string) {
      state.aborted = true;
      state.abortError = errorCode;
      route.aborted = true;
      route.abortError = errorCode;
    },
  };
  return route;
}

async function runPolicy(
  routeInput: Parameters<typeof makeRoute>[0],
  recorder = new FixtureRequestRecorder(),
) {
  const route = makeRoute(routeInput);
  const decision = await enforceRequestPolicy(route, manifest, { recorder });
  return { route, decision, recorder };
}

describe('HMS request policy contracts', () => {
  it('parses strict request rules and rejects unknown keys', () => {
    expect(() =>
      requestRuleSchema.parse({
        ...reservationSearchRule,
        queryKeys: ['nope'],
      }),
    ).toThrow();
    expect(reservationSearchRule.redirectPolicy).toBe('same-reviewed-chain');
    expect(reservationSearchRule.maxBodyBytes).toBe(4096);
  });
});

describe('HMS fail-closed request matrix', () => {
  it('allows only exact fixture reservation-search signature', async () => {
    const { route, decision, recorder } = await runPolicy({
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'Guest',
      }),
    });

    expect(decision).toEqual({
      action: 'allow',
      ruleId: 'reservation-search',
    });
    expect(route.continued).toBe(true);
    expect(route.aborted).toBe(false);
    expect(recorder.requests()).toEqual([
      {
        method: 'POST',
        path: '/web/reservation/search',
        ruleId: 'reservation-search',
      },
    ]);
  });

  it('allows exact login and room-availability fixture GETs', async () => {
    const login = await runPolicy({
      url: `${ORIGIN}/login`,
      method: 'GET',
      resourceType: 'document',
    });
    expect(login.decision).toEqual({ action: 'allow', ruleId: 'login-page' });
    expect(login.recorder.requests()).toHaveLength(1);

    const rooms = await runPolicy({
      url: `${ORIGIN}/availability/rooms?view=inventory&startDate=2026-08-03`,
      method: 'GET',
      resourceType: 'document',
    });
    expect(rooms.decision).toEqual({
      action: 'allow',
      ruleId: 'room-availability',
    });
  });

  it.each([
    {
      name: 'unknown origin',
      input: {
        url: 'https://evil.example/web/reservation/search?screen=guestStay&confirmationNumber=ABC123',
        method: 'POST',
        resourceType: 'xhr',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: formBody({
          action: 'search',
          tenant: 'FIXTURE',
          property: 'centurion',
          surname: 'Guest',
        }),
      },
      code: BLOCK_CODES.UNKNOWN_ORIGIN,
    },
    {
      name: 'unknown path',
      input: {
        url: `${ORIGIN}/web/reservation/save?screen=guestStay&confirmationNumber=ABC123`,
        method: 'POST',
        resourceType: 'xhr',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: formBody({
          action: 'search',
          tenant: 'FIXTURE',
          property: 'centurion',
          surname: 'Guest',
        }),
      },
      code: BLOCK_CODES.UNKNOWN_PATH,
    },
    {
      name: 'unknown method',
      input: {
        url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
        method: 'PUT',
        resourceType: 'xhr',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: formBody({
          action: 'search',
          tenant: 'FIXTURE',
          property: 'centurion',
          surname: 'Guest',
        }),
      },
      code: BLOCK_CODES.UNKNOWN_METHOD,
    },
    {
      name: 'unknown resource type',
      input: {
        url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
        method: 'POST',
        resourceType: 'websocket',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: formBody({
          action: 'search',
          tenant: 'FIXTURE',
          property: 'centurion',
          surname: 'Guest',
        }),
      },
      code: BLOCK_CODES.WEBSOCKET,
    },
  ])('blocks $name before continue', async ({ input, code }) => {
    const { route, decision, recorder } = await runPolicy(input);
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe(code);
      expect(decision.redactedSignature).not.toHaveProperty('rawValues');
      expect(JSON.stringify(decision.redactedSignature)).not.toMatch(/Guest|ABC123|FIXTURE/);
    }
    expect(route.aborted).toBe(true);
    expect(route.continued).toBe(false);
    expect(recorder.requests()).toEqual([]);
  });

  it('blocks extra / duplicate / missing / changed fixed query', async () => {
    const base = {
      method: 'POST' as const,
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'Guest',
      }),
    };

    const extra = await runPolicy({
      ...base,
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123&extra=1`,
    });
    expect(extra.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.EXTRA_QUERY,
    });
    expect(extra.recorder.requests()).toEqual([]);

    const missing = await runPolicy({
      ...base,
      url: `${ORIGIN}/web/reservation/search?confirmationNumber=ABC123`,
    });
    expect(missing.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.MISSING_FIXED_QUERY,
    });

    const changed = await runPolicy({
      ...base,
      url: `${ORIGIN}/web/reservation/search?screen=other&confirmationNumber=ABC123`,
    });
    expect(changed.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_FIXED_QUERY,
    });

    const duplicate = await runPolicy({
      ...base,
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&screen=guestStay&confirmationNumber=ABC123`,
    });
    expect(duplicate.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.DUPLICATE_QUERY,
    });
  });

  it('blocks extra / duplicate / missing / changed fixed body', async () => {
    const url = `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`;
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };

    const extra = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'Guest',
        bonus: 'x',
      }),
    });
    expect(extra.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.EXTRA_BODY,
    });
    expect(extra.recorder.requests()).toEqual([]);

    const missing = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        surname: 'Guest',
      }),
    });
    expect(missing.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.MISSING_FIXED_BODY,
    });

    const changed = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'other-property',
        surname: 'Guest',
      }),
    });
    expect(changed.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_PROPERTY,
    });

    const duplicate = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: 'action=search&action=search&tenant=FIXTURE&property=centurion&surname=Guest',
    });
    expect(duplicate.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.DUPLICATE_BODY,
    });
  });

  it('blocks invalid variables, malformed payloads, oversized body', async () => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    const goodBody = formBody({
      action: 'search',
      tenant: 'FIXTURE',
      property: 'centurion',
      surname: 'Guest',
    });

    const badVar = await runPolicy({
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=bad!`,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: goodBody,
    });
    expect(badVar.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.INVALID_VARIABLE_QUERY,
    });
    expect(badVar.recorder.requests()).toEqual([]);

    const malformedEncoding = await runPolicy({
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: 'action=%E0%A4%A&tenant=FIXTURE&property=centurion&surname=Guest',
    });
    expect(malformedEncoding.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.MALFORMED_ENCODING,
    });

    const malformedJson = await runPolicy({
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/json' },
      postData: '{not-json',
    });
    expect(malformedJson.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.MALFORMED_JSON,
    });

    const malformedMultipart = await runPolicy({
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
      method: 'POST',
      resourceType: 'xhr',
      headers: {
        'content-type': 'multipart/form-data; boundary=----bound',
      },
      postData: '------bound\r\nnot-a-part',
    });
    expect(malformedMultipart.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.MALFORMED_MULTIPART,
    });

    const oversized = await runPolicy({
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'G'.repeat(5000),
      }),
    });
    expect(oversized.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.OVERSIZED_BODY,
    });
  });

  it('blocks action=delete, submit buttons, changed tenant', async () => {
    const url = `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=ABC123`;
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };

    const deleteAction = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'delete',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'Guest',
      }),
    });
    expect(deleteAction.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.MUTATION_ACTION,
    });
    expect(deleteAction.recorder.requests()).toEqual([]);

    const submit = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'search',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'Guest',
        btnSave: 'Save',
      }),
    });
    expect(submit.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.SUBMIT_BUTTON,
    });

    const tenant = await runPolicy({
      url,
      method: 'POST',
      resourceType: 'xhr',
      headers,
      postData: formBody({
        action: 'search',
        tenant: 'OTHER',
        property: 'centurion',
        surname: 'Guest',
      }),
    });
    expect(tenant.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_TENANT,
    });
  });

  it('blocks cross-origin and unreviewed same-origin redirects', async () => {
    const cross = await runPolicy({
      url: `${ORIGIN}/login`,
      method: 'GET',
      resourceType: 'document',
      redirectedFrom: 'https://evil.example/start',
    });
    expect(cross.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CROSS_ORIGIN_REDIRECT,
    });
    expect(cross.recorder.requests()).toEqual([]);

    const unreviewed = await runPolicy({
      url: `${ORIGIN}/unreviewed/page`,
      method: 'GET',
      resourceType: 'document',
      redirectedFrom: `${ORIGIN}/login`,
    });
    expect(unreviewed.decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.UNREVIEWED_REDIRECT,
    });
  });

  it('blocks websocket, popup, download, service worker, data/blob escapes', async () => {
    const ws = evaluateObservedRequest(manifest, {
      url: `ws://127.0.0.1:17888/socket`,
      method: 'GET',
      resourceType: 'websocket',
    });
    expect(ws).toMatchObject({ action: 'block', code: BLOCK_CODES.WEBSOCKET });

    const dataUrl = evaluateObservedRequest(manifest, {
      url: 'data:text/html,hi',
      method: 'GET',
      resourceType: 'document',
    });
    expect(dataUrl).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.DATA_URL,
    });

    const blobUrl = evaluateObservedRequest(manifest, {
      url: 'blob:http://127.0.0.1:17888/abc',
      method: 'GET',
      resourceType: 'document',
    });
    expect(blobUrl).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.BLOB_URL,
    });

    const sw = evaluateObservedRequest(manifest, {
      url: `${ORIGIN}/sw.js`,
      method: 'GET',
      resourceType: 'service_worker',
    });
    expect(sw).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.SERVICE_WORKER,
    });

    const guards = createBrowserEventGuards(manifest);
    const popupClosed: string[] = [];
    await guards.handlePopup({
      async close() {
        popupClosed.push('closed');
      },
    });
    expect(popupClosed).toEqual(['closed']);
    expect(guards.lastBlock()?.code).toBe(BLOCK_CODES.POPUP);

    const downloadCancelled: string[] = [];
    await guards.handleDownload({
      async cancel() {
        downloadCancelled.push('cancelled');
      },
    });
    expect(downloadCancelled).toEqual(['cancelled']);
    expect(guards.lastBlock()?.code).toBe(BLOCK_CODES.DOWNLOAD);

    expect(guards.handleWebSocket()).toBe('reject');
    expect(guards.lastBlock()?.code).toBe(BLOCK_CODES.WEBSOCKET);

    const nav = guards.evaluateNavigation(`${ORIGIN}/login`);
    expect(nav).toEqual({ action: 'allow', ruleId: 'login-page' });
    expect(guards.evaluateNavigation(`${ORIGIN}/evil`)).toMatchObject({
      action: 'block',
    });

    expect(contextCreationOptions()).toEqual({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
  });

  it('blocks CRS Check Availability and never records it', async () => {
    const { route, decision, recorder } = await runPolicy({
      url: `${ORIGIN}/crs/check-availability`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({ action: 'checkAvailability' }),
    });
    expect(decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CRS_CHECK_AVAILABILITY,
    });
    expect(route.continued).toBe(false);
    expect(recorder.requests()).toEqual([]);
  });

  it('redacted signatures omit query/body values', async () => {
    const decision = evaluateObservedRequest(manifest, {
      url: `${ORIGIN}/web/reservation/search?screen=guestStay&confirmationNumber=SECRET99`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({
        action: 'delete',
        tenant: 'FIXTURE',
        property: 'centurion',
        surname: 'SecretGuest',
      }),
    });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      const json = JSON.stringify(decision.redactedSignature);
      expect(json).not.toContain('SECRET99');
      expect(json).not.toContain('SecretGuest');
      expect(decision.redactedSignature.queryKeys).toEqual(
        expect.arrayContaining(['screen', 'confirmationNumber']),
      );
      expect(decision.redactedSignature.bodyKeys).toEqual(
        expect.arrayContaining(['action', 'tenant', 'property', 'surname']),
      );
    }
  });
});
