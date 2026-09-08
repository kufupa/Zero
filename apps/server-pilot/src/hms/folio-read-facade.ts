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
import { HmsRuntimeError, type HmsReadSession } from './runtime.js';

export type DepositLedgerDetailScope = {
  closingdate: string;
  property: string;
};

export interface FolioReadFacade {
  openOsressAndSearch(candidate: ExactReservationCandidate): Promise<string>;
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
