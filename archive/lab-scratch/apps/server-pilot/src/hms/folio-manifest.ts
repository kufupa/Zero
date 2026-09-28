/** Neutral, exact-bound OSRESV.FOL refresh request shape. */
import { buildBoundFolioReadFields, type ValidatedFolioDetailValues } from '../../../../../../apps/server-pilot/src/hms/folio-read-facade.js';
import { buildLiveDepositLedgerFunctionalRules } from '../../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import type { RequestRule } from '../../../../../../apps/server-pilot/src/hms/contracts.js';

export const FOLIO_REFRESH_PATH = '/web/base/OSRESV.FOL';
export const BOUND_FOLIO_REFRESH_QUERY = {} as const;

/** Captured display-only ledger tab, bound to one independently selected day. */
export function buildPropertyLedgerDetailReadRule(
  origin: string,
  property: string,
  closingdate: string,
): RequestRule {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(closingdate);
  if (!match) throw new Error('LEDGER_DATE_INVALID');
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    throw new Error('LEDGER_DATE_INVALID');
  const rule = buildLiveDepositLedgerFunctionalRules(origin, property).find(
    (r) => r.id === 'live-osledg-dld',
  )!;
  return {
    ...rule,
    fixedBody: { ...rule.fixedBody, property: property.trim().toUpperCase(), closingdate },
    variableBody: {},
  };
}

/** Exact UI entry/list requests captured for display-only Property Ledger. */
export function buildPropertyLedgerEntryReadRules(origin: string): RequestRule[] {
  return buildLiveDepositLedgerFunctionalRules(origin, 'HRCEN')
    .filter((rule) => rule.id === 'live-osledg-open' || rule.id === 'live-osledg-lst')
    .map((rule) =>
      rule.id === 'live-osledg-open'
        ? {
            ...rule,
            fixedQuery: { USER_FUNCTION_NAME: 'OSLEDG', FUNCTION_CLASS: 'WEBL' },
            variableQuery: {},
          }
        : { ...rule, fixedBody: { ...rule.fixedBody, property: '', closingdate: '' } },
    );
}

/**
 * Read continuation of the already loaded All Folios grid, on the same serial
 * session. GETCACHE has no parent fields: callers must validate the prior page
 * and every returned row against their exact stay/account/property proof.
 */
export function buildFolioCacheReadRule(input: {
  origin: string;
  cursorPosition: number;
}): RequestRule {
  if (![51, 101, 151].includes(input.cursorPosition)) throw new Error('FOLIO_CACHE_CURSOR_INVALID');
  return {
    id: `live-folio-cache-${input.cursorPosition}`,
    origin: input.origin,
    method: 'POST',
    path: '/web/base/GETCACHE',
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {},
    variableQuery: {},
    variableBody: {},
    maxBodyBytes: 4096,
    redirectPolicy: 'same-reviewed-chain',
    fixedBody: {
      COMPONENT_INFO_TYPE: 'DATA_ONLY',
      COMPONENT_INFO_TYPE_MODE: 'CACHE',
      GRID_ID: '780',
      GRID_NAME: 'OSFOLO',
      DATASPY_ID: '836',
      NUMBER_OF_ROWS_FIRST_RETURNED: '50',
      CACHE_REQUEST: 'false',
      CURSOR_POSITION: String(input.cursorPosition),
      CURRENT_TAB_NAME: 'FOL',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    },
  };
}

export type BoundFolioDetailValues = ValidatedFolioDetailValues;

/** Build only captured detail fields plus reviewed refresh controls. */
export function buildBoundFolioRefreshRequest(input: {
  confirmationNumber: string;
  reservationStayId: string;
  expectedPropertyCode: string;
  detailValues: BoundFolioDetailValues;
}): {
  path: typeof FOLIO_REFRESH_PATH;
  query: typeof BOUND_FOLIO_REFRESH_QUERY;
  fields: Record<string, string>;
} {
  const expectedConfirmation = input.confirmationNumber.trim();
  const expectedStayId = input.reservationStayId.trim();
  const expectedProperty = input.expectedPropertyCode.trim();
  const fields = buildBoundFolioReadFields({
    confirmationNumber: expectedConfirmation,
    reservationStayId: expectedStayId,
    expectedPropertyCode: expectedProperty,
    detailValues: input.detailValues,
  });
  fields.THROW_EXCEPTION = 'false';
  fields.REFRESH_GRID = 'false';
  fields.ONLY_DATA_REQUIRED = 'true';
  return { path: FOLIO_REFRESH_PATH, query: BOUND_FOLIO_REFRESH_QUERY, fields };
}

/** Build exact transport permission for one already-correlated FOL refresh. */
export function buildBoundFolioRefreshRule(input: {
  origin: string;
  confirmationNumber: string;
  reservationStayId: string;
  expectedPropertyCode: string;
  detailValues: BoundFolioDetailValues;
}): RequestRule {
  const request = buildBoundFolioRefreshRequest(input);
  return {
    id: 'live-folio-osresv-fol-refresh',
    origin: input.origin,
    method: 'POST',
    path: request.path,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: request.query,
    variableQuery: {},
    fixedBody: request.fields,
    variableBody: {},
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/** Captured All Folios dataspy header read; never changes folio business data. */
export function buildBoundFolioAllGridRule(
  input: Parameters<typeof buildBoundFolioRefreshRule>[0],
): RequestRule {
  const fixedBody = buildBoundFolioReadFields(input);
  Object.assign(fixedBody, {
    GRID_ID: '780',
    GRID_NAME: 'OSFOLO',
    DATASPY_ID: '836',
    COMPONENT_INFO_TYPE: 'HEAD_ONLY',
    pagemode: 'display',
  });
  return {
    ...buildBoundFolioRefreshRule(input),
    id: 'live-folio-osresv-all-grid',
    fixedBody,
  };
}

/** Captured All Folios Run query. Exact parent, no paging or write parameters. */
export function buildBoundFolioAllDataRule(
  input: Parameters<typeof buildBoundFolioRefreshRule>[0],
): RequestRule {
  const fixedBody = buildBoundFolioReadFields(input);
  Object.assign(fixedBody, {
    GRID_ID: '780',
    GRID_NAME: 'OSFOLO',
    DATASPY_ID: '836',
    COMPONENT_INFO_TYPE: 'DATA_ONLY',
  });
  return {
    ...buildBoundFolioRefreshRule(input),
    id: 'live-folio-osresv-all-data',
    path: '/web/base/OSRESV.FOL.xmlhttp',
    fixedBody,
  };
}
