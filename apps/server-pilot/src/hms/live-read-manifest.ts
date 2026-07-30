/**
 * Reviewed live HMS read request rules for Centurion (HRCEN) Guest Stay.
 *
 * Source: abort-first EC2 probes + soft-capture 2026-07-30
 * (`evals/hms/live-login-inventory.v1.json`).
 *
 * Fail-closed: only these signatures may continue. No save/delete/duplicate/
 * check-in/check-out/CRS. Fixture adapter (`centurion.manifest.json`) stays
 * on loopback paths until a dedicated live adapter plan inventories list-row
 * selectors.
 */
import {
  requestPolicyManifestSchema,
  type RequestPolicyManifest,
  type RequestRule,
} from './contracts.js';

/** Guest Stay quick-search endpoint (not OSRESV). */
export const LIVE_GUEST_STAY_SEARCH_PATH = '/web/base/OSRESS.search';

/** Canary confirmation token used in live not-found probes. */
export const LIVE_NOTFOUND_CANARY = 'NOTFOUND-CANARY';

const VAR64 = { pattern: '.{0,64}', maxLength: 64 } as const;
const VAR32 = { pattern: '.{0,32}', maxLength: 32 } as const;
const VAR16 = { pattern: '.{0,16}', maxLength: 16 } as const;
const VAR8 = { pattern: '.{0,8}', maxLength: 8 } as const;

function maddonFilterBody(): Record<string, { pattern: string; maxLength: number }> {
  const body: Record<string, { pattern: string; maxLength: number }> = {};
  for (let i = 1; i <= 10; i += 1) {
    body[`MADDON_FILTER_ALIAS_NAME_${i}`] = VAR64;
    body[`MADDON_FILTER_JOINER_${i}`] = VAR16;
    body[`MADDON_FILTER_OPERATOR_${i}`] = VAR16;
    body[`MADDON_FILTER_SEQNUM_${i}`] = VAR8;
    body[`MADDON_FILTER_VALUE_${i}`] = VAR64;
  }
  body.MADDON_LPAREN_3 = VAR16;
  body.MADDON_LPAREN_5 = VAR16;
  body.MADDON_RPAREN_6 = VAR16;
  body.MADDON_RPAREN_10 = VAR16;
  return body;
}

/**
 * Functional Guest Stay read POSTs (+ login/bootstrap) for a live origin.
 * Does not include chrome image/font/script GETs — callers merge those.
 */
export function buildLiveGuestStayFunctionalRules(origin: string): RequestRule[] {
  return [
    {
      id: 'live-login-post',
      origin,
      method: 'POST',
      path: '/web/base/login',
      resourceTypes: ['xhr', 'fetch', 'document'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        tenant: 'HMS_LEGACY',
      },
      variableBody: {
        userid: { pattern: '.{1,64}', maxLength: 64 },
        password: { pattern: '.{1,128}', maxLength: 128 },
        csrftckt: { pattern: '.{0,256}', maxLength: 256 },
        resetpassword: { pattern: '.{0,32}', maxLength: 32 },
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
      },
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-bsstrt',
      origin,
      method: 'POST',
      path: '/web/base/BSSTRT',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {
        MENU_MODULE_KEY: VAR64,
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
        removescreenflows: VAR16,
      },
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-bsstrt-hdr',
      origin,
      method: 'POST',
      path: '/web/base/BSSTRT.HDR',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
        manurefresh: VAR16,
      },
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osresv',
      origin,
      method: 'POST',
      path: '/web/base/OSRESV',
      resourceTypes: ['xhr', 'fetch', 'document'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {
        FUNCTION_CLASS: VAR64,
        USER_FUNCTION_NAME: VAR64,
      },
      fixedBody: {},
      variableBody: {
        CURRENT_TAB_NAME: VAR64,
        FUNCTION_CLASS: VAR64,
        MENU_MODULE_KEY: VAR64,
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
        removescreenflows: VAR16,
      },
      maxBodyBytes: 8192,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osresv-hdr',
      origin,
      method: 'POST',
      path: '/web/base/OSRESV.HDR',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {
        CURRENT_TAB_NAME: VAR64,
        MENU_MODULE_KEY: VAR64,
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
        account: VAR64,
        bookingdotcomid: VAR64,
        confirmationnumber: VAR64,
        facebookid: VAR64,
        firstname: VAR64,
        guestNumber: VAR64,
        guestid: VAR64,
        hoteldate: VAR32,
        lastname: VAR64,
        propertycode: { pattern: 'HRCEN|', maxLength: 16 },
        removescreenflows: VAR16,
        reservationstayid: VAR64,
        room: VAR32,
        tripadvisorid: VAR64,
        twitterid: VAR64,
      },
      maxBodyBytes: 16_384,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osress-search',
      origin,
      method: 'POST',
      path: LIVE_GUEST_STAY_SEARCH_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {
        COMPONENT_INFO_TYPE: VAR64,
        CURRENT_TAB_NAME: VAR64,
        DATASPY_ID: VAR64,
        GRID_ID: VAR64,
        GRID_NAME: VAR64,
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
        externalconfirmation: VAR64,
        ...maddonFilterBody(),
      },
      maxBodyBytes: 16_384,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osresv-lst',
      origin,
      method: 'POST',
      path: '/web/base/OSRESV.LST',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {
        COMPONENT_INFO_TYPE: VAR64,
        CURRENT_TAB_NAME: VAR64,
        MENU_MODULE_KEY: VAR64,
        SYSTEM_FUNCTION_NAME: VAR64,
        USER_FUNCTION_NAME: VAR64,
        removescreenflows: VAR16,
      },
      maxBodyBytes: 16_384,
      redirectPolicy: 'same-reviewed-chain',
    },
  ];
}

/** Request-policy-only manifest for unit tests / future live session factory. */
export function buildLiveGuestStayReadManifest(
  origin: string,
): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: buildLiveGuestStayFunctionalRules(origin),
  });
}
