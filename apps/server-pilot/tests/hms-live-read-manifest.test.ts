import { describe, expect, it } from 'vitest';
import {
  LIVE_GUEST_STAY_SEARCH_PATH,
  LIVE_NOTFOUND_CANARY,
  buildLiveGuestStayReadManifest,
} from '../src/hms/live-read-manifest.js';
import {
  BLOCK_CODES,
  evaluateObservedRequest,
} from '../src/hms/request-policy.js';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe('live Guest Stay read manifest (HRCEN)', () => {
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
    expect(manifest.rules.some((r) => r.id === 'live-osress-search')).toBe(
      false,
    );
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
    const { buildExactOsressSearchManifest, buildExactOsressSearchBody } =
      await import('../src/hms/live-read-manifest.js');
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
    const { buildExactOsressSearchManifest, buildExactOsressSearchBody } =
      await import('../src/hms/live-read-manifest.js');
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
});
