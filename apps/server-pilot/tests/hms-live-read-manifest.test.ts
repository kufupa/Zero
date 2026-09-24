import {
  LIVE_GUEST_STAY_SEARCH_PATH,
  LIVE_NOTFOUND_CANARY,
  buildLiveFolioReadManifest,
  buildLiveGuestStayReadManifest,
  buildLiveOsnotsReadRule,
  buildLiveSentEmailListManifest,
  buildExactOsressSearchThenDetailManifest,
  buildLiveGuestStayDetailChromeGetRules,
} from '../src/hms/live-read-manifest.js';
import { BLOCK_CODES, evaluateObservedRequest } from '../src/hms/request-policy.js';
import { requestPolicyManifestSchema } from '../src/hms/contracts.js';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe('live Guest Stay read manifest (HRCEN)', () => {
  it('allows the observed search toolbar magic-wand image only as an inert GET', () => {
    const assets = { rules: buildLiveGuestStayDetailChromeGetRules(ORIGIN) };
    const url = `${ORIGIN}/web/resources/inforhms/images/toolbar/magic-wand.svg`;
    expect(evaluateObservedRequest(assets, { url, method: 'GET', resourceType: 'image' }).action).toBe('allow');
    expect(evaluateObservedRequest(assets, { url, method: 'POST', resourceType: 'xhr' }).action).toBe('block');
    expect(evaluateObservedRequest(assets, { url: `${url}?action=save`, method: 'GET', resourceType: 'image' }).action).toBe('block');
  });
  it('allows the observed All Folios grid hover image, never a functional POST', () => {
    const assets = { rules: buildLiveGuestStayDetailChromeGetRules(ORIGIN) };
    const url = `${ORIGIN}/web/resources/inforhms/images/grid/grid-sort-hover.svg`;
    expect(
      evaluateObservedRequest(assets, { url, method: 'GET', resourceType: 'image' }).action,
    ).toBe('allow');
    expect(
      evaluateObservedRequest(assets, { url, method: 'POST', resourceType: 'xhr' }).action,
    ).toBe('block');
    expect(
      evaluateObservedRequest(assets, {
        url: `${url}?action=save`,
        method: 'GET',
        resourceType: 'image',
      }).action,
    ).toBe('block');
  });
  it('allows only the exact Folio toolbar image GETs observed in the live tab', () => {
    const assets = { rules: buildLiveGuestStayDetailChromeGetRules(ORIGIN) };
    for (const file of [
      'purchasing.svg',
      'utilities.svg',
      'clear-formatting.svg',
      'expand-app-tray-vertical.svg',
      'collapse-app-tray-vertical.svg',
    ]) {
      const url = `${ORIGIN}/web/resources/inforhms/images/toolbar/${file}`;
      expect(
        evaluateObservedRequest(assets, { url, method: 'GET', resourceType: 'image' }).action,
        file,
      ).toBe('allow');
      expect(
        evaluateObservedRequest(assets, { url, method: 'POST', resourceType: 'xhr' }).action,
      ).toBe('block');
    }
  });
  it.each([
    '/web/resources/inforhms/images/hms/icon_morepending.png',
    '/web/resources/inforhms/images/hms/toolbar/reserve.svg',
  ])('allows only exact detail chrome GET %s', (path) => {
    const assets = { rules: buildLiveGuestStayDetailChromeGetRules(ORIGIN) };
    const url = `${ORIGIN}${path}`;
    expect(
      evaluateObservedRequest(assets, { url, method: 'GET', resourceType: 'image' }).action,
    ).toBe('allow');
    expect(
      evaluateObservedRequest(assets, { url, method: 'POST', resourceType: 'xhr' }).action,
    ).toBe('block');
    expect(
      evaluateObservedRequest(assets, {
        url: `${url}?action=reserve`,
        method: 'GET',
        resourceType: 'image',
      }).action,
    ).toBe('block');
  });
  const manifest = buildLiveGuestStayReadManifest(ORIGIN);

  it('exports reviewed search path + canary token', () => {
    expect(LIVE_GUEST_STAY_SEARCH_PATH).toBe('/web/base/OSRESS.search');
    expect(LIVE_NOTFOUND_CANARY).toBe('NOTFOUND-CANARY');
    expect(LIVE_NOTFOUND_CANARY.length).toBe(15);
  });

  it('blocks OSRESS.search on base manifest until exact candidate bound', () => {
    const body = formBody({
      MADDON_FILTER_ALIAS_NAME_1: 'lastname',
      MADDON_FILTER_OPERATOR_1: '=',
      MADDON_FILTER_JOINER_1: 'AND',
      MADDON_FILTER_SEQNUM_1: '1',
      MADDON_FILTER_VALUE_1: 'x',
      MADDON_FILTER_ALIAS_NAME_2: 'firstname',
      MADDON_FILTER_OPERATOR_2: '=',
      MADDON_FILTER_JOINER_2: 'AND',
      MADDON_FILTER_SEQNUM_2: '2',
      MADDON_FILTER_VALUE_2: 'y',
      MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
      MADDON_FILTER_OPERATOR_3: 'equals',
      MADDON_FILTER_JOINER_3: 'OR',
      MADDON_FILTER_SEQNUM_3: '3',
      MADDON_FILTER_VALUE_3: LIVE_NOTFOUND_CANARY,
      MADDON_LPAREN_3: 'true',
      MADDON_FILTER_ALIAS_NAME_4: 'room',
      MADDON_FILTER_OPERATOR_4: '=',
      MADDON_FILTER_JOINER_4: 'OR',
      MADDON_FILTER_SEQNUM_4: '4',
      MADDON_FILTER_VALUE_4: LIVE_NOTFOUND_CANARY,
      MADDON_FILTER_ALIAS_NAME_5: 'externalconfirm',
      MADDON_FILTER_OPERATOR_5: 'equals',
      MADDON_FILTER_JOINER_5: 'OR',
      MADDON_FILTER_SEQNUM_5: '5',
      MADDON_FILTER_VALUE_5: LIVE_NOTFOUND_CANARY,
      MADDON_LPAREN_5: 'true',
      MADDON_FILTER_ALIAS_NAME_6: 'guestNumber',
      MADDON_FILTER_OPERATOR_6: 'equals',
      MADDON_FILTER_JOINER_6: 'OR',
      MADDON_FILTER_SEQNUM_6: '6',
      MADDON_FILTER_VALUE_6: LIVE_NOTFOUND_CANARY,
      MADDON_RPAREN_6: 'true',
      MADDON_FILTER_ALIAS_NAME_7: 'reservationstayid',
      MADDON_FILTER_OPERATOR_7: 'equals',
      MADDON_FILTER_JOINER_7: 'OR',
      MADDON_FILTER_SEQNUM_7: '7',
      MADDON_FILTER_VALUE_7: LIVE_NOTFOUND_CANARY,
      MADDON_FILTER_ALIAS_NAME_8: 'accountnumber',
      MADDON_FILTER_OPERATOR_8: 'equals',
      MADDON_FILTER_JOINER_8: 'OR',
      MADDON_FILTER_SEQNUM_8: '8',
      MADDON_FILTER_VALUE_8: LIVE_NOTFOUND_CANARY,
      MADDON_FILTER_ALIAS_NAME_9: 'bookingdotcom',
      MADDON_FILTER_OPERATOR_9: 'equals',
      MADDON_FILTER_JOINER_9: 'OR',
      MADDON_FILTER_SEQNUM_9: '9',
      MADDON_FILTER_VALUE_9: LIVE_NOTFOUND_CANARY,
      MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
      MADDON_FILTER_OPERATOR_10: 'equals',
      MADDON_FILTER_JOINER_10: 'OR',
      MADDON_FILTER_SEQNUM_10: '10',
      MADDON_FILTER_VALUE_10: LIVE_NOTFOUND_CANARY,
      MADDON_RPAREN_10: 'true',
      externalconfirmation: LIVE_NOTFOUND_CANARY,
      COMPONENT_INFO_TYPE: 'LIST_VIEW',
      GRID_ID: 'grid',
      GRID_NAME: 'OSRESS',
      DATASPY_ID: '1001',
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      USER_FUNCTION_NAME: 'OSRESS',
      CURRENT_TAB_NAME: 'LST',
    });
    const decision = evaluateObservedRequest(manifest, {
      method: 'POST',
      url: `${ORIGIN}${LIVE_GUEST_STAY_SEARCH_PATH}`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: body,
    });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe(BLOCK_CODES.UNKNOWN_PATH);
    }
    expect(manifest.rules.some((r) => r.id === 'live-osress-search')).toBe(false);
  });

  it('allows empty OSRESV.HDR propertycode (open shell)', () => {
    const body = formBody({
      confirmationnumber: '',
      reservationstayid: '',
      propertycode: '',
      guestfullname: '',
      account: '',
      guestid: '',
      hoteldate: '',
      lastname: '',
      firstname: '',
      twitterid: '',
      facebookid: '',
      tripadvisorid: '',
      bookingdotcomid: '',
      room: '',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'HDR',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
    const decision = evaluateObservedRequest(manifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV.HDR`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: body,
    });
    expect(decision).toEqual({ action: 'allow', ruleId: 'live-osresv-hdr' });
  });

  it('allows only observed BSSTRT.HDR refresh control', () => {
    const request = (manurefresh: string) =>
      evaluateObservedRequest(manifest, {
        method: 'POST',
        url: `${ORIGIN}/web/base/BSSTRT.HDR`,
        resourceType: 'xhr',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        postData: formBody({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          manurefresh,
        }),
      });

    expect(request('true')).toEqual({
      action: 'allow',
      ruleId: 'live-bsstrt-hdr',
    });
    expect(request('false').action).toBe('block');
  });

  it('allows both observed sent-email bootstrap refresh variants only', () => {
    const sentManifest = buildLiveSentEmailListManifest(ORIGIN);
    const request = (manurefresh: string) =>
      evaluateObservedRequest(sentManifest, {
        method: 'POST',
        url: `${ORIGIN}/web/base/BSSTRT.HDR`,
        resourceType: 'xhr',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        postData: formBody({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          manurefresh,
        }),
      });

    expect(request('yes').action).toBe('allow');
    expect(request('true').action).toBe('allow');
    expect(request('false').action).toBe('block');
  });

  it('includes authenticated bootstrap rules in the folio-only manifest', () => {
    const folioManifest = buildLiveFolioReadManifest(ORIGIN);
    const login = evaluateObservedRequest(folioManifest, {
      method: 'GET',
      url: `${ORIGIN}/web/base/logindisp?tenant=HMS_LEGACY`,
      resourceType: 'document',
      headers: {},
      postData: '',
    });
    expect(login.action).toBe('allow');
    const unrelated = evaluateObservedRequest(folioManifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/PSSNEL.HDR`,
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        USER_FUNCTION_NAME: 'PSSNEL',
        CURRENT_TAB_NAME: 'HDR',
      }),
    });
    expect(unrelated.action).toBe('block');
  });

  it('allows only exact confirmation-bound OSRESV.FOL reads in folio manifest', () => {
    const folioManifest = buildLiveFolioReadManifest(ORIGIN);
    const fol = evaluateObservedRequest(folioManifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV.FOL`,
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'FOL',
        propertycode: 'HRCEN',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        confirmationnumber: 'actual-bound-confirmation',
        reservationstayid: 'stay-from-correlated-row',
        id: 'stay-from-correlated-row',
      }),
    });
    expect(fol.action).toBe('allow');
    const wrongProperty = evaluateObservedRequest(folioManifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV.FOL`,
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody({
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'FOL',
        propertycode: 'OTHER',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        confirmationnumber: 'actual-bound-confirmation',
      }),
    });
    expect(wrongProperty.action).toBe('block');
  });

  it('blocks mutation-looking save path as unknown_path', () => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV.save`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      postData: formBody({ action: 'save' }),
    });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe(BLOCK_CODES.UNKNOWN_PATH);
    }
  });

  it('blocks mutation action tokens embedded in reviewed control values', () => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      postData: formBody({
        CURRENT_TAB_NAME: '',
        FUNCTION_CLASS: 'WEBL',
        MENU_MODULE_KEY: '0',
        SYSTEM_FUNCTION_NAME: 'OSRESV.SAVE',
        USER_FUNCTION_NAME: 'OSRESV',
        removescreenflows: 'yes',
      }),
    });
    expect(decision.action).toBe('block');
    if (decision.action === 'block') {
      expect(decision.code).toBe(BLOCK_CODES.MUTATION_ACTION);
    }
  });

  it('blocks unreviewed OSRESV control values', () => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      postData: formBody({
        CURRENT_TAB_NAME: '',
        FUNCTION_CLASS: 'WEBL',
        MENU_MODULE_KEY: '0',
        SYSTEM_FUNCTION_NAME: 'OSRESV.UNREVIEWED',
        USER_FUNCTION_NAME: 'OSRESV',
        removescreenflows: 'yes',
      }),
    });
    expect(decision.action).toBe('block');
  });

  it('blocks fixture reservation search on live origin', () => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'POST',
      url: `${ORIGIN}/web/reservation/search`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      postData: formBody({
        action: 'search',
        confirmationNumber: LIVE_NOTFOUND_CANARY,
      }),
    });
    expect(decision.action).toBe('block');
  });
});

describe('exact OSRESS.search candidate binding', () => {
  it('allows only body whose confirmation value equals selected candidate', async () => {
    const { buildExactOsressSearchManifest, buildExactOsressSearchBody } = await import(
      '../src/hms/live-read-manifest.js'
    );
    const candidate = {
      id: 'c1',
      kind: 'confirmation' as const,
      value: 'EXACT-CONF-99',
    };
    const bound = buildExactOsressSearchManifest(ORIGIN, candidate);
    const good = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${LIVE_GUEST_STAY_SEARCH_PATH}`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: formBody(buildExactOsressSearchBody(candidate)),
    });
    expect(good).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });
  });

  it('allows ExtJS filter value/alias/operator drift; still blocks extras + chrome drift', async () => {
    const {
      buildExactOsressSearchManifest,
      buildExactOsressSearchBody,
      LIVE_GUEST_STAY_SEARCH_PATH: searchPath,
    } = await import('../src/hms/live-read-manifest.js');
    const candidate = {
      id: 'c1',
      kind: 'confirmation' as const,
      value: 'EXACT-CONF-99',
    };
    const bound = buildExactOsressSearchManifest(ORIGIN, candidate);
    const base = buildExactOsressSearchBody(candidate);
    const headers = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };

    // Live ExtJS quick-search varies filter values/operators; those are variableBody.
    const altered = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${searchPath}`,
      resourceType: 'xhr',
      headers,
      postData: formBody({ ...base, MADDON_FILTER_VALUE_3: 'OTHER-VAL' }),
    });
    expect(altered).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });

    const extra = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${searchPath}`,
      resourceType: 'xhr',
      headers,
      postData: formBody({ ...base, bonus: 'x' }),
    });
    expect(extra.action).toBe('block');
    if (extra.action === 'block') {
      expect(extra.code).toBe(BLOCK_CODES.EXTRA_BODY);
    }

    const aliasDrift = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${searchPath}`,
      resourceType: 'xhr',
      headers,
      postData: formBody({
        ...base,
        MADDON_FILTER_ALIAS_NAME_3: 'confirmationNumber',
      }),
    });
    expect(aliasDrift).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });

    const opDrift = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${searchPath}`,
      resourceType: 'xhr',
      headers,
      postData: formBody({
        ...base,
        MADDON_FILTER_OPERATOR_3: 'contains',
      }),
    });
    expect(opDrift).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });

    // Chrome also variable — ExtJS may omit/alter dataspy ids vs soft-capture.
    const chromeDrift = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${searchPath}`,
      resourceType: 'xhr',
      headers,
      postData: formBody({
        ...base,
        DATASPY_ID: '9999',
      }),
    });
    expect(chromeDrift).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });

    const mutation = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}/web/base/OSRESV.save`,
      resourceType: 'xhr',
      headers,
      postData: formBody({ action: 'save' }),
    });
    expect(mutation.action).toBe('block');
    if (mutation.action === 'block') {
      expect(mutation.code).toBe(BLOCK_CODES.UNKNOWN_PATH);
    }
  });

  it('binds confirmation to confirmation slot only; unused OR slots are non-empty fillers', async () => {
    const { buildExactOsressSearchBody, OSRESS_OR_UNUSED_TOKEN } = await import(
      '../src/hms/live-read-manifest.js'
    );
    const body = buildExactOsressSearchBody({
      id: 'c1',
      kind: 'confirmation',
      value: 'EXACT-CONF-99',
    });
    expect(body.MADDON_FILTER_VALUE_3).toBe('EXACT-CONF-99');
    expect(body.MADDON_FILTER_VALUE_4).toBe(OSRESS_OR_UNUSED_TOKEN);
    expect(body.MADDON_FILTER_VALUE_10).toBe(OSRESS_OR_UNUSED_TOKEN);
    expect(body.externalconfirmation).toBe(OSRESS_OR_UNUSED_TOKEN);
    expect(body.MADDON_FILTER_VALUE_1).toBe('-365');
    expect(body.MADDON_FILTER_VALUE_2).toBe('+365');
  });

  it('surname_dates fills lastname family; conf/ext unused', async () => {
    const { buildExactOsressSearchBody, OSRESS_OR_UNUSED_TOKEN } = await import(
      '../src/hms/live-read-manifest.js'
    );
    const body = buildExactOsressSearchBody({
      id: 's1',
      kind: 'surname_dates',
      surname: 'Syntherson',
      arrivalDate: '2099-01-15',
      departureDate: '2099-01-18',
    });
    expect(body.MADDON_FILTER_VALUE_5).toBe('Syntherson');
    expect(body.MADDON_FILTER_VALUE_6).toBe('Syntherson');
    expect(body.MADDON_FILTER_VALUE_7).toBe('Syntherson');
    expect(body.MADDON_FILTER_VALUE_8).toBe('Syntherson');
    expect(body.MADDON_FILTER_VALUE_3).toBe(OSRESS_OR_UNUSED_TOKEN);
    expect(body.MADDON_FILTER_VALUE_10).toBe(OSRESS_OR_UNUSED_TOKEN);
    expect(body.MADDON_FILTER_VALUE_4).toBe(OSRESS_OR_UNUSED_TOKEN);
  });

  it('external_reference fills external slots; confirmation OR unused', async () => {
    const { buildExactOsressSearchBody, OSRESS_OR_UNUSED_TOKEN } = await import(
      '../src/hms/live-read-manifest.js'
    );
    const body = buildExactOsressSearchBody({
      id: 'e1',
      kind: 'external_reference',
      value: 'EXT-REF-42',
    });
    expect(body.externalconfirmation).toBe('EXT-REF-42');
    expect(body.MADDON_FILTER_VALUE_10).toBe('EXT-REF-42');
    expect(body.MADDON_FILTER_VALUE_3).toBe(OSRESS_OR_UNUSED_TOKEN);
  });

  it('allows external_reference body including altered externalconfirmation (variableBody)', async () => {
    const { buildExactOsressSearchManifest, buildExactOsressSearchBody } = await import(
      '../src/hms/live-read-manifest.js'
    );
    const candidate = {
      id: 'e1',
      kind: 'external_reference' as const,
      value: 'EXT-REF-42',
    };
    const bound = buildExactOsressSearchManifest(ORIGIN, candidate);
    const body = buildExactOsressSearchBody(candidate);
    expect(body.externalconfirmation).toBe('EXT-REF-42');
    const good = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${LIVE_GUEST_STAY_SEARCH_PATH}`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: formBody(body),
    });
    expect(good).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });

    const altered = evaluateObservedRequest(bound, {
      method: 'POST',
      url: `${ORIGIN}${LIVE_GUEST_STAY_SEARCH_PATH}`,
      resourceType: 'xhr',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: formBody({ ...body, externalconfirmation: 'WRONG' }),
    });
    expect(altered).toEqual({ action: 'allow', ruleId: 'live-osress-search-exact' });
  });
  it('Wave A1 detail manifest allows ExtJS OSRESV row-open; find manifest blocks it', async () => {
    const { buildExactOsressSearchManifest, buildExactOsressSearchThenDetailManifest } =
      await import('../src/hms/live-read-manifest.js');
    const candidate = {
      id: 'c1',
      kind: 'confirmation' as const,
      value: 'CONF-42',
    };
    const findOnly = buildExactOsressSearchManifest(ORIGIN, candidate);
    const detail = buildExactOsressSearchThenDetailManifest(ORIGIN, candidate);
    const openBody = formBody({
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      DEFAULT_VIEW: 'HDR',
      SAVE_FOR_HEADER: 'true',
      confirmationnumber: 'CONF-42',
      startUpView: 'HDR',
      GRIDPARAM_ADDON_SORT_ELEMENT_ALIAS_NAME: '',
      GRIDPARAM_ADDON_SORT_ELEMENT_TYPE: '',
    });
    const req = {
      method: 'POST' as const,
      url: `${ORIGIN}/web/base/OSRESV?USER_FUNCTION_NAME=OSRESV`,
      resourceType: 'xhr' as const,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: openBody,
    };
    const blocked = evaluateObservedRequest(findOnly, req);
    expect(blocked.action).toBe('block');
    const allowed = evaluateObservedRequest(detail, req);
    expect(allowed).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-open-matched-row',
    });

    const lstBody = formBody({
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'LST',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      ADDONS_REQUIRED: 'true',
      RUN_DS: 'true',
      filterfields: 'confirmationnumber',
      filteroperator: '=',
      filtervalue: 'CONF-42',
      ADDON_SORT_ELEMENT_ALIAS_NAME: '',
      ADDON_SORT_ELEMENT_TYPE: '',
    });
    const lstReq = {
      method: 'POST' as const,
      url: `${ORIGIN}/web/base/OSRESV.LST`,
      resourceType: 'xhr' as const,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: lstBody,
    };
    expect(evaluateObservedRequest(findOnly, lstReq).action).toBe('block');
    expect(evaluateObservedRequest(detail, lstReq)).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-lst-detail-open',
    });

    const hdrBody = formBody({
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'HDR',
      confirmationnumber: 'CONF-42',
      reservationstayid: '123',
      propertycode: 'HRCEN',
      guestfullname: '',
      account: '',
      guestid: '',
      hoteldate: '',
      lastname: '',
      firstname: '',
      twitterid: '',
      facebookid: '',
      tripadvisorid: '',
      bookingdotcomid: '',
      room: '',
    });
    const hdrReq = {
      method: 'POST' as const,
      url: `${ORIGIN}/web/base/OSRESV.HDR`,
      resourceType: 'xhr' as const,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: hdrBody,
    };
    expect(evaluateObservedRequest(findOnly, hdrReq).action).toBe('block');
    expect(evaluateObservedRequest(detail, hdrReq)).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-hdr-detail-open',
    });

    const notesReq = {
      method: 'POST' as const,
      url: `${ORIGIN}/web/base/OSNOTS`,
      resourceType: 'xhr' as const,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: formBody({
        SYSTEM_FUNCTION_NAME: 'OSNOTS',
        USER_FUNCTION_NAME: 'OSNOTS',
        popup: 'true',
        action: 'RESRETRIEVAL',
        propertyCode: 'HRCEN',
        confirmationNumber: 'CONF-42',
      }),
    };
    expect(evaluateObservedRequest(findOnly, notesReq).action).toBe('block');
    expect(evaluateObservedRequest(detail, notesReq)).toEqual({
      action: 'allow',
      ruleId: 'live-osnots-read',
    });
    expect(
      evaluateObservedRequest(detail, {
        ...notesReq,
        postData: formBody({
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'OSNOTS',
          popup: 'false',
          action: 'load',
          propertyCode: 'HRCEN',
          confirmationNumber: 'CONF-42',
        }),
      }).action,
    ).toBe('block');

    const hdrChromeBody = formBody({
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'HDR',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      confirmationnumber: 'CONF-42',
      reservationstayid: '123',
      propertycode: 'HRCEN',
      guestfullname: '',
      account: '',
      guestid: '',
      hoteldate: '',
      lastname: '',
      firstname: '',
      twitterid: '',
      facebookid: '',
      tripadvisorid: '',
      bookingdotcomid: '',
      room: '',
    });
    const hdrChromeReq = {
      method: 'POST' as const,
      url: `${ORIGIN}/web/base/OSRESV.HDR`,
      resourceType: 'xhr' as const,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      postData: hdrChromeBody,
    };
    // Shell find HDR must allow Guest Stay navigate (camelCase guestNumber + MENU).
    expect(evaluateObservedRequest(findOnly, hdrChromeReq)).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-hdr',
    });
    // Shell HDR retained on detail manifest; may match before chrome template.
    expect(evaluateObservedRequest(detail, hdrChromeReq).action).toBe('allow');
    expect(
      ['live-osresv-hdr', 'live-osresv-hdr-detail-open-chrome'].includes(
        (evaluateObservedRequest(detail, hdrChromeReq) as { ruleId?: string }).ruleId ?? '',
      ),
    ).toBe(true);

    const hdrMinimalBody = formBody({
      CURRENT_TAB_NAME: 'HDR',
      MENU_MODULE_KEY: '0',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      removescreenflows: 'yes',
      propertycode: 'HRCEN',
      confirmationnumber: 'CONF-42',
      reservationstayid: '123',
    });
    const hdrMinimalReq = { ...hdrReq, postData: hdrMinimalBody };
    expect(evaluateObservedRequest(findOnly, hdrMinimalReq).action).toBe('block');
    expect(evaluateObservedRequest(detail, hdrMinimalReq)).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-hdr-detail-open-minimal',
    });

    const hdrMinimalIdBody = formBody({
      CURRENT_TAB_NAME: 'HDR',
      MENU_MODULE_KEY: '0',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      removescreenflows: 'yes',
      propertycode: 'HRCEN',
      confirmationnumber: 'CONF-42',
      reservationstayid: '123',
      id: '123',
    });
    expect(evaluateObservedRequest(detail, { ...hdrReq, postData: hdrMinimalIdBody })).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-hdr-detail-open-minimal-id',
    });

    const hdrMinimalNoChromeBody = formBody({
      CURRENT_TAB_NAME: 'HDR',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      propertycode: 'HRCEN',
      confirmationnumber: 'CONF-42',
      reservationstayid: '123',
    });
    const hdrMinimalNoChromeReq = { ...hdrReq, postData: hdrMinimalNoChromeBody };
    expect(evaluateObservedRequest(detail, hdrMinimalNoChromeReq)).toEqual({
      action: 'allow',
      ruleId: 'live-osresv-hdr-detail-open-minimal-no-chrome',
    });

    const notesBody = formBody({
      SYSTEM_FUNCTION_NAME: 'OSNOTS',
      USER_FUNCTION_NAME: 'OSNOTS',
      popup: 'true',
      action: 'RESRETRIEVAL',
      propertyCode: 'HRCEN',
      confirmationNumber: 'CONF-42',
    });
    expect(
      evaluateObservedRequest(detail, {
        method: 'POST',
        url: `${ORIGIN}/web/base/OSNOTS`,
        resourceType: 'xhr',
        headers: {},
        postData: notesBody,
      }),
    ).toEqual({ action: 'allow', ruleId: 'live-osnots-read' });
  });

  it('blocks unreviewed OSNOTS controls', () => {
    const body = formBody({
      SYSTEM_FUNCTION_NAME: 'OSNOTS',
      USER_FUNCTION_NAME: 'OSNOTS',
      popup: 'false',
      action: 'load',
      propertyCode: 'HRCEN',
      confirmationNumber: 'CONF-42',
    });
    expect(
      evaluateObservedRequest(
        buildExactOsressSearchThenDetailManifest(ORIGIN, {
          id: 'notes-osnots-test',
          kind: 'confirmation',
          value: 'CONF-42',
        }),
        {
          method: 'POST',
          url: `${ORIGIN}/web/base/OSNOTS`,
          resourceType: 'xhr',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          postData: body,
        },
      ),
    ).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_FIXED_BODY,
    });
  });

  it('binds OSNOTS to observed read controls and optional exact confirmation', () => {
    const buildBoundOsnots = buildLiveOsnotsReadRule as unknown as (
      origin: string,
      confirmationNumber: string,
    ) => ReturnType<typeof buildLiveOsnotsReadRule>;
    const manifest = requestPolicyManifestSchema.parse({
      rules: [buildBoundOsnots(ORIGIN, 'CONF-42')],
    });
    const request = (fields: Record<string, string>) => ({
      method: 'POST',
      url: `${ORIGIN}/web/base/OSNOTS`,
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: formBody(fields),
    });
    const base = {
      SYSTEM_FUNCTION_NAME: 'OSNOTS',
      USER_FUNCTION_NAME: 'OSNOTS',
      popup: 'true',
      action: 'RESRETRIEVAL',
      propertyCode: 'HRCEN',
      confirmationNumber: 'CONF-42',
    };
    expect(evaluateObservedRequest(manifest, request(base))).toEqual({
      action: 'allow',
      ruleId: 'live-osnots-read',
    });
    expect(
      evaluateObservedRequest(manifest, request({ ...base, confirmationNumber: 'OTHER' })),
    ).toMatchObject({ action: 'block', code: BLOCK_CODES.CHANGED_FIXED_BODY });
    expect(evaluateObservedRequest(manifest, request({ ...base, popup: 'false' }))).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_FIXED_BODY,
    });
    expect(evaluateObservedRequest(manifest, request({ ...base, action: 'load' }))).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.CHANGED_FIXED_BODY,
    });
  });
});
