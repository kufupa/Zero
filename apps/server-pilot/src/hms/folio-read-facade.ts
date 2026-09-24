/**
 * Tool-specific Folio + Deposit Ledger facade. This module alone owns raw page ops.
 * Production folio drivers receive only proven, inert operations.
 */
import {
  LIVE_DEPOSIT_LEDGER_DETAIL_PATH,
  LIVE_DEPOSIT_LEDGER_LIST_PATH,
  LIVE_DEPOSIT_LEDGER_OPEN_PATH,
  LIVE_FOLIO_OSRESS_OPEN_PATH,
  LIVE_GUEST_STAY_SEARCH_PATH,
  buildExactOsressSearchBody,
  type ExactReservationCandidate,
} from './live-read-manifest.js';
import {
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
} from './folio-read-contract.js';
import {
  HmsRuntimeError,
  type HmsPostFormResponseBounds,
  type HmsReadSession,
} from './runtime.js';

export type DepositLedgerDetailScope = {
  closingdate: string;
  property: string;
};

export type ValidatedFolioDetailValues = Record<string, string | number | null | undefined>;

const BOUND_FOLIO_ALL_DATA_PATH = '/web/base/OSRESV.FOL.xmlhttp';
const BOUND_FOLIO_CACHE_PATH = '/web/base/GETCACHE';
const BOUND_FOLIO_CACHE_POSITIONS = new Set([51, 101, 151]);
const DEFAULT_BOUND_FOLIO_RESPONSE_BOUNDS: HmsPostFormResponseBounds = {
  maxBytes: FOLIO_READ_MAX_BYTES,
  timeoutMs: FOLIO_READ_MAX_DURATION_MS,
};

const BOUND_FOLIO_DATA_FIELDS = [
  'confirmationnumber',
  'reservationstayid',
  'propertycode',
  'guestfullname',
  'account',
  'guestid',
  'hoteldate',
  'lastname',
  'firstname',
  'twitterid',
  'facebookid',
  'tripadvisorid',
  'bookingdotcomid',
  'room',
] as const;

function detailValue(values: ValidatedFolioDetailValues, field: string): string | null {
  const matches = Object.entries(values).filter(([key]) => key.toLowerCase() === field);
  if (matches.length !== 1) return null;
  const value = matches[0]![1];
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

const HOTEL_MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/** Normalize only calendar-valid reviewed OSRESV hotel-date forms. */
function normalizeBoundHotelDate(raw: string): string {
  const value = raw.trim().toUpperCase();
  let month: number;
  let day: number;
  let year: number;

  const mdy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const dmy = /^(\d{1,2})-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-(\d{4})$/.exec(value);
  if (mdy) {
    month = Number(mdy[1]);
    day = Number(mdy[2]);
    year = Number(mdy[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    month = HOTEL_MONTHS[dmy[2]!]!;
    year = Number(dmy[3]);
  } else {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'bound OSRESV.FOL hoteldate invalid');
  }

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
  if (year < 1 || !daysInMonth || day < 1 || day > daysInMonth) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'bound OSRESV.FOL hoteldate invalid');
  }
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

/** Build only the reviewed, detail-bound OSRESV.FOL request body. */
export function buildBoundFolioReadFields(input: {
  confirmationNumber: string;
  reservationStayId: string;
  expectedPropertyCode: string;
  detailValues: ValidatedFolioDetailValues;
}): Record<string, string> {
  const expectedConfirmation = input.confirmationNumber.trim();
  const expectedStayId = input.reservationStayId.trim();
  const expectedProperty = input.expectedPropertyCode.trim();
  if (!expectedConfirmation || !expectedStayId || !expectedProperty) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'bound OSRESV.FOL identity input is incomplete');
  }

  const fields: Record<string, string> = {
    SYSTEM_FUNCTION_NAME: 'OSRESV',
    USER_FUNCTION_NAME: 'OSRESV',
    CURRENT_TAB_NAME: 'FOL',
  };
  for (const field of BOUND_FOLIO_DATA_FIELDS) {
    const value = detailValue(input.detailValues, field);
    if (value === null) {
      throw new HmsRuntimeError('SCHEMA_DRIFT', `bound OSRESV.FOL detail field missing: ${field}`);
    }
    fields[field] = value;
  }

  if (fields.confirmationnumber.toUpperCase() !== expectedConfirmation.toUpperCase()) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'bound OSRESV.FOL confirmation mismatch');
  }
  if (fields.reservationstayid !== expectedStayId) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'bound OSRESV.FOL reservationstayid mismatch');
  }
  if (fields.propertycode !== expectedProperty) {
    throw new HmsRuntimeError('PROPERTY_MISMATCH', 'bound OSRESV.FOL property mismatch');
  }
  fields.hoteldate = normalizeBoundHotelDate(fields.hoteldate);
  return fields;
}

export interface FolioReadFacade {
  openOsressAndSearch(candidate: ExactReservationCandidate): Promise<string>;
  /** Legacy OSRESV.FOL compatibility path; bound callers use openBoundOsresvFol. */
  openOsresvFol(input: {
    confirmationNumber: string;
    reservationStayId?: string | null;
  }): Promise<string>;
  /** Open FOL using all validated detail fields; never guesses missing fields. */
  openBoundOsresvFol(input: {
    confirmationNumber: string;
    reservationStayId: string;
    detailValues: ValidatedFolioDetailValues;
    responseBounds?: HmsPostFormResponseBounds;
  }): Promise<string>;
  /** Initial reviewed All Folios DATA_ONLY page, bound to the detail proof. */
  openBoundFolioAllData(input: {
    confirmationNumber: string;
    reservationStayId: string;
    detailValues: ValidatedFolioDetailValues;
    responseBounds?: HmsPostFormResponseBounds;
  }): Promise<string>;
  /** Reviewed All Folios cache continuation; only captured positions are legal. */
  readBoundFolioCache(
    cursorPosition: number,
    responseBounds?: HmsPostFormResponseBounds,
  ): Promise<string>;
  /** OSLEDG open + OSLEDG.LST date list (no confirmation column). */
  openDepositLedgerList(): Promise<string>;
  /**
   * OSLEDG.DLD date detail — confirmationnumber / toaccount present.
   * paymentcardnumber may appear in transport; parser must not claim it.
   */
  openDepositLedgerDetail(scope: DepositLedgerDetailScope): Promise<string>;
}

export function createFolioReadFacade(
  session: HmsReadSession,
  options: { expectedPropertyCode?: string } = {},
): FolioReadFacade {
  const page = session.page;
  const expectedPropertyCode = options.expectedPropertyCode ?? 'HRCEN';
  let allDataSessionReady = false;
  return {
    async openOsressAndSearch(candidate) {
      await page
        .postForm(
          `${session.origin}${LIVE_FOLIO_OSRESS_OPEN_PATH}?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS`,
          {
            SYSTEM_FUNCTION_NAME: 'OSRESS',
            USER_FUNCTION_NAME: 'OSRESS',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          },
        )
        .catch(() => undefined);

      const body = buildExactOsressSearchBody(candidate);
      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(LIVE_GUEST_STAY_SEARCH_PATH)
        : Promise.resolve();
      const [post, correlated] = await Promise.allSettled([
        page.postForm(`${session.origin}${LIVE_GUEST_STAY_SEARCH_PATH}`, body),
        correlation,
      ]);
      if (post.status === 'rejected') throw post.reason;
      if (correlated.status === 'rejected') {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'folio OSRESS.search correlation failed');
      }
      return post.value || (await page.content());
    },

    async openOsresvFol(input) {
      const confirmation = String(input.confirmationNumber || '').trim();
      if (!confirmation) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'OSRESV.FOL requires confirmationNumber');
      }
      const fields: Record<string, string> = {
        confirmationnumber: confirmation,
        propertycode: expectedPropertyCode,
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'FOL',
      };
      const stayId = String(input.reservationStayId || '').trim();
      if (stayId) {
        fields.reservationstayid = stayId;
        fields.id = stayId;
      }
      return page.postForm(`${session.origin}/web/base/OSRESV.FOL`, fields);
    },

    async openBoundOsresvFol(input) {
      const fields = buildBoundFolioReadFields({
        confirmationNumber: input.confirmationNumber,
        reservationStayId: input.reservationStayId,
        expectedPropertyCode,
        detailValues: input.detailValues,
      });
      return page.postForm(
        `${session.origin}/web/base/OSRESV.FOL`,
        fields,
        input.responseBounds ?? DEFAULT_BOUND_FOLIO_RESPONSE_BOUNDS,
      );
    },

    async openBoundFolioAllData(input) {
      const fields = buildBoundFolioReadFields({
        confirmationNumber: input.confirmationNumber,
        reservationStayId: input.reservationStayId,
        expectedPropertyCode,
        detailValues: input.detailValues,
      });
      Object.assign(fields, {
        GRID_ID: '780',
        GRID_NAME: 'OSFOLO',
        DATASPY_ID: '836',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
      });
      const body = await page.postForm(
        `${session.origin}${BOUND_FOLIO_ALL_DATA_PATH}`,
        fields,
        input.responseBounds ?? DEFAULT_BOUND_FOLIO_RESPONSE_BOUNDS,
      );
      allDataSessionReady = typeof body === 'string';
      return body;
    },

    async readBoundFolioCache(cursorPosition, responseBounds) {
      if (!allDataSessionReady) {
        throw new HmsRuntimeError(
          'SOURCE_UNAVAILABLE',
          'bound All Folios cache requires the initial DATA_ONLY read',
        );
      }
      if (
        !Number.isSafeInteger(cursorPosition) ||
        !BOUND_FOLIO_CACHE_POSITIONS.has(cursorPosition)
      ) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'bound All Folios cache cursor is unreviewed');
      }
      return page.postForm(
        `${session.origin}${BOUND_FOLIO_CACHE_PATH}`,
        {
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          COMPONENT_INFO_TYPE_MODE: 'CACHE',
          GRID_ID: '780',
          GRID_NAME: 'OSFOLO',
          DATASPY_ID: '836',
          NUMBER_OF_ROWS_FIRST_RETURNED: '50',
          CACHE_REQUEST: 'false',
          CURSOR_POSITION: String(cursorPosition),
          CURRENT_TAB_NAME: 'FOL',
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'OSRESV',
        },
        responseBounds ?? DEFAULT_BOUND_FOLIO_RESPONSE_BOUNDS,
      );
    },

    async openDepositLedgerList() {
      await page
        .postForm(
          `${session.origin}${LIVE_DEPOSIT_LEDGER_OPEN_PATH}?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSLEDG`,
          {
            SYSTEM_FUNCTION_NAME: 'OSLEDG',
            USER_FUNCTION_NAME: 'OSLEDG',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          },
        )
        .catch(() => undefined);

      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(LIVE_DEPOSIT_LEDGER_LIST_PATH)
        : Promise.resolve();
      const [post, correlated] = await Promise.allSettled([
        page.postForm(`${session.origin}${LIVE_DEPOSIT_LEDGER_LIST_PATH}`, {
          SYSTEM_FUNCTION_NAME: 'OSLEDG',
          USER_FUNCTION_NAME: 'OSLEDG',
          CURRENT_TAB_NAME: 'LST',
        }),
        correlation,
      ]);
      if (post.status === 'rejected') throw post.reason;
      if (correlated.status === 'rejected') {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'deposit OSLEDG.LST correlation failed');
      }
      return post.value || (await page.content());
    },

    async openDepositLedgerDetail(scope) {
      if (scope.property.toUpperCase() !== expectedPropertyCode.toUpperCase()) {
        throw new HmsRuntimeError(
          'PROPERTY_MISMATCH',
          'deposit ledger detail property does not match the verified session property',
        );
      }
      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(LIVE_DEPOSIT_LEDGER_DETAIL_PATH)
        : Promise.resolve();
      const [post, correlated] = await Promise.allSettled([
        page.postForm(`${session.origin}${LIVE_DEPOSIT_LEDGER_DETAIL_PATH}`, {
          SYSTEM_FUNCTION_NAME: 'OSLEDG',
          USER_FUNCTION_NAME: 'OSLEDG',
          CURRENT_TAB_NAME: 'DLD',
          closingdate: scope.closingdate,
          property: scope.property,
        }),
        correlation,
      ]);
      if (post.status === 'rejected') throw post.reason;
      if (correlated.status === 'rejected') {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'deposit OSLEDG.DLD correlation failed');
      }
      return post.value || (await page.content());
    },
  };
}
