/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { initialQuoteSession, reduceQuoteSession, stayKeyForGroup } from '../lib/quote-workflow/session';
import {
  HRDAV_PROPERTY_CODE,
  type QuotePaneConfig,
  type QuoteSalesStrategy,
  type QuoteSession,
  type QuoteStrategyRow,
  type StayGroupRequirement,
} from '../lib/quote-workflow/types';

afterEach(cleanup);

const STAY: StayGroupRequirement = {
  id: 'row-1',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  quantity: 1,
  adults: 2,
  childrenAges: [],
  board: 'bb',
  specialRequests: [],
  fields: {},
};

function comparisonSession(): { session: QuoteSession; stayKey: string } {
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: {
      transportId: 't1',
      mailboxEmail: 'desk@example.test',
      storeId: 'store',
      folderEntryId: 'inbox',
      entryId: 'e1',
      selectionEpoch: 1,
      scopeEpoch: 1,
    },
  });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: { intent: 'quote', groups: [STAY], secondaryAsks: [], alternatives: [] },
  });
  return { session, stayKey: stayKeyForGroup(session.groups[0]!) };
}

describe('quote failure reason', () => {
  it('shows the cause class and sentence under the row, and Retrying when the server is retrying', () => {
    const { session, stayKey } = comparisonSession();
    const strategies: QuoteSalesStrategy[] = [
      { code: 'BAR', label: 'Best available', requestValue: 'BAR' },
      { code: 'WS', label: 'Wholesale', requestValue: 'WS' },
    ];
    const rows: Record<string, Partial<Record<QuoteSalesStrategy['code'], QuoteStrategyRow>>> = {
      [stayKey]: {
        BAR: {
          status: 'failed',
          causeClass: 'busy',
          message: 'HMS is busy with another quote. Try again in a minute.',
        },
        WS: {
          status: 'failed',
          causeClass: 'not_set_up',
          retrying: true,
          message: 'No prepared comparison job was found. The queue may be disabled; no search was run.',
        },
      },
    };
    const paneConfig: QuotePaneConfig = {
      transportId: 't1',
      propertyCode: HRDAV_PROPERTY_CODE,
      roomTypes: [],
      ratePlans: [],
      boards: ['bb'],
      salesStrategies: strategies,
      overrideRateCodes: [],
      eventRateCodes: [],
    };

    render(
      <QuoteWorkflowPanel session={session} paneConfig={paneConfig} quoteStrategyRows={rows} />,
    );

    const table = screen.getByRole('table', { name: 'Quote strategy comparison' });
    expect(within(table).getByText('Busy. HMS is busy with another quote. Try again in a minute.')).toBeDefined();
    expect(within(table).getByText('Retrying…')).toBeDefined();
    expect(within(table).queryByText(/HMS_/)).toBeNull();
    expect(table.querySelector('[title]')).toBeNull();
  });
});
