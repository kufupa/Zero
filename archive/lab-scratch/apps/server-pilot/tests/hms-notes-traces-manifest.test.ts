import { describe, expect, it } from 'vitest';
import { BLOCK_CODES, evaluateObservedRequest } from '../../../../../apps/server-pilot/src/hms/request-policy.js';
import { requestPolicyManifestSchema, type RequestRule } from '../../../../../apps/server-pilot/src/hms/contracts.js';
import {
  buildBoundNotesTracesReadRule,
  buildNotesTracesReadManifest,
} from '../src/hms/notes-traces-manifest.js';
import * as notesTracesManifest from '../src/hms/notes-traces-manifest.js';
import type { ValidatedFolioDetailValues } from '../../../../../apps/server-pilot/src/hms/folio-read-facade.js';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const BOUND = {
  origin: ORIGIN,
  confirmationNumber: 'CONF-BOUND-42',
  reservationStayId: 'opaque-stay-42',
};

const DETAIL_VALUES: ValidatedFolioDetailValues = {
  confirmationnumber: BOUND.confirmationNumber,
  reservationstayid: BOUND.reservationStayId,
  propertycode: 'HRCEN',
  guestfullname: 'Synthetic Guest',
  account: 'ACCT-7',
  guestid: 'GUEST-7',
  hoteldate: '09/17/2026',
  lastname: 'Guest',
  firstname: 'Synthetic',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
  unreviewedfield: 'must-not-escape',
};

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function observedRequest(postData: string, path = '/web/base/OSRESV.TRC') {
  return {
    method: 'POST',
    url: `${ORIGIN}${path}`,
    resourceType: 'xhr',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    postData,
  };
}

type NotesInquiryRuleFactory = (origin: string, confirmationNumber: string) => RequestRule;

function notesInquiryManifest(): ReturnType<typeof requestPolicyManifestSchema.parse> {
  const factory = (notesTracesManifest as unknown as Record<string, unknown>)
    .buildNotesInquiryReadRule;
  expect(typeof factory).toBe('function');
  return requestPolicyManifestSchema.parse({
    rules: [(factory as NotesInquiryRuleFactory)(ORIGIN, '1234567890')],
  });
}

function inquiryRequest(
  body: unknown,
  input: Partial<{
    method: string;
    path: string;
    resourceType: string;
    contentType: string;
  }> = {},
) {
  return {
    method: input.method ?? 'POST',
    url: `${ORIGIN}${input.path ?? '/api/booking/HRCEN/notesInquiry'}`,
    resourceType: input.resourceType ?? 'xhr',
    headers: { 'content-type': input.contentType ?? 'application/json; charset=UTF-8' },
    postData: JSON.stringify(body),
  };
}

describe('bounded notes/traces TRC manifest', () => {
  it('builds exact bound TRC body from validated FOL detail fields', () => {
    const rule = buildBoundNotesTracesReadRule({
      ...BOUND,
      detailValues: DETAIL_VALUES,
    });
    expect(rule).toMatchObject({
      id: 'live-osresv-trc-read',
      origin: ORIGIN,
      method: 'POST',
      path: '/web/base/OSRESV.TRC',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'TRC',
        confirmationnumber: BOUND.confirmationNumber,
        reservationstayid: BOUND.reservationStayId,
        propertycode: 'HRCEN',
        guestfullname: 'Synthetic Guest',
        account: 'ACCT-7',
        guestid: 'GUEST-7',
        hoteldate: '09/17/2026',
        lastname: 'Guest',
        firstname: 'Synthetic',
        twitterid: '',
        facebookid: '',
        tripadvisorid: '',
        bookingdotcomid: '',
        room: '101',
      },
      variableBody: {},
    });
    expect(Object.keys(rule.fixedBody)).toHaveLength(17);
    expect(rule.fixedBody).not.toHaveProperty('id');
    expect(rule.fixedBody).not.toHaveProperty('MENU_MODULE_KEY');
    expect(rule.fixedBody).not.toHaveProperty('removescreenflows');

    const manifest = requestPolicyManifestSchema.parse({ rules: [rule] });
    expect(
      evaluateObservedRequest(manifest, observedRequest(formBody(rule.fixedBody))),
    ).toEqual({ action: 'allow', ruleId: 'live-osresv-trc-read' });
  });

  it.each([
    ['wrong confirmation', { confirmationNumber: 'OTHER-CONF' }, /confirmation mismatch/i],
    ['wrong stay', { reservationStayId: 'OTHER-STAY' }, /reservationstayid mismatch/i],
    ['wrong property', { detailValues: { ...DETAIL_VALUES, propertycode: 'OTHER' } }, /property mismatch/i],
  ])('rejects %s bound TRC parent before rule creation', (_label, override, expected) => {
    expect(() =>
      buildBoundNotesTracesReadRule({
        ...BOUND,
        detailValues: DETAIL_VALUES,
        ...override,
      }),
    ).toThrow(expected);
  });

  it('blocks wrong parent and extra/mutation fields against exact bound TRC rule', () => {
    const rule = buildBoundNotesTracesReadRule({
      ...BOUND,
      detailValues: DETAIL_VALUES,
    });
    const manifest = requestPolicyManifestSchema.parse({ rules: [rule] });
    const wrongParent = evaluateObservedRequest(
      manifest,
      observedRequest(
        formBody({ ...rule.fixedBody, confirmationnumber: 'OTHER-CONF' }),
      ),
    );
    expect(wrongParent).toMatchObject({ action: 'block', code: BLOCK_CODES.CHANGED_FIXED_BODY });

    for (const extra of [
      { id: BOUND.reservationStayId },
      { MENU_MODULE_KEY: '0' },
      { removescreenflows: 'yes' },
      { action: 'save' },
    ]) {
      expect(
        evaluateObservedRequest(manifest, observedRequest(formBody({ ...rule.fixedBody, ...extra })))
          .action,
      ).toBe('block');
    }
  });

  it('declares exact bound TRC body and allows the observed read shape', () => {
    const manifest = buildNotesTracesReadManifest(BOUND);
    expect(manifest.rules).toHaveLength(1);
    const rule = manifest.rules[0]!;
    expect(rule).toMatchObject({
      id: 'live-osresv-trc-read',
      origin: ORIGIN,
      method: 'POST',
      path: '/web/base/OSRESV.TRC',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'TRC',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        propertycode: 'HRCEN',
        confirmationnumber: BOUND.confirmationNumber,
        reservationstayid: BOUND.reservationStayId,
        id: BOUND.reservationStayId,
      },
      variableBody: {},
    });

    const decision = evaluateObservedRequest(
      manifest,
      observedRequest(
        formBody({
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'OSRESV',
          CURRENT_TAB_NAME: 'TRC',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
          propertycode: 'HRCEN',
          confirmationnumber: BOUND.confirmationNumber,
          reservationstayid: BOUND.reservationStayId,
          id: BOUND.reservationStayId,
        }),
      ),
    );
    expect(decision).toEqual({ action: 'allow', ruleId: 'live-osresv-trc-read' });
  });

  it('rejects wrong property or correlated identity', () => {
    const manifest = buildNotesTracesReadManifest(BOUND);
    const base = {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'TRC',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      propertycode: 'HRCEN',
      confirmationnumber: BOUND.confirmationNumber,
      reservationstayid: BOUND.reservationStayId,
      id: BOUND.reservationStayId,
    };

    for (const [key, value] of [
      ['propertycode', 'OTHER'],
      ['confirmationnumber', 'OTHER-CONF'],
      ['reservationstayid', 'OTHER-STAY'],
      ['id', 'OTHER-STAY'],
    ] as const) {
      const body = { ...base, [key]: value };
      const decision = evaluateObservedRequest(manifest, observedRequest(formBody(body)));
      expect(decision.action, key).toBe('block');
      if (decision.action === 'block') {
        expect(decision.code).toBe(BLOCK_CODES.CHANGED_FIXED_BODY);
      }
    }
  });

  it('rejects DATA_ONLY guesses, extra controls, and mutation-shaped requests', () => {
    const manifest = buildNotesTracesReadManifest(BOUND);
    const base = {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'TRC',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      propertycode: 'HRCEN',
      confirmationnumber: BOUND.confirmationNumber,
      reservationstayid: BOUND.reservationStayId,
      id: BOUND.reservationStayId,
    };

    expect(
      evaluateObservedRequest(
        manifest,
        observedRequest(
          formBody({ ...base, COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: 'OSRESV' }),
        ),
      ).action,
    ).toBe('block');

    expect(
      evaluateObservedRequest(manifest, observedRequest(formBody({ ...base, action: 'save' }))).action,
    ).toBe('block');

    expect(
      evaluateObservedRequest(
        manifest,
        observedRequest(formBody(base), '/web/base/OSRESV.TRC?ACTION=save'),
      ).action,
    ).toBe('block');
  });
});

describe('bounded notesInquiry JSON manifest', () => {
  it('allows only exact correlated confirmation JSON', () => {
    const manifest = notesInquiryManifest();
    const rule = manifest.rules[0]!;
    expect(rule).toMatchObject({
      id: 'live-notes-inquiry-read',
      origin: ORIGIN,
      method: 'POST',
      path: '/api/booking/HRCEN/notesInquiry',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/json',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: { confirmationNumber: '1234567890' },
      variableBody: {},
    });
    expect(
      evaluateObservedRequest(
        manifest,
        inquiryRequest({ confirmationNumber: '1234567890' }),
      ),
    ).toEqual({ action: 'allow', ruleId: 'live-notes-inquiry-read' });
  });

  it('rejects wrong parent and property/path bindings', () => {
    const manifest = notesInquiryManifest();
    const wrongParent = evaluateObservedRequest(
      manifest,
      inquiryRequest({ confirmationNumber: '0987654321' }),
    );
    expect(wrongParent).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_FIXED_BODY,
    });

    for (const path of [
      '/api/booking/OTHER/notesInquiry',
      '/api/booking/HRCEN/other',
    ]) {
      expect(evaluateObservedRequest(manifest, inquiryRequest({ confirmationNumber: '1234567890' }, { path })))
        .toMatchObject({ action: 'block', code: BLOCK_CODES.UNKNOWN_PATH });
    }
  });

  it('rejects extra/action fields, wrong method, and non-string JSON types', () => {
    const manifest = notesInquiryManifest();
    expect(
      evaluateObservedRequest(
        manifest,
        inquiryRequest({ confirmationNumber: '1234567890', propertyCode: 'HRCEN' }),
      ),
    ).toMatchObject({ action: 'block', code: BLOCK_CODES.EXTRA_BODY });
    expect(
      evaluateObservedRequest(
        manifest,
        inquiryRequest({ confirmationNumber: '1234567890', action: 'save' }),
      ),
    ).toMatchObject({ action: 'block', code: BLOCK_CODES.MUTATION_ACTION });
    expect(
      evaluateObservedRequest(
        manifest,
        inquiryRequest({ confirmationNumber: '1234567890' }, { method: 'GET' }),
      ),
    ).toMatchObject({ action: 'block', code: BLOCK_CODES.UNKNOWN_METHOD });

    for (const confirmationNumber of [1234567890, true, { value: '1234567890' }]) {
      expect(
        evaluateObservedRequest(manifest, inquiryRequest({ confirmationNumber })),
      ).toMatchObject({ action: 'block', code: BLOCK_CODES.MALFORMED_JSON });
    }
  });
});
