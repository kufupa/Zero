import {
  buildBoundFolioRefreshRule,
  buildBoundFolioRefreshRequest,
  buildBoundFolioAllGridRule,
  buildBoundFolioAllDataRule,
  buildFolioCacheReadRule,
  buildPropertyLedgerEntryReadRules,
  buildPropertyLedgerDetailReadRule,
  BOUND_FOLIO_REFRESH_QUERY,
  FOLIO_REFRESH_PATH,
} from '../src/hms/folio-manifest.js';
import { evaluateObservedRequest } from '../../../../../apps/server-pilot/src/hms/request-policy.js';
import { HmsRuntimeError } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { describe, expect, it } from 'vitest';

const DETAIL_VALUES = {
  confirmationnumber: 'CONF-42',
  reservationstayid: 'ACTUAL-77',
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

describe('bound OSRESV.FOL refresh request', () => {
  it('pins display-only deposit ledger to one property and calendar-valid day', () => {
    const rule = buildPropertyLedgerDetailReadRule(
      'https://pms.example.test',
      'HRCEN',
      '09/17/2026',
    );
    expect(rule.fixedBody).toEqual({
      SYSTEM_FUNCTION_NAME: 'OSLEDG',
      USER_FUNCTION_NAME: 'OSLEDG',
      CURRENT_TAB_NAME: 'DLD',
      property: 'HRCEN',
      closingdate: '09/17/2026',
    });
    expect(rule.variableBody).toEqual({});
    const request = {
      url: `${rule.origin}${rule.path}`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: new URLSearchParams(rule.fixedBody).toString(),
    };
    expect(evaluateObservedRequest({ rules: [rule] }, request).action).toBe('allow');
    for (const changed of [
      { property: 'OTHER' },
      { closingdate: '09/16/2026' },
      { action: 'SAVE' },
    ])
      expect(
        evaluateObservedRequest(
          { rules: [rule] },
          {
            ...request,
            postData: new URLSearchParams({ ...rule.fixedBody, ...changed }).toString(),
          },
        ).action,
      ).toBe('block');
    for (const date of ['02/30/2026', '09/17/26', '', '2026-09-17'])
      expect(() =>
        buildPropertyLedgerDetailReadRule('https://pms.example.test', 'HRCEN', date),
      ).toThrow();
  });
  it('admits only captured Property Ledger entry and empty list context', () => {
    const rules = buildPropertyLedgerEntryReadRules('https://pms.example.test');
    expect(rules).toHaveLength(2);
    const list = rules.find((r) => r.path === '/web/base/OSLEDG.LST')!;
    expect(list.fixedBody).toEqual({
      SYSTEM_FUNCTION_NAME: 'OSLEDG',
      USER_FUNCTION_NAME: 'OSLEDG',
      CURRENT_TAB_NAME: 'LST',
      property: '',
      closingdate: '',
    });
    const request = {
      url: `${list.origin}${list.path}`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: new URLSearchParams(list.fixedBody).toString(),
    };
    expect(evaluateObservedRequest({ rules }, request).action).toBe('allow');
    expect(
      evaluateObservedRequest(
        { rules },
        {
          ...request,
          postData: new URLSearchParams({ ...list.fixedBody, property: 'OTHER' }).toString(),
        },
      ).action,
    ).toBe('block');
    expect(
      evaluateObservedRequest({ rules }, { ...request, url: `${list.origin}/web/base/OSLEDG.DLD` })
        .action,
    ).toBe('block');
  });
  it('pins continuation to captured All Folios cache query and bounded page positions', () => {
    const rule = buildFolioCacheReadRule({
      origin: 'https://pms.example.test',
      cursorPosition: 51,
    });
    expect(rule.path).toBe('/web/base/GETCACHE');
    expect(rule.fixedBody).toEqual({
      COMPONENT_INFO_TYPE: 'DATA_ONLY',
      COMPONENT_INFO_TYPE_MODE: 'CACHE',
      GRID_ID: '780',
      GRID_NAME: 'OSFOLO',
      DATASPY_ID: '836',
      NUMBER_OF_ROWS_FIRST_RETURNED: '50',
      CACHE_REQUEST: 'false',
      CURSOR_POSITION: '51',
      CURRENT_TAB_NAME: 'FOL',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    });
    const request = {
      url: `${rule.origin}${rule.path}`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: new URLSearchParams(rule.fixedBody).toString(),
    };
    expect(evaluateObservedRequest({ rules: [rule] }, request).action).toBe('allow');
    expect(
      evaluateObservedRequest(
        { rules: [rule] },
        {
          ...request,
          postData: new URLSearchParams({
            ...rule.fixedBody,
            USER_FUNCTION_NAME: 'OTHER',
          }).toString(),
        },
      ).action,
    ).toBe('block');
    expect(
      evaluateObservedRequest(
        { rules: [rule] },
        {
          ...request,
          postData: new URLSearchParams({ ...rule.fixedBody, CURSOR_POSITION: '101' }).toString(),
        },
      ).action,
    ).toBe('block');
    for (const cursorPosition of [0, 1, 50, 52, 201, 51.5, NaN])
      expect(() =>
        buildFolioCacheReadRule({ origin: 'https://pms.example.test', cursorPosition }),
      ).toThrow();
  });
  it('allows only the captured exact-parent All Folios data query', () => {
    const rule = buildBoundFolioAllDataRule({
      origin: 'https://pms.example.test',
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      expectedPropertyCode: 'HRCEN',
      detailValues: DETAIL_VALUES,
    });
    expect(rule.path).toBe('/web/base/OSRESV.FOL.xmlhttp');
    expect(Object.keys(rule.fixedBody)).toHaveLength(21);
    expect(rule.fixedBody).toMatchObject({
      COMPONENT_INFO_TYPE: 'DATA_ONLY',
      DATASPY_ID: '836',
      GRID_ID: '780',
      GRID_NAME: 'OSFOLO',
    });
    expect(rule.fixedBody).not.toHaveProperty('pagemode');
    const request = {
      url: `${rule.origin}${rule.path}`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: new URLSearchParams(rule.fixedBody).toString(),
    };
    expect(evaluateObservedRequest({ rules: [rule] }, request).action).toBe('allow');
    for (const fields of [
      { ...rule.fixedBody, reservationstayid: 'OTHER' },
      { ...rule.fixedBody, COMPONENT_INFO_TYPE: 'SAVE' },
      { ...rule.fixedBody, action: 'post' },
    ]) {
      expect(
        evaluateObservedRequest(
          { rules: [rule] },
          { ...request, postData: new URLSearchParams(fields).toString() },
        ).action,
      ).toBe('block');
    }
  });
  it('pins the captured All Folios header read to one stay and dataspy', () => {
    const rule = buildBoundFolioAllGridRule({
      origin: 'https://pms.example.test',
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      expectedPropertyCode: 'HRCEN',
      detailValues: DETAIL_VALUES,
    });
    expect(Object.keys(rule.fixedBody)).toHaveLength(22);
    expect(rule.fixedBody).toMatchObject({
      confirmationnumber: 'CONF-42',
      reservationstayid: 'ACTUAL-77',
      GRID_ID: '780',
      GRID_NAME: 'OSFOLO',
      DATASPY_ID: '836',
      COMPONENT_INFO_TYPE: 'HEAD_ONLY',
      pagemode: 'display',
    });
    expect(rule.fixedQuery).toEqual({});
    expect(rule.variableBody).toEqual({});
    expect(rule.fixedBody).not.toHaveProperty('ONLY_DATA_REQUIRED');
  });

  it('builds exact 20-field read-only refresh rule', () => {
    const rule = buildBoundFolioRefreshRule({
      origin: 'https://pms.example.test',
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      expectedPropertyCode: 'HRCEN',
      detailValues: DETAIL_VALUES,
    });

    expect(rule).toMatchObject({
      id: 'live-folio-osresv-fol-refresh',
      origin: 'https://pms.example.test',
      method: 'POST',
      path: FOLIO_REFRESH_PATH,
      fixedQuery: BOUND_FOLIO_REFRESH_QUERY,
      variableQuery: {},
      variableBody: {},
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(Object.keys(rule.fixedBody)).toHaveLength(20);
    expect(rule.fixedBody).toMatchObject({
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'FOL',
      THROW_EXCEPTION: 'false',
      REFRESH_GRID: 'false',
      ONLY_DATA_REQUIRED: 'true',
    });
  });

  it('retains exact 14 detail fields plus reviewed refresh controls and empty query', () => {
    const request = buildBoundFolioRefreshRequest({
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      expectedPropertyCode: 'HRCEN',
      detailValues: DETAIL_VALUES,
    });

    expect(request).toEqual({
      path: FOLIO_REFRESH_PATH,
      query: BOUND_FOLIO_REFRESH_QUERY,
      fields: {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'FOL',
        confirmationnumber: 'CONF-42',
        reservationstayid: 'ACTUAL-77',
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
        THROW_EXCEPTION: 'false',
        REFRESH_GRID: 'false',
        ONLY_DATA_REQUIRED: 'true',
      },
    });
    expect(Object.keys(request.fields)).toHaveLength(20);
    expect(request.fields).not.toHaveProperty('id');
    expect(request.fields).not.toHaveProperty('MENU_MODULE_KEY');
    expect(request.fields).not.toHaveProperty('removescreenflows');
    expect(request.fields).not.toHaveProperty('unreviewedfield');
  });

  it.each([
    ['confirmation', { confirmationNumber: 'OTHER' }, /confirmation mismatch/i],
    ['stay', { reservationStayId: 'OTHER' }, /reservationstayid mismatch/i],
    ['property', { expectedPropertyCode: 'OTHER' }, /property mismatch/i],
  ])('rejects wrong %s binding', (_label, override, expected) => {
    expect(() =>
      buildBoundFolioRefreshRequest({
        confirmationNumber: 'CONF-42',
        reservationStayId: 'ACTUAL-77',
        expectedPropertyCode: 'HRCEN',
        detailValues: DETAIL_VALUES,
        ...override,
      }),
    ).toThrow(expected);
  });

  it('rejects absent reviewed detail values rather than guessing', () => {
    const missing = { ...DETAIL_VALUES };
    delete missing.account;
    try {
      buildBoundFolioRefreshRequest({
        confirmationNumber: 'CONF-42',
        reservationStayId: 'ACTUAL-77',
        expectedPropertyCode: 'HRCEN',
        detailValues: missing,
      });
      throw new Error('expected bound builder to reject missing account');
    } catch (error) {
      expect(error).toBeInstanceOf(HmsRuntimeError);
      expect(error).toMatchObject({ code: 'SCHEMA_DRIFT' });
      expect(error).toHaveProperty('message', 'bound OSRESV.FOL detail field missing: account');
    }
  });
});
