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

function getStaticRule(
  origin: string,
  id: string,
  path: string,
  resourceTypes: Array<'stylesheet' | 'script' | 'image' | 'font' | 'document'>,
): RequestRule {
  return {
    id,
    origin,
    method: 'GET',
    path,
    resourceTypes,
    fixedQuery: {},
    variableQuery: {},
    fixedBody: {},
    variableBody: {},
    maxBodyBytes: 4096,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/**
 * Reviewed static chrome GETs from live-login-inventory (login + COMMON shell).
 * Must merge into production manifests — any unknown_path aborts the Playwright context.
 */
export function buildLiveGuestStayChromeGetRules(origin: string): RequestRule[] {
  return [
    getStaticRule(origin, 'live-login-css', '/web/resources/inforhms/HMS-min.css', [
      'stylesheet',
    ]),
    getStaticRule(
      origin,
      'live-login-jquery',
      '/web/resources/shared/scripts/jquery-3.6.0.min.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-login-jquery-json',
      '/web/resources/shared/scripts/jquery.json-2.3.min.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-login-companyon',
      '/web/resources/shared/scripts/infor-companyon-client.js',
      ['script'],
    ),
    getStaticRule(origin, 'live-login-all-js', '/web/base/login-all.js', ['script']),
    getStaticRule(
      origin,
      'live-login-error-svg',
      '/web/resources/inforhms/images/toolbar/error-solid.svg',
      ['image'],
    ),
    getStaticRule(
      origin,
      'live-login-logo-svg',
      '/web/resources/inforhms/images/shared/logo.svg',
      ['image'],
    ),
    getStaticRule(
      origin,
      'live-login-font-semibold',
      '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Semibold.ttf',
      ['font'],
    ),
    getStaticRule(
      origin,
      'live-login-font-regular',
      '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Regular.ttf',
      ['font'],
    ),
    getStaticRule(
      origin,
      'live-login-font-it',
      '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-It.ttf',
      ['font'],
    ),
    getStaticRule(origin, 'live-post-login-root', '/', ['document']),
    getStaticRule(
      origin,
      'live-common-vault-utility',
      '/web/resources/shared/scripts/vault/vaultUtility.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-common-parent-facade',
      '/web/resources/shared/scripts/vault/parentFacade.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-common-parent-facade-impl',
      '/web/resources/shared/scripts/vault/parentFacadeImpl.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-common-aes',
      '/web/resources/shared/scripts/cryptojs/aes.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-common-pbkdf2',
      '/web/resources/shared/scripts/cryptojs/pbkdf2.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-common-aes-util',
      '/web/resources/shared/scripts/cryptojs/AesUtil.js',
      ['script'],
    ),
    getStaticRule(
      origin,
      'live-common-sha256',
      '/web/resources/shared/scripts/cryptojs/sha256-min.js',
      ['script'],
    ),
    getStaticRule(origin, 'live-common-all-classes', '/web/base/all-classes.js', [
      'script',
    ]),
    getStaticRule(
      origin,
      'live-toolbar-dropdown',
      '/web/resources/inforhms/images/toolbar/dropdown.svg',
      ['image'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-new-doc-icon',
      '/web/resources/inforhms/images/toolbar/new-document.svg',
      ['image'],
    ),
  ];
}

/**
 * Functional Guest Stay read POSTs (+ login/bootstrap) for a live origin.
 * Chrome image/font/script GETs come from buildLiveGuestStayChromeGetRules.
 * OSRESS.search omitted until exactSearchCandidate binds via
 * buildExactOsressSearchManifest (fail closed — no variable confirmation body).
 */
export function buildLiveGuestStayFunctionalRules(origin: string): RequestRule[] {
  return [
    {
      id: 'live-login-get',
      origin,
      method: 'GET',
      path: '/web/base/logindisp',
      resourceTypes: ['document'],
      fixedQuery: {},
      variableQuery: {
        tenant: { pattern: 'HMS_LEGACY', maxLength: 32 },
      },
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-common-get',
      origin,
      method: 'GET',
      path: '/web/base/COMMON',
      resourceTypes: ['document', 'xhr', 'fetch'],
      fixedQuery: {},
      variableQuery: {
        REQ_KEY: { pattern: '[A-Za-z0-9._-]{0,128}', maxLength: 128 },
      },
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osresv-get',
      origin,
      method: 'GET',
      path: '/web/base/OSRESV',
      resourceTypes: ['document'],
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
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

/** Request-policy-only manifest for unit tests / production live sessions. */
export function buildLiveGuestStayReadManifest(
  origin: string,
): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      ...buildLiveGuestStayFunctionalRules(origin),
    ],
  });
}

/** Exact opaque reservation lookup candidate (confirmation or external ref). */
export type ExactReservationCandidate =
  | { id: string; kind: 'confirmation'; value: string }
  | { id: string; kind: 'external_reference'; value: string };

const EXACT_CHROME_FIXED = {
  COMPONENT_INFO_TYPE: 'LIST_VIEW',
  GRID_ID: 'grid',
  GRID_NAME: 'OSRESS',
  DATASPY_ID: '1001',
  SYSTEM_FUNCTION_NAME: 'OSRESS',
  USER_FUNCTION_NAME: 'OSRESS',
  CURRENT_TAB_NAME: 'LST',
} as const;

/**
 * Reviewed soft-capture filter scaffold with exact candidate value pinned in
 * confirmation or external-reference slots. Alias/operator drift blocks.
 */
export function buildExactOsressSearchBody(
  candidate: ExactReservationCandidate,
): Record<string, string> {
  const v = candidate.value;
  const body: Record<string, string> = {
    ...EXACT_CHROME_FIXED,
    MADDON_FILTER_ALIAS_NAME_1: 'lastname',
    MADDON_FILTER_OPERATOR_1: '=',
    MADDON_FILTER_JOINER_1: 'AND',
    MADDON_FILTER_SEQNUM_1: '1',
    MADDON_FILTER_VALUE_1: '',
    MADDON_FILTER_ALIAS_NAME_2: 'firstname',
    MADDON_FILTER_OPERATOR_2: '=',
    MADDON_FILTER_JOINER_2: 'AND',
    MADDON_FILTER_SEQNUM_2: '2',
    MADDON_FILTER_VALUE_2: '',
    MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
    MADDON_FILTER_OPERATOR_3: 'equals',
    MADDON_FILTER_JOINER_3: 'OR',
    MADDON_FILTER_SEQNUM_3: '3',
    MADDON_FILTER_VALUE_3: candidate.kind === 'confirmation' ? v : '',
    MADDON_LPAREN_3: 'true',
    MADDON_FILTER_ALIAS_NAME_4: 'room',
    MADDON_FILTER_OPERATOR_4: '=',
    MADDON_FILTER_JOINER_4: 'OR',
    MADDON_FILTER_SEQNUM_4: '4',
    MADDON_FILTER_VALUE_4: '',
    MADDON_FILTER_ALIAS_NAME_5: 'externalconfirm',
    MADDON_FILTER_OPERATOR_5: 'equals',
    MADDON_FILTER_JOINER_5: 'OR',
    MADDON_FILTER_SEQNUM_5: '5',
    MADDON_FILTER_VALUE_5: candidate.kind === 'external_reference' ? v : '',
    MADDON_LPAREN_5: 'true',
    MADDON_FILTER_ALIAS_NAME_6: 'guestNumber',
    MADDON_FILTER_OPERATOR_6: 'equals',
    MADDON_FILTER_JOINER_6: 'OR',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: '',
    MADDON_RPAREN_6: 'true',
    MADDON_FILTER_ALIAS_NAME_7: 'reservationstayid',
    MADDON_FILTER_OPERATOR_7: 'equals',
    MADDON_FILTER_JOINER_7: 'OR',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: '',
    MADDON_FILTER_ALIAS_NAME_8: 'accountnumber',
    MADDON_FILTER_OPERATOR_8: 'equals',
    MADDON_FILTER_JOINER_8: 'OR',
    MADDON_FILTER_SEQNUM_8: '8',
    MADDON_FILTER_VALUE_8: '',
    MADDON_FILTER_ALIAS_NAME_9: 'bookingdotcom',
    MADDON_FILTER_OPERATOR_9: 'equals',
    MADDON_FILTER_JOINER_9: 'OR',
    MADDON_FILTER_SEQNUM_9: '9',
    MADDON_FILTER_VALUE_9: '',
    MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
    MADDON_FILTER_OPERATOR_10: 'equals',
    MADDON_FILTER_JOINER_10: 'OR',
    MADDON_FILTER_SEQNUM_10: '10',
    MADDON_FILTER_VALUE_10: candidate.kind === 'external_reference' ? v : '',
    MADDON_RPAREN_10: 'true',
    externalconfirmation: candidate.kind === 'external_reference' ? v : '',
  };
  return body;
}

/** Per-session OSRESS.search rule — candidate value is fixed, not variable. */
export function buildExactOsressSearchRule(
  origin: string,
  candidate: ExactReservationCandidate,
): RequestRule {
  const body = buildExactOsressSearchBody(candidate);
  const fixedBody: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    fixedBody[key] = value;
  }
  return {
    id: 'live-osress-search-exact',
    origin,
    method: 'POST',
    path: LIVE_GUEST_STAY_SEARCH_PATH,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {},
    variableQuery: {},
    fixedBody,
    variableBody: {},
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/** Base live manifest + exact-bound OSRESS.search (only search allow path). */
export function buildExactOsressSearchManifest(
  origin: string,
  candidate: ExactReservationCandidate,
): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      ...buildLiveGuestStayFunctionalRules(origin),
      buildExactOsressSearchRule(origin, candidate),
    ],
  });
}

/** Canary candidate for not-found probes (exact-bound). */
export function liveNotFoundCanaryCandidate(): ExactReservationCandidate {
  return {
    id: 'notfound-canary',
    kind: 'confirmation',
    value: LIVE_NOTFOUND_CANARY,
  };
}
