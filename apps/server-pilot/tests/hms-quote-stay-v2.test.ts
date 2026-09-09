import {
  InforReadAdapter,
  HMS_QUOTE_STAY_TOOL_VERSION,
  loadCenturionManifest,
  type QuoteInput,
} from '../src/hms/adapter.js';
import {
  parseQuoteStayCandidateFromAuthoredSegment,
  QUOTE_STAY_MAX_NIGHTS,
} from '../src/hms/quote-stay-candidate.js';
import { quoteStayReadDataSchema, type RequestDecision } from '../src/hms/contracts.js';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import type { HmsPage, HmsReadSession } from '../src/hms/runtime.js';
import { describe, expect, it } from 'vitest';

const BASE_QUOTE: QuoteInput = {
  arrivalDate: '2026-09-10',
  departureDate: '2026-09-12',
  adults: 2,
  children: 0,
  rooms: 1,
  roomType: 'STD',
  ratePlan: 'BAR',
  currency: 'ZAR',
};

function quoteRows(rows: Array<Record<string, string>>): string {
  return `<table data-testid="room-type-rate-availability">${rows
    .map(
      (row) =>
        `<tr data-testid="quote-night" ${Object.entries(row)
          .map(([key, value]) => `${key}="${value}"`)
          .join(' ')}></tr>`,
    )
    .join('')}</table>`;
}

class QuotePage implements HmsPage {
  posts: Array<{ path: string; fields: Record<string, string> }> = [];
  gotos: string[] = [];
  clicks: string[] = [];
  #html: string;

  constructor(html: string) {
    this.#html = html;
  }

  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}
  async goto(url: string): Promise<void> {
    this.gotos.push(new URL(url).pathname);
  }
  async content(): Promise<string> {
    return this.#html;
  }
  async readPropertyBinding() {
    return {
      tenant: 'HMS_LEGACY',
      propertyCode: 'centurion',
      propertyName: 'Centurion Hotel',
    };
  }
  async fillLogin(): Promise<void> {}
  async submitLogin(): Promise<void> {}
  async postForm(url: string, fields: Record<string, string>): Promise<string> {
    this.posts.push({ path: new URL(url).pathname, fields });
    return this.#html;
  }
  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }
  async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }
  async close(): Promise<void> {}
}

function adapterFor(html: string) {
  const page = new QuotePage(html);
  let violation: RequestDecision | null = null;
  const session: HmsReadSession = {
    id: 'quote-v2',
    origin: 'http://127.0.0.1:17888',
    page,
    violation: () => violation,
    terminal: () => false,
    close: async () => {},
  };
  return {
    page,
    adapter: new InforReadAdapter({
      session,
      manifest: loadCenturionManifest(),
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    }),
  };
}

describe('quote stay candidate v2', () => {
  it('accepts one explicit authored tuple and mints an opaque candidate', () => {
    const parsed = parseQuoteStayCandidateFromAuthoredSegment(
      'Please quote arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, room type STD, rate plan BAR.',
    );
    expect(parsed).toMatchObject({
      arrivalDate: '2026-09-10',
      departureDate: '2026-09-12',
      adults: 2,
      children: 0,
      rooms: 1,
      roomType: 'STD',
      ratePlan: 'BAR',
    });
    expect(parsed?.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it.each([
    ['missing occupancy', 'arrival 2026-09-10, departure 2026-09-12, room type STD, rate plan BAR'],
    [
      'conflicting dates',
      'arrival 2026-09-10, departure 2026-09-12, arrival 2026-10-10, departure 2026-10-12, 2 adults, 0 children, 1 room, room type STD, rate plan BAR',
    ],
    [
      'multiple occupancy tuples',
      'arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room; 3 adults, 0 children, 1 room, room type STD, rate plan BAR',
    ],
    [
      'ambiguous locale dates',
      'arrival 10/09/2026, departure 12/09/2026, 2 adults, 0 children, 1 room, room type STD, rate plan BAR',
    ],
    [
      'missing room type',
      'arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, rate plan BAR',
    ],
    [
      'missing rate plan',
      'arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, room type STD',
    ],
  ])('abstains on %s', (_name, segment) => {
    expect(parseQuoteStayCandidateFromAuthoredSegment(segment)).toBeNull();
  });

  it('rejects invalid calendar dates and overlong stays', () => {
    expect(
      parseQuoteStayCandidateFromAuthoredSegment(
        'arrival 2026-02-30, departure 2026-03-02, 2 adults, 0 children, 1 room, room type STD, rate plan BAR',
      ),
    ).toBeNull();
    const departure = new Date(Date.UTC(2026, 8, 10 + QUOTE_STAY_MAX_NIGHTS + 1))
      .toISOString()
      .slice(0, 10);
    expect(
      parseQuoteStayCandidateFromAuthoredSegment(
        `arrival 2026-09-10, departure ${departure}, 2 adults, 0 children, 1 room, room type STD, rate plan BAR`,
      ),
    ).toBeNull();
  });
});

describe('InforReadAdapter quote v2 fixture kernel', () => {
  it('uses one exact Room Type and Rate Availability search', async () => {
    const { adapter, page } = adapterFor(
      quoteRows([
        {
          'data-date': '2026-09-10',
          'data-room-type': 'STD',
          'data-available': '3',
          'data-rate-plan': 'BAR',
          'data-amount': '1200.00',
          'data-currency': 'ZAR',
          'data-rate-basis': 'nightly',
          'data-restrictions': 'none',
        },
        {
          'data-date': '2026-09-11',
          'data-room-type': 'STD',
          'data-available': '2',
          'data-rate-plan': 'BAR',
          'data-amount': '1250.00',
          'data-currency': 'ZAR',
          'data-rate-basis': 'nightly',
          'data-restrictions': 'minimum-stay-met',
        },
      ]),
    );

    const result = await adapter.quoteStay(BASE_QUOTE, new AbortController().signal);

    expect(quoteStayReadDataSchema.parse(result.data)).toEqual(result.data);
    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      bookable: false,
      stayTotal: null,
      occupancyPriced: false,
      requestedRooms: 1,
    });
    expect(result.data.nightlyObservations).toHaveLength(2);
    expect(result.data.nightlyObservations[0]).toMatchObject({
      date: '2026-09-10',
      roomType: 'STD',
      availableCount: 3,
      ratePlan: 'BAR',
      displayedAmount: '1200.00',
      currency: 'ZAR',
      rateBasis: 'nightly',
      restrictions: ['none'],
      observedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(result.evidence.toolVersion).toBe('2.0.0');
    expect(HMS_QUOTE_STAY_TOOL_VERSION).toBe('2.0.0');
    expect(page.posts).toHaveLength(1);
    expect(page.posts[0]).toMatchObject({
      path: '/availability/room-type-rate',
      fields: {
        action: 'search',
        arrivalDate: '2026-09-10',
        departureDate: '2026-09-12',
        adults: '2',
        children: '0',
        rooms: '1',
        roomType: 'STD',
        ratePlan: 'BAR',
        currency: 'ZAR',
      },
    });
    expect(page.gotos).toEqual([]);
    expect(page.clicks).toEqual([]);
    const claims = claimsFromToolResult(result, new Date('2026-08-06T00:01:00.000Z'));
    // The adapter fixture proves parsing only; it has no admitted scope proof.
    // Claims are intentionally withheld until the audited live composition.
    expect(claims).toEqual([]);
  });

  it('returns manual_required when any requested night lacks nightly semantics', async () => {
    const { adapter } = adapterFor(
      quoteRows([
        {
          'data-date': '2026-09-10',
          'data-room-type': 'STD',
          'data-available': '3',
          'data-rate-plan': 'BAR',
          'data-amount': '1200.00',
          'data-currency': 'ZAR',
          'data-rate-basis': 'stay_total',
          'data-restrictions': 'none',
        },
      ]),
    );
    const result = await adapter.quoteStay(BASE_QUOTE, new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.draftReady).toBe(false);
    expect(result.data.bookable).toBe(false);
    expect(result.data.stayTotal).toBeNull();
    expect(result.data.occupancyPriced).toBe(false);
    expect(result.unresolvedFields).toEqual(
      expect.arrayContaining(['nightly.2026-09-10.rateBasis', 'nightly.2026-09-11']),
    );
  });

  it('quarantines empty recognized result envelopes', async () => {
    const { adapter } = adapterFor('<table data-testid="room-type-rate-availability"></table>');
    const result = await adapter.quoteStay(BASE_QUOTE, new AbortController().signal);
    expect(result.status).toBe('unverified_negative');
    expect(result.data.nightlyObservations).toEqual([]);
    expect(result.draftReady).toBe(false);
  });

  it('rejects unrecognized quote surface HTML as manual_required', async () => {
    const { adapter } = adapterFor('<div>login shell</div>');
    const result = await adapter.quoteStay(BASE_QUOTE, new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('quote_surface_envelope');
  });

  it('drops out-of-window nights from ok claims', async () => {
    const { adapter } = adapterFor(
      quoteRows([
        {
          'data-date': '2026-09-10',
          'data-room-type': 'STD',
          'data-available': '3',
          'data-rate-plan': 'BAR',
          'data-amount': '1200.00',
          'data-currency': 'ZAR',
          'data-rate-basis': 'nightly',
          'data-restrictions': 'none',
        },
        {
          'data-date': '2026-09-11',
          'data-room-type': 'STD',
          'data-available': '2',
          'data-rate-plan': 'BAR',
          'data-amount': '1250.00',
          'data-currency': 'ZAR',
          'data-rate-basis': 'nightly',
          'data-restrictions': 'minimum-stay-met',
        },
        {
          'data-date': '2026-09-20',
          'data-room-type': 'STD',
          'data-available': '9',
          'data-rate-plan': 'BAR',
          'data-amount': '999.00',
          'data-currency': 'ZAR',
          'data-rate-basis': 'nightly',
          'data-restrictions': 'none',
        },
      ]),
    );
    const result = await adapter.quoteStay(BASE_QUOTE, new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('nightly.out_of_window');
    expect(
      result.data.nightlyObservations.every((row) =>
        ['2026-09-10', '2026-09-11'].includes(row.date),
      ),
    ).toBe(true);
    expect(result.data.nightlyObservations.some((row) => row.date === '2026-09-20')).toBe(false);
  });

  it('aborts before transmission for invalid input', async () => {
    const { adapter, page } = adapterFor('');
    const result = await adapter.quoteStay(
      { ...BASE_QUOTE, departureDate: BASE_QUOTE.arrivalDate },
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(page.posts).toEqual([]);
  });
});
