/**
 * HMS reservation + stay-option read adapter — fixture/synthetic only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LookupCandidate } from '../src/ai/thread-context.js';
import { ToolResultSchema } from '../src/ai/draft-evidence.js';
import {
  InforReadAdapter,
  loadCenturionManifest,
  type QuoteInput,
} from '../src/hms/adapter.js';
import {
  centurionManifestSchema,
  reservationReadDataSchema,
  stayOptionReadDataSchema,
  type CenturionManifest,
} from '../src/hms/contracts.js';
import type { HmsPage, HmsReadSession } from '../src/hms/runtime.js';
import type { RequestDecision } from '../src/hms/contracts.js';

const FIXED_NOW = new Date('2026-08-01T12:00:00.000Z');

function headerHtml(opts?: {
  tenant?: string;
  propertyCode?: string;
  propertyName?: string;
}): string {
  const tenant = opts?.tenant ?? 'THECENTURION_PRD';
  const propertyCode = opts?.propertyCode ?? 'centurion';
  const propertyName = opts?.propertyName ?? 'Centurion Hotel';
  return `<header data-testid="property-header"
    data-tenant="${tenant}"
    data-property-code="${propertyCode}"
    data-property-name="${propertyName}"></header>`;
}

function reservationRow(attrs: Record<string, string>): string {
  const parts = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `<tr ${parts}><td>${attrs['data-confirmation'] ?? ''}</td></tr>`;
}

type FakeScenario = {
  property?: { tenant: string; propertyCode: string; propertyName: string };
  searchHtml: string | ((fields: Record<string, string>) => string);
  inventoryHtml?: string;
  ratesHtml?: string;
};

class FakePage implements HmsPage {
  navigations: string[] = [];
  posts: Array<{ path: string; fields: Record<string, string> }> = [];
  #html = '';
  #scenario: FakeScenario;

  constructor(scenario: FakeScenario) {
    this.#scenario = scenario;
    this.#html = headerHtml(scenario.property);
  }

  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}

  async goto(url: string): Promise<void> {
    const u = new URL(url);
    this.navigations.push(u.pathname);
    if (u.pathname === '/reservations') {
      this.#html = `${headerHtml(this.#scenario.property)}<form></form><div id="results"></div>`;
      return;
    }
    if (u.pathname === '/availability/rooms') {
      this.#html =
        this.#scenario.inventoryHtml ??
        `${headerHtml(this.#scenario.property)}<table data-testid="inventory"></table>`;
      return;
    }
    if (u.pathname === '/availability/rates') {
      this.#html =
        this.#scenario.ratesHtml ??
        `${headerHtml(this.#scenario.property)}<table data-testid="rates"></table>`;
      return;
    }
    if (u.pathname === '/web/reservation/detail') {
      this.navigations.push('/web/reservation/detail');
      this.#html = `${headerHtml(this.#scenario.property)}<article data-testid="reservation-detail"></article>`;
      return;
    }
    this.#html = headerHtml(this.#scenario.property);
  }

  async content(): Promise<string> {
    return this.#html;
  }

  async readPropertyBinding() {
    const tenant = /data-tenant="([^"]*)"/.exec(this.#html)?.[1] ?? null;
    const propertyCode =
      /data-property-code="([^"]*)"/.exec(this.#html)?.[1] ?? null;
    const propertyName =
      /data-property-name="([^"]*)"/.exec(this.#html)?.[1] ?? null;
    return { tenant, propertyCode, propertyName };
  }

  async fillLogin(): Promise<void> {}
  async submitLogin(): Promise<void> {}

  async postForm(url: string, fields: Record<string, string>): Promise<string> {
    const path = new URL(url).pathname;
    this.posts.push({ path, fields });
    this.navigations.push(path);
    const html =
      typeof this.#scenario.searchHtml === 'function'
        ? this.#scenario.searchHtml(fields)
        : this.#scenario.searchHtml;
    this.#html = `${headerHtml(this.#scenario.property)}${html}`;
    return this.#html;
  }

  async click(): Promise<void> {}
  async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }
  async close(): Promise<void> {}
}

function fakeSession(page: FakePage, origin = 'http://127.0.0.1:17888'): HmsReadSession {
  let violation: RequestDecision | null = null;
  return {
    id: 'test-session',
    origin,
    page,
    violation: () => violation,
    terminal: () => false,
    close: async () => {},
  };
}

function candidateMap(
  ...candidates: LookupCandidate[]
): Map<string, LookupCandidate> {
  return new Map(candidates.map((c) => [c.id, c]));
}

function adapterFor(
  scenario: FakeScenario,
  navigations: string[],
  manifest?: CenturionManifest,
) {
  const page = new FakePage(scenario);
  const session = fakeSession(page);
  const onNavigate = (path: string) => {
    navigations.push(path);
  };
  // Mirror navigations from page as well
  const origGoto = page.goto.bind(page);
  page.goto = async (url: string) => {
    await origGoto(url);
  };
  return {
    page,
    adapter: new InforReadAdapter({
      session,
      manifest: manifest ?? loadCenturionManifest(),
      now: () => FIXED_NOW,
      onNavigate,
    }),
  };
}

describe('centurion.manifest.json', () => {
  it('Zod-validates fixture-origin reviewed rules + exact selectors', () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'src/hms/centurion.manifest.json',
        ),
        'utf8',
      ),
    );
    const parsed = centurionManifestSchema.parse(raw);
    expect(parsed.binding.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsed.binding.propertyKey).toBe('centurion');
    expect(parsed.rules.some((r) => r.path === '/web/reservation/search')).toBe(
      true,
    );
    expect(
      parsed.rules.some(
        (r) =>
          r.path === '/availability/room-type-rate' &&
          r.method === 'POST',
      ),
    ).toBe(
      true,
    );
    expect(parsed.rules.some((r) => r.path.includes('crs'))).toBe(false);
    expect(parsed.selectors.reservation.searchPath).toBe(
      '/web/reservation/search',
    );
    expect(parsed.selectors.quote.searchPath).toBe(
      '/availability/room-type-rate',
    );
  });
});

describe('InforReadAdapter.findReservation', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()?.();
  });

  it('resolves exact confirmation via opaque candidateId', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-conf-1',
      kind: 'confirmation',
      value: 'CONF-1001',
    };
    const { adapter, page } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'CONF-1001',
          'data-guest-name': 'Ada Lovelace',
          'data-arrival': '2026-08-03',
          'data-departure': '2026-08-05',
          'data-status': 'Reserved',
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-conf-1' },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(ToolResultSchema.parse(result)).toEqual(result);
    expect(reservationReadDataSchema.parse(result.data)).toEqual(result.data);
    expect(result.status).toBe('ok');
    expect(result.draftReady).toBe(true);
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.matches[0]).toMatchObject({
      confirmationNumber: 'CONF-1001',
      arrivalDate: '2026-08-03',
      departureDate: '2026-08-05',
      reservationStatus: 'Reserved',
    });
    expect(page.posts[0]?.fields.confirmationNumber).toBe('CONF-1001');
    expect(result.evidence.kind).toBe('hms');
    expect(result.evidence.expiresAt).toBe('2026-08-01T12:05:00.000Z');
  });

  it('resolves exact external reference candidate', async () => {
    const navigations: string[] = [];
    const ext: LookupCandidate = {
      id: 'cand-ext-1',
      kind: 'external_reference',
      value: 'EXT-77',
    };
    const { adapter, page } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'CONF-2002',
          'data-external-ref': 'EXT-77',
          'data-arrival': '2026-09-01',
          'data-departure': '2026-09-03',
          'data-status': 'Confirmed',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-ext-1' },
      candidateMap(ext),
      new AbortController().signal,
    );

    expect(result.status).toBe('partial');
    expect(result.unresolvedFields).toEqual(expect.arrayContaining(['roomType']));
    expect(result.data.matches[0]?.externalReference).toBe('EXT-77');
    expect(result.evidence.claimKeys).not.toContain('matches.0.ratePlan');
    expect(page.posts[0]?.fields.externalReference).toBe('EXT-77');
  });

  it('rejects an uncorrelated singleton list row', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-conf-target',
      kind: 'confirmation',
      value: 'CONF-TARGET',
    };
    const { adapter } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'CONF-LOOKALIKE',
          'data-status': 'Reserved',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: conf.id },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('unverified_negative');
    expect(result.data.matches).toEqual([]);
    expect(navigations).not.toContain('/web/reservation/detail');
  });

  it('uses bounded surname/date fallback fields from candidate', async () => {
    const navigations: string[] = [];
    const surname: LookupCandidate = {
      id: 'cand-sn-1',
      kind: 'surname_dates',
      surname: 'Ngubane',
      arrivalDate: '2026-08-10',
      departureDate: '2026-08-12',
    };
    const { adapter, page } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'CONF-3003',
          'data-guest-name': 'S. Ngubane',
          'data-arrival': '2026-08-10',
          'data-departure': '2026-08-12',
          'data-status': 'Reserved',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-sn-1' },
      candidateMap(surname),
      new AbortController().signal,
    );

    expect(result.status).toBe('partial');
    expect(result.unresolvedFields).toEqual(expect.arrayContaining(['roomType']));
    expect(result.evidence.claimKeys).not.toContain('matches.0.ratePlan');
    expect(page.posts[0]?.fields).toMatchObject({
      surname: 'Ngubane',
      arrivalDate: '2026-08-10',
      departureDate: '2026-08-12',
    });
  });

  it('returns unverified_negative for zero matches without detail nav', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-miss',
      kind: 'confirmation',
      value: 'MISSING',
    };
    const { adapter } = adapterFor(
      {
        searchHtml: '<p data-testid="no-results">No reservations found</p>',
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-miss' },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('unverified_negative');
    expect(result.draftReady).toBe(false);
    expect(result.data.matches).toEqual([]);
    expect(navigations).not.toContain('/web/reservation/detail');
  });

  it('returns manual_required when candidateId missing from map', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      { searchHtml: '<p data-testid="no-results">none</p>' },
      navigations,
    );
    const result = await adapter.findReservation(
      { candidateId: 'unknown' },
      candidateMap(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('candidateId');
    expect(navigations).toHaveLength(0);
  });

  it('returns ambiguous for multiple matches and never opens detail', async () => {
    const navigations: string[] = [];
    const surname: LookupCandidate = {
      id: 'cand-multi',
      kind: 'surname_dates',
      surname: 'Smith',
      arrivalDate: '2026-08-03',
      departureDate: '2026-08-05',
    };
    const { adapter } = adapterFor(
      {
        searchHtml: `<table data-testid="results">
          ${reservationRow({
            'data-confirmation': 'A-1',
            'data-guest-name': 'Alice Smith',
            'data-arrival': '2026-08-03',
            'data-departure': '2026-08-05',
            'data-status': 'Reserved',
          })}
          ${reservationRow({
            'data-confirmation': 'A-2',
            'data-guest-name': 'Bob Smith',
            'data-arrival': '2026-08-03',
            'data-departure': '2026-08-05',
            'data-status': 'Reserved',
          })}
          <a href="/web/reservation/detail?id=A-1">Open</a>
        </table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-multi' },
      candidateMap(surname),
      new AbortController().signal,
    );

    expect(result.status).toBe('ambiguous');
    expect(result.draftReady).toBe(false);
    expect(result.data.matches).toHaveLength(2);
    // Minimize unrelated identities
    expect(result.data.matches.every((m) => m.guestName === null)).toBe(true);
    expect(navigations).not.toContain('/web/reservation/detail');
  });

  it('caps matches at 20 rows', async () => {
    const navigations: string[] = [];
    const rows = Array.from({ length: 25 }, (_, i) =>
      reservationRow({
        'data-confirmation': `C-${i}`,
        'data-external-ref': 'EXT-ALL',
        'data-guest-name': `Guest ${i}`,
        'data-arrival': '2026-08-03',
        'data-departure': '2026-08-05',
        'data-status': 'Reserved',
      }),
    ).join('');
    const conf: LookupCandidate = {
      id: 'cand-cap',
      kind: 'external_reference',
      value: 'EXT-ALL',
    };
    const { adapter } = adapterFor(
      { searchHtml: `<table data-testid="results">${rows}</table>` },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-cap' },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('ambiguous');
    expect(result.data.matches).toHaveLength(20);
    expect(result.data.capped).toBe(true);
    expect(result.data.matchCount).toBe(25);
    expect(navigations).not.toContain('/web/reservation/detail');
  });

  it('matches one exact confirmation among many uncorrelated rows', async () => {
    const navigations: string[] = [];
    const filler = Array.from({ length: 24 }, (_, i) =>
      reservationRow({
        'data-confirmation': `OTHER-${i}`,
        'data-guest-name': `Other ${i}`,
        'data-arrival': '2026-08-03',
        'data-departure': '2026-08-05',
        'data-status': 'Reserved',
      }),
    ).join('');
    const target = reservationRow({
      'data-confirmation': 'NEEDLE-1',
      'data-guest-name': 'Exact Guest',
      'data-arrival': '2026-08-03',
      'data-departure': '2026-08-05',
      'data-status': 'Reserved',
      'data-room-type': 'SUP',
      'data-rate-plan': 'BAR',
    });
    const conf: LookupCandidate = {
      id: 'cand-needle',
      kind: 'confirmation',
      value: 'NEEDLE-1',
    };

    for (const searchHtml of [
      `<table data-testid="results">${target}${filler}</table>`,
      `<table data-testid="results">${filler}${target}</table>`,
    ]) {
      const { adapter } = adapterFor({ searchHtml }, navigations);
      const result = await adapter.findReservation(
        { candidateId: conf.id },
        candidateMap(conf),
        new AbortController().signal,
      );
      expect(result.status).toBe('ok');
      expect(result.data.matches).toHaveLength(1);
      expect(result.data.matches[0]?.confirmationNumber).toBe('NEEDLE-1');
      expect(result.data.capped).toBe(false);
    }
    expect(navigations).not.toContain('/web/reservation/detail');
  });

  it('binds malformed-date unresolved fields to the correlated row', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-dates',
      kind: 'confirmation',
      value: 'DATE-TARGET',
    };
    const { adapter } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'OTHER-OK',
          'data-arrival': '2026-08-01',
          'data-departure': '2026-08-02',
          'data-status': 'Reserved',
        })}${reservationRow({
          'data-confirmation': 'DATE-TARGET',
          'data-arrival': 'not-a-date',
          'data-departure': 'also-bad',
          'data-status': 'Reserved',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: conf.id },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('partial');
    expect(result.data.matches[0]?.confirmationNumber).toBe('DATE-TARGET');
    expect(result.unresolvedFields).toEqual(
      expect.arrayContaining(['arrivalDate', 'departureDate']),
    );
  });

  it('fails closed on wrong property binding', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-prop',
      kind: 'confirmation',
      value: 'X',
    };
    const { adapter } = adapterFor(
      {
        property: {
          tenant: 'THECENTURION_PRD',
          propertyCode: 'other-prop',
          propertyName: 'Other Hotel',
        },
        searchHtml: '<p data-testid="no-results">none</p>',
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-prop' },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('property_binding');
    expect(result.draftReady).toBe(false);
  });

  it('marks malformed date fields partial', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-bad',
      kind: 'confirmation',
      value: 'CONF-BAD',
    };
    const { adapter } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'CONF-BAD',
          'data-arrival': '03/08/2026',
          'data-departure': 'not-a-date',
          'data-status': 'Reserved',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-bad' },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('partial');
    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields).toEqual(
      expect.arrayContaining(['arrivalDate', 'departureDate']),
    );
  });

  it('returns canceled/no-show without draftReady', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-ns',
      kind: 'confirmation',
      value: 'CONF-NS',
    };
    const { adapter } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'CONF-NS',
          'data-arrival': '2026-08-03',
          'data-departure': '2026-08-05',
          'data-status': 'No-Show',
        })}</table>`,
      },
      navigations,
    );

    const result = await adapter.findReservation(
      { candidateId: 'cand-ns' },
      candidateMap(conf),
      new AbortController().signal,
    );

    expect(result.status).toBe('partial');
    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields).toContain('reservationStatus.active');
    expect(result.data.matches[0]?.reservationStatus).toBe('No-Show');
  });

  it('never accepts raw guest values from tool input', async () => {
    const navigations: string[] = [];
    const conf: LookupCandidate = {
      id: 'cand-opaque',
      kind: 'confirmation',
      value: 'REAL-CONF',
    };
    const { adapter, page } = adapterFor(
      {
        searchHtml: `<table data-testid="results">${reservationRow({
          'data-confirmation': 'REAL-CONF',
          'data-arrival': '2026-08-03',
          'data-departure': '2026-08-05',
          'data-status': 'Reserved',
        })}</table>`,
      },
      navigations,
    );

    // Tool input is only candidateId — values come from server map.
    await adapter.findReservation(
      { candidateId: 'cand-opaque' },
      candidateMap(conf),
      new AbortController().signal,
    );
    expect(page.posts[0]?.fields.confirmationNumber).toBe('REAL-CONF');
    expect(Object.keys(page.posts[0]?.fields ?? {})).not.toContain(
      'rawGuestName',
    );
  });
});

describe.skip('InforReadAdapter.quoteStay legacy v1 fixtures', () => {
  const baseQuote: QuoteInput = {
    arrivalDate: '2026-08-03',
    departureDate: '2026-08-05',
    adults: 2,
    children: 0,
    rooms: 1,
    roomType: 'STD',
    ratePlan: 'BAR',
    boardBasis: 'B&B',
    currency: 'ZAR',
  };

  function inventoryRows(
    nights: Array<{ date: string; count: string; roomType?: string }>,
  ): string {
    return `<table data-testid="inventory">${nights
      .map(
        (n) =>
          `<tr data-date="${n.date}" data-room-type="${n.roomType ?? 'STD'}" data-available="${n.count}"><td>${n.date}</td><td>${n.count}</td></tr>`,
      )
      .join('')}</table>`;
  }

  function rateRow(attrs: Record<string, string>): string {
    const parts = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return `<table data-testid="rates"><tr ${parts}><td>rate</td></tr></table>`;
  }

  it('fails closed when property binding code or tenant is missing', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        property: {
          tenant: 'THECENTURION_PRD',
          propertyCode: '',
          propertyName: 'Centurion Hotel',
        },
        searchHtml: '<p>n/a</p>',
        inventoryHtml: `${headerHtml({ propertyCode: '' })}${inventoryRows([
          { date: '2026-08-03', count: '3' },
          { date: '2026-08-04', count: '3' },
        ])}`,
        ratesHtml: `${headerHtml({ propertyCode: '' })}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '1200',
          'data-currency': 'ZAR',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('property_binding');
    expect(result.draftReady).toBe(false);
    expect(navigations).toHaveLength(0);
  });

  it('keeps inventory and rates separate; bookable always false', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '3' },
          { date: '2026-08-04', count: '3' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '1200',
          'data-currency': 'ZAR',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'breakfast',
          'data-restrictions': 'none',
          'data-board-basis': 'B&B',
          'data-org-eligibility': 'not_requested',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(ToolResultSchema.parse(result)).toEqual(result);
    expect(stayOptionReadDataSchema.parse(result.data)).toEqual(result.data);
    expect(result.data.bookable).toBe(false);
    expect(result.data.inventoryObservations).toHaveLength(2);
    expect(result.data.rateObservations).toHaveLength(1);
    expect(result.data.inventoryObservations[0]).toMatchObject({
      date: '2026-08-03',
      availableCount: 3,
      roomType: 'STD',
    });
    expect(result.draftReady).toBe(true);
    expect(result.status).toBe('ok');
    expect(navigations).toContain('/availability/rooms');
    expect(navigations).toContain('/availability/rates');
    expect(navigations).not.toContain('/crs/check-availability');
  });

  it('requires availableCount >= rooms for every night', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '2' },
          { date: '2026-08-04', count: '0' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '1200',
          'data-currency': 'ZAR',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'breakfast',
          'data-restrictions': 'none',
          'data-board-basis': 'B&B',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      { ...baseQuote, rooms: 2 },
      new AbortController().signal,
    );

    expect(result.data.bookable).toBe(false);
    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields.some((f) => f.includes('rooms'))).toBe(true);
  });

  it('flags inventory gaps and missing nights', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '3' },
          // gap: 2026-08-04 missing
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '1200',
          'data-currency': 'ZAR',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'x',
          'data-restrictions': 'y',
          'data-board-basis': 'B&B',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields).toEqual(
      expect.arrayContaining(['inventory.2026-08-04']),
    );
  });

  it('draftReady false when tax/inclusions/restrictions/board unresolved', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '3' },
          { date: '2026-08-04', count: '3' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '1200',
          'data-currency': 'ZAR',
          // no tax / inclusions / restrictions / board
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.data.bookable).toBe(false);
    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields.join(' ')).toMatch(/tax_inclusion/);
    expect(result.unresolvedFields.join(' ')).toMatch(/rate_inclusions/);
    expect(result.unresolvedFields.join(' ')).toMatch(/rate_restrictions/);
    expect(result.unresolvedFields.join(' ')).toMatch(/board_basis/);
  });

  it('handles zero inventory and malformed count/amount', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '0' },
          { date: '2026-08-04', count: 'NaN' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': 'not-a-number',
          'data-currency': 'ZAR',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'x',
          'data-restrictions': 'y',
          'data-board-basis': 'B&B',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.status).toBe('partial');
    expect(result.draftReady).toBe(false);
    expect(result.data.inventoryObservations[0]?.inventoryStatus).toBe(
      'unavailable',
    );
    expect(result.data.inventoryObservations[1]?.availableCount).toBeNull();
  });

  it('quarantines empty inventory and rate screens as unverified_negative', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}<table data-testid="inventory"></table>`,
        ratesHtml: `${headerHtml()}<table data-testid="rates"></table>`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.status).toBe('unverified_negative');
    expect(result.draftReady).toBe(false);
    expect(result.data.inventoryObservations).toEqual([]);
    expect(result.data.rateObservations).toEqual([]);
  });

  it('partial when rate screen missing / mismatched screens', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '3' },
          { date: '2026-08-04', count: '3' },
        ])}`,
        // Wrong screen content on rates path
        ratesHtml: `${headerHtml()}<table data-testid="inventory"><tr data-date="2026-08-03" data-room-type="STD" data-available="3"></tr></table>`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.data.bookable).toBe(false);
    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields).toEqual(
      expect.arrayContaining(['screen_mismatch']),
    );
  });

  it('rejects currency / room type / rate plan mismatch', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '3', roomType: 'DLX' },
          { date: '2026-08-04', count: '3', roomType: 'DLX' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'DLX',
          'data-rate-plan': 'CORP',
          'data-amount': '1200',
          'data-currency': 'USD',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'x',
          'data-restrictions': 'y',
          'data-board-basis': 'B&B',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields.join(' ')).toMatch(/roomType|ratePlan|currency/);
  });

  it('marks organization eligibility unresolved when present', async () => {
    const navigations: string[] = [];
    const { adapter } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '3' },
          { date: '2026-08-04', count: '3' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '1200',
          'data-currency': 'ZAR',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'breakfast',
          'data-restrictions': 'none',
          'data-board-basis': 'B&B',
          'data-org-eligibility': 'unresolved',
        })}`,
      },
      navigations,
    );

    const result = await adapter.quoteStay(
      baseQuote,
      new AbortController().signal,
    );

    expect(result.draftReady).toBe(false);
    expect(result.unresolvedFields.join(' ')).toMatch(
      /organization_eligibility/,
    );
    expect(result.data.bookable).toBe(false);
  });

  it('never uses CRS Check Availability route', async () => {
    const navigations: string[] = [];
    const { adapter, page } = adapterFor(
      {
        inventoryHtml: `${headerHtml()}${inventoryRows([
          { date: '2026-08-03', count: '1' },
          { date: '2026-08-04', count: '1' },
        ])}`,
        ratesHtml: `${headerHtml()}${rateRow({
          'data-room-type': 'STD',
          'data-rate-plan': 'BAR',
          'data-amount': '100',
          'data-currency': 'ZAR',
          'data-amount-basis': 'nightly',
          'data-tax-included': 'true',
          'data-inclusions': 'x',
          'data-restrictions': 'y',
          'data-board-basis': 'B&B',
        })}`,
      },
      navigations,
    );

    await adapter.quoteStay(baseQuote, new AbortController().signal);
    expect(page.navigations).not.toContain('/crs/check-availability');
    expect(navigations).not.toContain('/crs/check-availability');
  });
});
