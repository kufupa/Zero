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
import { isoDateToHmsDisplay, type QuoteStayCandidate } from './quote-stay-candidate.js';

/** Guest Stay quick-search endpoint (not OSRESV). */
export const LIVE_GUEST_STAY_SEARCH_PATH = '/web/base/OSRESS.search';

/** Room Type and Rate Availability search (OSRRAV). */
export const LIVE_QUOTE_STAY_SEARCH_PATH = '/web/base/OSRRAV.HDR.search';

/** Canary confirmation token used in live not-found probes. */
export const LIVE_NOTFOUND_CANARY = 'NOTFOUND-CANARY';

const VAR64 = { pattern: '.{0,64}', maxLength: 64 } as const;
const VAR32 = { pattern: '.{0,32}', maxLength: 32 } as const;

function getStaticRule(
  origin: string,
  id: string,
  path: string,
  resourceTypes: Array<
    'stylesheet' | 'script' | 'image' | 'font' | 'document' | 'other' | 'xhr' | 'fetch'
  >,
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
    getStaticRule(origin, 'live-login-css', '/web/resources/inforhms/HMS-min.css', ['stylesheet']),
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
    getStaticRule(origin, 'live-login-logo-svg', '/web/resources/inforhms/images/shared/logo.svg', [
      'image',
    ]),
    // Live login also fetches shared/images/logo.svg typed as Playwright "other".
    {
      id: 'live-login-shared-logo-svg',
      origin,
      method: 'GET',
      path: '/web/resources/shared/images/logo.svg',
      resourceTypes: ['image', 'other'],
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
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
    getStaticRule(
      origin,
      'live-login-font-black',
      '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Black.ttf',
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
    getStaticRule(origin, 'live-common-aes', '/web/resources/shared/scripts/cryptojs/aes.js', [
      'script',
    ]),
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
    getStaticRule(origin, 'live-common-all-classes', '/web/base/all-classes.js', ['script']),
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
    // Soft-capture COMMON chrome GETs only (2026-08-03). Never mutation POSTs.
    getStaticRule(origin, 'live-toolbar-user', '/web/resources/inforhms/images/toolbar/user.svg', [
      'image',
      'other',
    ]),
    getStaticRule(origin, 'live-toolbar-help', '/web/resources/inforhms/images/toolbar/help.svg', [
      'image',
      'other',
    ]),
    getStaticRule(origin, 'live-toolbar-info', '/web/resources/inforhms/images/toolbar/info.svg', [
      'image',
      'other',
    ]),
    getStaticRule(
      origin,
      'live-toolbar-logout',
      '/web/resources/inforhms/images/toolbar/logout.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-overlay-line',
      '/web/resources/inforhms/images/toolbar/overlay-line.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-settings',
      '/web/resources/inforhms/images/toolbar/settings.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-save-icon',
      '/web/resources/inforhms/images/toolbar/save.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-refresh',
      '/web/resources/inforhms/images/toolbar/refresh.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-quick-access',
      '/web/resources/inforhms/images/toolbar/quick-access.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-caret-down',
      '/web/resources/inforhms/images/toolbar/caret-down.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-send-submit-icon',
      '/web/resources/inforhms/images/toolbar/send-submit.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-bullet-list',
      '/web/resources/inforhms/images/toolbar/bullet-list.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-expand-app-tray',
      '/web/resources/inforhms/images/toolbar/expand-app-tray.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-grid-hd-btn',
      '/web/resources/inforhms/images/grid/grid3-hd-btn.png',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-tree-caret-down',
      '/web/resources/inforhms/images/tree/caret-down.svg',
      ['image', 'other'],
    ),
    getStaticRule(origin, 'live-tree-folder', '/web/resources/inforhms/images/tree/folder.svg', [
      'image',
      'other',
    ]),
    // Soft-capture Front Desk expand (2026-08-03).
    getStaticRule(
      origin,
      'live-tree-open-folder',
      '/web/resources/inforhms/images/tree/open-folder.svg',
      ['image', 'other'],
    ),
    getStaticRule(origin, 'live-tree-dot', '/web/resources/inforhms/images/tree/dot.svg', [
      'image',
      'other',
    ]),
    getStaticRule(
      origin,
      'live-tree-plusminus-folder-closed',
      '/web/resources/inforhms/images/tree/plusminus-folder-closed.svg',
      ['image', 'other'],
    ),
    // Soft-capture Guest Stay chrome (2026-08-03).
    getStaticRule(
      origin,
      'live-toolbar-left-arrow',
      '/web/resources/inforhms/images/toolbar/left-arrow.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-delete',
      '/web/resources/inforhms/images/toolbar/delete.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-previous-page',
      '/web/resources/inforhms/images/toolbar/previous-page.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-next-page',
      '/web/resources/inforhms/images/toolbar/next-page.svg',
      ['image', 'other'],
    ),
    getStaticRule(origin, 'live-toolbar-copy', '/web/resources/inforhms/images/toolbar/copy.svg', [
      'image',
      'other',
    ]),
    getStaticRule(
      origin,
      'live-toolbar-reset',
      '/web/resources/inforhms/images/toolbar/reset.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-print',
      '/web/resources/inforhms/images/toolbar/print.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-print-preview',
      '/web/resources/inforhms/images/toolbar/print-preview.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-expand-left',
      '/web/resources/inforhms/images/toolbar/expand-left.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-split-view',
      '/web/resources/inforhms/images/toolbar/split-view.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-expand-right',
      '/web/resources/inforhms/images/toolbar/expand-right.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-room-rate-availability',
      '/web/resources/inforhms/images/hms/toolbar/room-rate-availability.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-room-type-availability',
      '/web/resources/inforhms/images/hms/toolbar/room-type-availability.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-money',
      '/web/resources/inforhms/images/toolbar/money.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-room-availability',
      '/web/resources/inforhms/images/hms/toolbar/room-availability.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-inventory',
      '/web/resources/inforhms/images/toolbar/inventory.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-employee-directory',
      '/web/resources/inforhms/images/hms/toolbar/employee-directory.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-interface-status',
      '/web/resources/inforhms/images/hms/toolbar/interface-status.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-interface-error',
      '/web/resources/inforhms/images/hms/toolbar/interface-error.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-filter-contains',
      '/web/resources/inforhms/images/toolbar/filter-contains.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-filter',
      '/web/resources/inforhms/images/toolbar/filter.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-no-filter',
      '/web/resources/inforhms/images/toolbar/no-filter.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-export-spreadsheet',
      '/web/resources/inforhms/images/toolbar/export-spreadsheet.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-util-splitter-drag',
      '/web/resources/inforhms/images/util/splitter/drag.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-close',
      '/web/resources/inforhms/images/toolbar/close.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-button-s-arrow-noline',
      '/web/resources/inforhms/images/button/s-arrow-noline.png',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-filter-equals',
      '/web/resources/inforhms/images/toolbar/filter-equals.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-toolbar-filter-selected-notselected',
      '/web/resources/inforhms/images/toolbar/filter-selected-notselected.svg',
      ['image', 'other'],
    ),
    getStaticRule(origin, 'live-slider-bg', '/web/resources/inforhms/images/slider/slider-bg.png', [
      'image',
      'other',
    ]),
    getStaticRule(
      origin,
      'live-slider-thumb',
      '/web/resources/inforhms/images/slider/slider-thumb.png',
      ['image', 'other'],
    ),
    {
      id: 'live-interface-status-alert',
      origin,
      method: 'GET',
      path: '/web/jsp/interfaceStatusAlert.jsp',
      resourceTypes: ['xhr', 'fetch', 'document'],
      fixedQuery: {},
      variableQuery: {
        // ExtJS cache-buster.
        _dc: { pattern: '[0-9]{0,20}', maxLength: 20 },
      },
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 65_536,
      redirectPolicy: 'same-reviewed-chain',
    },
    getStaticRule(
      origin,
      'live-toolbar-mingle-share',
      '/web/resources/inforhms/images/toolbar/mingle-share.svg',
      ['image', 'other'],
    ),
    getStaticRule(
      origin,
      'live-login-font-bold',
      '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Bold.ttf',
      ['font'],
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
      fixedBody: {
        MENU_MODULE_KEY: '0',
        SYSTEM_FUNCTION_NAME: 'BSSTRT',
        USER_FUNCTION_NAME: 'BSSTRT',
        removescreenflows: 'yes',
      },
      variableBody: {},
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
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'BSSTRT',
        USER_FUNCTION_NAME: 'BSSTRT',
        manurefresh: 'true',
      },
      variableBody: {},
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
      fixedQuery: {
        FUNCTION_CLASS: 'WEBL',
        USER_FUNCTION_NAME: 'OSRESV',
      },
      variableQuery: {},
      fixedBody: {
        CURRENT_TAB_NAME: '',
        FUNCTION_CLASS: 'WEBL',
        MENU_MODULE_KEY: '0',
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        removescreenflows: 'yes',
      },
      variableBody: {},
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
      fixedBody: {
        CURRENT_TAB_NAME: 'HDR',
        MENU_MODULE_KEY: '0',
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        removescreenflows: 'yes',
      },
      variableBody: {
        account: VAR64,
        bookingdotcomid: VAR64,
        confirmationnumber: VAR64,
        facebookid: VAR64,
        firstname: VAR64,
        guestfullname: VAR64,
        guestid: VAR64,
        hoteldate: VAR32,
        lastname: VAR64,
        propertycode: { pattern: 'HRCEN|', maxLength: 16 },
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
      fixedBody: {
        CURRENT_TAB_NAME: 'LST',
        MENU_MODULE_KEY: '0',
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        removescreenflows: 'yes',
      },
      variableBody: {
        COMPONENT_INFO_TYPE: VAR64,
      },
      maxBodyBytes: 16_384,
      redirectPolicy: 'same-reviewed-chain',
    },
  ];
}

/** Request-policy-only manifest for unit tests / production live sessions. */
export function buildLiveGuestStayReadManifest(origin: string): RequestPolicyManifest {
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

/** Wave 0b: dump-proved lastname filter + stay dates (not firstname). */
export type SurnameDatesReservationCandidate = {
  id: string;
  kind: 'surname_dates';
  surname: string;
  arrivalDate: string;
  departureDate: string;
};

/** OSRESS.search candidate: exact identity or surname+dates. */
export type ReservationSearchCandidate =
  | ExactReservationCandidate
  | SurnameDatesReservationCandidate;

const EXACT_CHROME_FIXED = {
  // Soft-captured ExtJS Guest Stay dataspy "All" (HRCEN, 2026-08-03).
  COMPONENT_INFO_TYPE: 'DATA_ONLY',
  GRID_ID: '1775',
  GRID_NAME: 'OSRESS',
  DATASPY_ID: '1941',
  SYSTEM_FUNCTION_NAME: 'OSRESS',
  USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'LST',
} as const;

/**
 * Non-empty filler for unused OR slots. Empty BEGINS/= slots are wildcards and
 * return the full date-window grid; canary fills every slot with the same token.
 */
export const OSRESS_OR_UNUSED_TOKEN = '___NOMATCH___';

/**
 * Reviewed soft-capture filter scaffold with exact candidate value pinned in
 * confirmation or external-reference slots. Alias/operator drift blocks.
 * Dataspy 1941 uses date-window + BEGINS OR-chain (not the old equals scaffold).
 *
 * Not-found canary: all OR slots = candidate (matches live quick-search fill).
 * Real confirmation: only confirmation slot = value; other OR slots = unused.
 * Real external_reference: only externalconfirmation slots = value.
 * Real surname_dates: lastname_filter family = surname; conf/ext/room unused;
 * date window stays relative (±365); row correlate enforces arrival/departure.
 */
export function buildExactOsressSearchBody(
  candidate: ReservationSearchCandidate,
): Record<string, string> {
  const unused = OSRESS_OR_UNUSED_TOKEN;
  const isSurname = candidate.kind === 'surname_dates';
  const v = isSurname ? candidate.surname : candidate.value;
  const isCanary = !isSurname && v === LIVE_NOTFOUND_CANARY;
  const confVal =
    isCanary || candidate.kind === 'confirmation' ? (isSurname ? unused : v) : unused;
  const extVal =
    isCanary || candidate.kind === 'external_reference' ? (isSurname ? unused : v) : unused;
  const otherOr = isCanary ? v : unused;
  const lastnameVal = isCanary || isSurname ? v : unused;
  // Canary stays tight (±30). Real lookups widen so future-dated stays resolve.
  const departWindow = isCanary ? '-30' : '-365';
  const arriveWindow = isCanary ? '+30' : '+365';

  const body: Record<string, string> = {
    ...EXACT_CHROME_FIXED,
    MADDON_FILTER_ALIAS_NAME_1: 'departuredate',
    MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_JOINER_1: 'AND',
    MADDON_FILTER_SEQNUM_1: '1',
    MADDON_FILTER_VALUE_1: departWindow,
    MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
    MADDON_FILTER_OPERATOR_2: '<=',
    MADDON_FILTER_JOINER_2: 'AND',
    MADDON_FILTER_SEQNUM_2: '2',
    MADDON_FILTER_VALUE_2: arriveWindow,
    MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
    MADDON_FILTER_OPERATOR_3: 'BEGINS',
    MADDON_FILTER_JOINER_3: 'OR',
    MADDON_FILTER_SEQNUM_3: '3',
    MADDON_FILTER_VALUE_3: confVal,
    MADDON_LPAREN_3: 'true',
    MADDON_FILTER_ALIAS_NAME_4: 'room',
    MADDON_FILTER_OPERATOR_4: '=',
    MADDON_FILTER_JOINER_4: 'OR',
    MADDON_FILTER_SEQNUM_4: '4',
    MADDON_FILTER_VALUE_4: otherOr,
    MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter',
    MADDON_FILTER_OPERATOR_5: 'BEGINS',
    MADDON_FILTER_JOINER_5: 'OR',
    MADDON_FILTER_SEQNUM_5: '5',
    MADDON_FILTER_VALUE_5: lastnameVal,
    MADDON_LPAREN_5: 'false',
    MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
    MADDON_FILTER_OPERATOR_6: 'BEGINS',
    MADDON_FILTER_JOINER_6: 'OR',
    MADDON_FILTER_SEQNUM_6: '6',
    MADDON_FILTER_VALUE_6: lastnameVal,
    MADDON_RPAREN_6: 'false',
    MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
    MADDON_FILTER_OPERATOR_7: 'BEGINS',
    MADDON_FILTER_JOINER_7: 'OR',
    MADDON_FILTER_SEQNUM_7: '7',
    MADDON_FILTER_VALUE_7: lastnameVal,
    MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
    MADDON_FILTER_OPERATOR_8: 'BEGINS',
    MADDON_FILTER_JOINER_8: 'OR',
    MADDON_FILTER_SEQNUM_8: '8',
    MADDON_FILTER_VALUE_8: lastnameVal,
    MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
    MADDON_FILTER_OPERATOR_9: 'BEGINS',
    MADDON_FILTER_JOINER_9: 'OR',
    MADDON_FILTER_SEQNUM_9: '9',
    MADDON_FILTER_VALUE_9: otherOr,
    MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
    MADDON_FILTER_OPERATOR_10: 'BEGINS',
    MADDON_FILTER_JOINER_10: 'OR',
    MADDON_FILTER_SEQNUM_10: '10',
    MADDON_FILTER_VALUE_10: extVal,
    MADDON_RPAREN_10: 'true',
    externalconfirmation: extVal,
  };
  return body;
}

/** UI fill token for video / ExtJS Enter fallback. */
export function osressSearchFillValue(candidate: ReservationSearchCandidate): string {
  return candidate.kind === 'surname_dates' ? candidate.surname : candidate.value;
}

/** Per-session OSRESS.search rule — filter + chrome fields variable.
 * ExtJS Guest Stay quick-search (fill+Enter) posts a dataspy scaffold whose
 * exact chrome/filter values drift vs our soft-capture snapshot; pinning them
 * as fixedBody blocked live UI search (changed_fixed_body / missing_fixed_body).
 * Path stays OSRESS.search only; mutation scan still fail-closes. Candidate
 * binding enforced by fill + correlateObservations.
 */
export function buildExactOsressSearchRule(
  origin: string,
  candidate: ReservationSearchCandidate,
): RequestRule {
  void candidate;
  const filterVar = { pattern: '.{0,128}', maxLength: 128 } as const;
  const shortVar = { pattern: '.{0,64}', maxLength: 64 } as const;
  const opVar = { pattern: '.{0,16}', maxLength: 16 } as const;
  const joinVar = { pattern: '.{0,8}', maxLength: 8 } as const;
  const variableBody: RequestRule['variableBody'] = {
    COMPONENT_INFO_TYPE: shortVar,
    GRID_ID: shortVar,
    GRID_NAME: shortVar,
    DATASPY_ID: shortVar,
    SYSTEM_FUNCTION_NAME: shortVar,
    USER_FUNCTION_NAME: shortVar,
    CURRENT_TAB_NAME: shortVar,
    MADDON_FILTER_ALIAS_NAME_1: shortVar,
    MADDON_FILTER_OPERATOR_1: opVar,
    MADDON_FILTER_JOINER_1: joinVar,
    MADDON_FILTER_SEQNUM_1: joinVar,
    MADDON_FILTER_VALUE_1: filterVar,
    MADDON_FILTER_ALIAS_NAME_2: shortVar,
    MADDON_FILTER_OPERATOR_2: opVar,
    MADDON_FILTER_JOINER_2: joinVar,
    MADDON_FILTER_SEQNUM_2: joinVar,
    MADDON_FILTER_VALUE_2: filterVar,
    MADDON_FILTER_ALIAS_NAME_3: shortVar,
    MADDON_FILTER_OPERATOR_3: opVar,
    MADDON_FILTER_JOINER_3: joinVar,
    MADDON_FILTER_SEQNUM_3: joinVar,
    MADDON_FILTER_VALUE_3: filterVar,
    MADDON_LPAREN_3: joinVar,
    MADDON_FILTER_ALIAS_NAME_4: shortVar,
    MADDON_FILTER_OPERATOR_4: opVar,
    MADDON_FILTER_JOINER_4: joinVar,
    MADDON_FILTER_SEQNUM_4: joinVar,
    MADDON_FILTER_VALUE_4: filterVar,
    MADDON_FILTER_ALIAS_NAME_5: shortVar,
    MADDON_FILTER_OPERATOR_5: opVar,
    MADDON_FILTER_JOINER_5: joinVar,
    MADDON_FILTER_SEQNUM_5: joinVar,
    MADDON_FILTER_VALUE_5: filterVar,
    MADDON_LPAREN_5: joinVar,
    MADDON_FILTER_ALIAS_NAME_6: shortVar,
    MADDON_FILTER_OPERATOR_6: opVar,
    MADDON_FILTER_JOINER_6: joinVar,
    MADDON_FILTER_SEQNUM_6: joinVar,
    MADDON_FILTER_VALUE_6: filterVar,
    MADDON_RPAREN_6: joinVar,
    MADDON_FILTER_ALIAS_NAME_7: shortVar,
    MADDON_FILTER_OPERATOR_7: opVar,
    MADDON_FILTER_JOINER_7: joinVar,
    MADDON_FILTER_SEQNUM_7: joinVar,
    MADDON_FILTER_VALUE_7: filterVar,
    MADDON_FILTER_ALIAS_NAME_8: shortVar,
    MADDON_FILTER_OPERATOR_8: opVar,
    MADDON_FILTER_JOINER_8: joinVar,
    MADDON_FILTER_SEQNUM_8: joinVar,
    MADDON_FILTER_VALUE_8: filterVar,
    MADDON_FILTER_ALIAS_NAME_9: shortVar,
    MADDON_FILTER_OPERATOR_9: opVar,
    MADDON_FILTER_JOINER_9: joinVar,
    MADDON_FILTER_SEQNUM_9: joinVar,
    MADDON_FILTER_VALUE_9: filterVar,
    MADDON_FILTER_ALIAS_NAME_10: shortVar,
    MADDON_FILTER_OPERATOR_10: opVar,
    MADDON_FILTER_JOINER_10: joinVar,
    MADDON_FILTER_SEQNUM_10: joinVar,
    MADDON_FILTER_VALUE_10: filterVar,
    MADDON_RPAREN_10: joinVar,
    externalconfirmation: filterVar,
  };
  return {
    id: 'live-osress-search-exact',
    origin,
    method: 'POST',
    path: LIVE_GUEST_STAY_SEARCH_PATH,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {},
    variableQuery: {},
    fixedBody: {},
    variableBody,
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/** Base live manifest + exact-bound OSRESS.search (only search allow path). */
export function buildExactOsressSearchManifest(
  origin: string,
  candidate: ReservationSearchCandidate,
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

/**
 * Exact OSRRAV.HDR.search body: chrome defaults from open surface + candidate binds.
 * Official Search is view-only availability (never CRS Check Availability).
 */
export function buildExactOsrravSearchBody(
  candidate: QuoteStayCandidate,
  chrome: Record<string, string> = {},
): Record<string, string> {
  const start = isoDateToHmsDisplay(candidate.arrivalDate);
  const requestedCurrency = candidate.currency ?? chrome.currency ?? 'ZAR';
  const property = chrome.property || 'HRCEN';
  const salesstrategy = chrome.salesstrategy || 'TRANSI';
  return {
    extId: chrome.extId ?? '',
    property,
    roomtypes: candidate.roomType,
    rateplans: candidate.ratePlan,
    salesstrategy,
    showunavailable: chrome.showunavailable ?? '0',
    ratetype: chrome.ratetype ?? '',
    adults: String(candidate.adults),
    showexclusiverates: chrome.showexclusiverates ?? '0',
    showavailableforsale: chrome.showavailableforsale ?? 'on',
    children: String(candidate.children),
    startdate: start,
    currency: requestedCurrency,
    rowpagesize: chrome.rowpagesize ?? '14',
    pravailable: '',
    prsold: '',
    prtransientsold: '',
    prgroupsold: '',
    prallocation: '',
    prsellableinv: '',
    prinvadjustment: '',
    proutoforder: '',
    proutofinv: '',
    proverbookinglimit: '',
    prphysicalinv: '',
    rtavailable: '',
    rtsold: '',
    rttransientsold: '',
    rtgroupsold: '',
    rtallocation: '',
    rtsellableinv: '',
    rtinvadjustment: '',
    rtoutoforder: '',
    rtoutofinv: '',
    rtoverbookinglimit: '',
    rtphysicalinv: '',
    salesstrategy_display: chrome.salesstrategy_display || salesstrategy,
    ratetype_display: chrome.ratetype_display ?? '',
    adults_display: String(candidate.adults),
    children_display: String(candidate.children),
    currency_display: requestedCurrency,
    hoteldate: chrome.hoteldate ?? '',
    firstcolumndate: chrome.firstcolumndate ?? start,
    propertylabel: '',
    roomtypelabel: '',
    isPopup: '',
    avDetailPropertyText: '',
    avDetailRoomTypeText: '',
    can_insert: '',
    can_delete: '',
    can_update: '',
    pagemode: chrome.pagemode ?? 'display',
    recordid: '',
    ONLY_DATA_REQUIRED: chrome.ONLY_DATA_REQUIRED ?? 'true',
    pageaction: '',
    USER_FUNCTION_NAME: 'OSRRAV',
    SYSTEM_FUNCTION_NAME: 'OSRRAV',
    CURRENT_TAB_NAME: 'HDR',
  };
}

export function buildExactOsrravSearchRule(
  origin: string,
  candidate: QuoteStayCandidate,
  chrome: Record<string, string> = {},
): RequestRule {
  // The release binds this reviewed template, while the trusted producer
  // binds candidate values in the request body. Candidate fields remain
  // bounded variables; property and read-only chrome invariants stay fixed.
  void chrome;
  const body = buildExactOsrravSearchBody(candidate, {});
  const variableBody: Record<string, { pattern: string; maxLength: number }> = {
    extId: { pattern: '[A-Za-z0-9._:-]{0,64}', maxLength: 64 },
    roomtypes: { pattern: '[A-Za-z0-9][A-Za-z0-9._/-]{0,31}', maxLength: 32 },
    rateplans: { pattern: '[A-Za-z0-9][A-Za-z0-9._/-]{0,31}', maxLength: 32 },
    adults: { pattern: '[1-9][0-9]?', maxLength: 2 },
    children: { pattern: '[0-9]{1,2}', maxLength: 2 },
    startdate: { pattern: '[0-9]{2}-[A-Z]{3}-[0-9]{4}', maxLength: 11 },
    currency: { pattern: '[A-Z]{3}', maxLength: 3 },
    adults_display: { pattern: '[1-9][0-9]?', maxLength: 2 },
    children_display: { pattern: '[0-9]{1,2}', maxLength: 2 },
    currency_display: { pattern: '[A-Z]{3}', maxLength: 3 },
    hoteldate: { pattern: '(?:|[0-9]{2}-[A-Z]{3}-[0-9]{4})', maxLength: 11 },
    firstcolumndate: { pattern: '[0-9]{2}-[A-Z]{3}-[0-9]{4}', maxLength: 11 },
  };
  const fixedBody: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!variableBody[key]) fixedBody[key] = value;
  }
  return {
    id: 'live-osrrav-search-exact',
    origin,
    method: 'POST',
    path: LIVE_QUOTE_STAY_SEARCH_PATH,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {},
    variableQuery: {},
    fixedBody,
    variableBody,
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/** Base chrome + exact-bound OSRRAV.HDR.search (quote allow path). */
export function buildExactOsrravSearchManifest(
  origin: string,
  candidate: QuoteStayCandidate,
  chrome: Record<string, string> = {},
): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      {
        id: 'live-osrrav-open',
        origin,
        method: 'POST',
        path: '/web/base/OSRRAV',
        resourceTypes: ['xhr', 'fetch'],
        contentType: 'application/x-www-form-urlencoded',
        fixedQuery: {},
        variableQuery: {
          USER_FUNCTION_NAME: VAR64,
          FUNCTION_CLASS: VAR32,
        },
        fixedBody: {
          USER_FUNCTION_NAME: 'OSRRAV',
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        },
        variableBody: {},
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain',
      },
      {
        id: 'live-osrrav-hdr',
        origin,
        method: 'POST',
        path: '/web/base/OSRRAV.HDR',
        resourceTypes: ['xhr', 'fetch'],
        contentType: 'application/x-www-form-urlencoded',
        fixedQuery: {},
        variableQuery: {},
        fixedBody: {
          SYSTEM_FUNCTION_NAME: 'OSRRAV',
          USER_FUNCTION_NAME: 'OSRRAV',
          CURRENT_TAB_NAME: 'HDR',
        },
        variableBody: {},
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain',
      },
      buildExactOsrravSearchRule(origin, candidate, chrome),
    ],
  });
}

/** Folio balance via Guest Stay shell (OSRESS) — proven 2026-08-06 abort-first discovery. */
export const LIVE_FOLIO_OSRESS_OPEN_PATH = '/web/base/OSRESS';

/** Deposit Ledger list (OSLEDG.LST) — proven 2026-08-06 abort-first discovery. */
export const LIVE_DEPOSIT_LEDGER_OPEN_PATH = '/web/base/OSLEDG';
export const LIVE_DEPOSIT_LEDGER_LIST_PATH = '/web/base/OSLEDG.LST';
/** Deposit Ledger date-detail grid (confirmationnumber). Requires closingdate+property. */
export const LIVE_DEPOSIT_LEDGER_DETAIL_PATH = '/web/base/OSLEDG.DLD';

/** Sent Email list endpoint (PSSNEL.HDR) — proven 2026-08-06 abort-first discovery. */
export const LIVE_SENT_EMAIL_OPEN_PATH = '/web/base/PSSNEL';
export const LIVE_SENT_EMAIL_LIST_PATH = '/web/base/PSSNEL.HDR';

/**
 * Functional Sent Email POSTs: open PSSNEL + list HDR only.
 * Search/print/email/resend/attachment paths are structurally absent.
 */
export function buildLiveSentEmailFunctionalRules(origin: string): RequestRule[] {
  return [
    {
      id: 'live-login-post',
      origin,
      method: 'POST',
      path: '/web/base/login',
      resourceTypes: ['document', 'xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {},
      variableBody: {
        tenant: { pattern: '.{0,32}', maxLength: 32 },
        USER_FUNCTION_NAME: { pattern: '.{0,64}', maxLength: 64 },
        SYSTEM_FUNCTION_NAME: { pattern: '.{0,64}', maxLength: 64 },
        userid: { pattern: '.{0,128}', maxLength: 128 },
        password: { pattern: '.{0,256}', maxLength: 256 },
        csrftckt: { pattern: '.{0,256}', maxLength: 256 },
        resetpassword: { pattern: '.{0,8}', maxLength: 8 },
      },
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
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
      id: 'live-bsstrt-open',
      origin,
      method: 'POST',
      path: '/web/base/BSSTRT',
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'BSSTRT',
        USER_FUNCTION_NAME: 'BSSTRT',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
      variableBody: {},
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
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'BSSTRT',
        USER_FUNCTION_NAME: 'BSSTRT',
        manurefresh: 'yes',
      },
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-pssnel-open',
      origin,
      method: 'POST',
      path: LIVE_SENT_EMAIL_OPEN_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {
        USER_FUNCTION_NAME: VAR64,
        FUNCTION_CLASS: VAR32,
      },
      fixedBody: {
        USER_FUNCTION_NAME: 'PSSNEL',
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-pssnel-hdr-list',
      origin,
      method: 'POST',
      path: LIVE_SENT_EMAIL_LIST_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        USER_FUNCTION_NAME: 'PSSNEL',
        CURRENT_TAB_NAME: 'HDR',
      },
      variableBody: {},
      maxBodyBytes: 65_536,
      redirectPolicy: 'same-reviewed-chain',
    },
  ];
}

/** Session manifest for Sent Email list (shared by audit + sent-document branches). */
export function buildLiveSentEmailListManifest(origin: string): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      ...buildLiveSentEmailFunctionalRules(origin),
    ],
  });
}

/**
 * Folio balance functional POSTs: OSRESS open + exact OSRESS.search only.
 * Folio settlement / post / print / email / advance-deposit paths absent.
 */
export function buildLiveFolioFunctionalRules(origin: string): RequestRule[] {
  return [
    {
      id: 'live-folio-osress-open',
      origin,
      method: 'POST',
      path: LIVE_FOLIO_OSRESS_OPEN_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {
        USER_FUNCTION_NAME: VAR64,
        FUNCTION_CLASS: VAR32,
      },
      fixedBody: {
        USER_FUNCTION_NAME: 'OSRESS',
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-folio-osress-search',
      origin,
      method: 'POST',
      path: LIVE_GUEST_STAY_SEARCH_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_ID: '1775',
        GRID_NAME: 'OSRESS',
        DATASPY_ID: '1941',
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'LST',
      },
      variableBody: {
        MADDON_FILTER_ALIAS_NAME_1: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_1: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_1: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_1: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_1: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_ALIAS_NAME_2: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_2: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_2: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_2: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_2: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_ALIAS_NAME_3: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_3: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_3: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_3: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_3: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_LPAREN_3: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_ALIAS_NAME_4: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_4: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_4: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_4: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_4: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_FILTER_ALIAS_NAME_5: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_5: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_5: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_5: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_5: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_LPAREN_5: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_ALIAS_NAME_6: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_6: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_6: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_6: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_6: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_RPAREN_6: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_ALIAS_NAME_7: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_7: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_7: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_7: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_7: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_FILTER_ALIAS_NAME_8: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_8: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_8: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_8: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_8: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_FILTER_ALIAS_NAME_9: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_9: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_9: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_9: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_9: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_FILTER_ALIAS_NAME_10: { pattern: '.{0,64}', maxLength: 64 },
        MADDON_FILTER_OPERATOR_10: { pattern: '.{0,16}', maxLength: 16 },
        MADDON_FILTER_JOINER_10: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_SEQNUM_10: { pattern: '.{0,8}', maxLength: 8 },
        MADDON_FILTER_VALUE_10: { pattern: '.{0,128}', maxLength: 128 },
        MADDON_RPAREN_10: { pattern: '.{0,8}', maxLength: 8 },
        externalconfirmation: { pattern: '.{0,128}', maxLength: 128 },
      },
      maxBodyBytes: 16_384,
      redirectPolicy: 'same-reviewed-chain',
    },
  ];
}

export function buildLiveFolioReadManifest(origin: string): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [...buildLiveGuestStayChromeGetRules(origin), ...buildLiveFolioFunctionalRules(origin)],
  });
}

/**
 * Deposit Ledger functional POSTs: OSLEDG open + LST (date list) + DLD (detail).
 * Advance Deposit form / post / refund / transfer / saveExcel / card capture absent.
 * DLD soft-capture body keys: CURRENT_TAB_NAME, SYSTEM/USER_FUNCTION_NAME,
 * closingdate, property (2026-08-07 Property Ledger → Deposit Ledger row activate).
 */
export function buildLiveDepositLedgerFunctionalRules(
  origin: string,
  expectedPropertyCode = 'HRCEN',
): RequestRule[] {
  const propertyCode = expectedPropertyCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(propertyCode)) {
    throw new Error('deposit ledger expected property code is invalid');
  }
  return [
    {
      id: 'live-osledg-open',
      origin,
      method: 'POST',
      path: LIVE_DEPOSIT_LEDGER_OPEN_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {
        USER_FUNCTION_NAME: VAR64,
        FUNCTION_CLASS: VAR32,
      },
      fixedBody: {
        USER_FUNCTION_NAME: 'OSLEDG',
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osledg-lst',
      origin,
      method: 'POST',
      path: LIVE_DEPOSIT_LEDGER_LIST_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: 'LST',
      },
      variableBody: {},
      maxBodyBytes: 65_536,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-osledg-dld',
      origin,
      method: 'POST',
      path: LIVE_DEPOSIT_LEDGER_DETAIL_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'OSLEDG',
        USER_FUNCTION_NAME: 'OSLEDG',
        CURRENT_TAB_NAME: 'DLD',
      },
      variableBody: {
        closingdate: { pattern: '.{1,32}', maxLength: 32 },
        property: { pattern: propertyCode, maxLength: 16 },
      },
      maxBodyBytes: 65_536,
      redirectPolicy: 'same-reviewed-chain',
    },
  ];
}

export function buildLiveDepositLedgerManifest(
  origin: string,
  expectedPropertyCode = 'HRCEN',
): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      ...buildLiveDepositLedgerFunctionalRules(origin, expectedPropertyCode),
    ],
  });
}

/** Group Booking open (GSGRPB) — Task 17 soft-capture. */
export const LIVE_GROUP_BLOCK_OPEN_PATH = '/web/base/GSGRPB';

/** Group Booking list grid. */
export const LIVE_GROUP_BLOCK_LIST_PATH = '/web/base/GSGRPB.LST';

/**
 * Group block functional POSTs: GSGRPB open + GSGRPB.LST only.
 * BLK/HDR detail, save, create, assign, rooming, focus/input absent.
 */
export function buildLiveGroupBlockFunctionalRules(origin: string): RequestRule[] {
  return [
    {
      id: 'live-gsgrpb-open',
      origin,
      method: 'POST',
      path: LIVE_GROUP_BLOCK_OPEN_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {
        USER_FUNCTION_NAME: VAR64,
        FUNCTION_CLASS: VAR32,
      },
      fixedBody: {
        USER_FUNCTION_NAME: 'GSGRPB',
        SYSTEM_FUNCTION_NAME: 'GSGRPB',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain',
    },
    {
      id: 'live-gsgrpb-lst',
      origin,
      method: 'POST',
      path: LIVE_GROUP_BLOCK_LIST_PATH,
      resourceTypes: ['xhr', 'fetch'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'GSGRPB',
        USER_FUNCTION_NAME: 'GSGRPB',
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: 'GSGRPB',
      },
      variableBody: {},
      maxBodyBytes: 65_536,
      redirectPolicy: 'same-reviewed-chain',
    },
  ];
}

export function buildLiveGroupBlockListManifest(origin: string): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      ...buildLiveGroupBlockFunctionalRules(origin),
    ],
  });
}
