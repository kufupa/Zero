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

  it('allows OSRESS.search with soft-capture body keys', () => {
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
    expect(decision).toEqual({
      action: 'allow',
      ruleId: 'live-osress-search',
    });
  });

  it('allows empty OSRESV.HDR propertycode (open shell)', () => {
    const body = formBody({
      confirmationnumber: '',
      reservationstayid: '',
      propertycode: '',
      guestNumber: '',
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
      MENU_MODULE_KEY: '1',
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
