import { describe, expect, it } from 'vitest';
import type { LookupCandidate } from '../src/ai/thread-context.js';
import { extractLookupCandidates } from '../src/ai/thread-context.js';
import {
  resolveThreadConfirmationEvidence,
  THREAD_CONFIRMATION_AMBIGUOUS,
} from '../src/ai/quote-workflow-synced-selection.js';
import {
  confirmationBase,
  confirmationMatches,
  confirmationSearchValues,
} from '../src/hms/confirmation-match.js';
import { parseAndCorrelateGuestStayHtml } from '../src/hms/live-guest-stay-driver.js';
import {
  InforReadAdapter,
  loadCenturionManifest,
} from '../src/hms/adapter.js';
import type { HmsPage, HmsReadSession } from '../src/hms/runtime.js';

const BASE = '88001122';
const LEG1 = '88001122-1';
const LEG2 = '88001122-2';

function confCandidate(value: string): LookupCandidate {
  return { id: `c-${value}`, kind: 'confirmation', value };
}

function rowHtml(conf: string): string {
  return `<tr data-testid="result-row" data-confirmation="${conf}" data-status="Reserved"><td>x</td></tr>`;
}

function headerHtml(): string {
  return `<header data-testid="property-header" data-tenant="HMS_LEGACY" data-property-code="centurion" data-property-name="Centurion Hotel"></header>`;
}

function reservationRow(conf: string): string {
  return `<tr data-confirmation="${conf}" data-guest-name="Synth Guest" data-arrival="2099-03-01" data-departure="2099-03-03" data-status="Reserved" data-room-type="STD"><td>${conf}</td></tr>`;
}

class FakePage implements HmsPage {
  posts: Array<{ fields: Record<string, string> }> = [];
  #html = headerHtml();
  constructor(private readonly searchHtml: (fields: Record<string, string>) => string) {}
  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}
  async goto(): Promise<void> {
    this.#html = `${headerHtml()}<form></form><div id="results"></div>`;
  }
  async content(): Promise<string> {
    return this.#html;
  }
  async readPropertyBinding() {
    return { tenant: 'HMS_LEGACY', propertyCode: 'centurion', propertyName: 'Centurion Hotel' };
  }
  async fillLogin(): Promise<void> {}
  async submitLogin(): Promise<void> {}
  async postForm(_url: string, fields: Record<string, string>): Promise<string> {
    this.posts.push({ fields });
    this.#html = `${headerHtml()}${this.searchHtml(fields)}`;
    return this.#html;
  }
  async click(): Promise<void> {}
  async dblclick(): Promise<void> {}
  async fill(): Promise<void> {}
  async press(): Promise<void> {}
  url(): string {
    return 'http://127.0.0.1:17888/reservations';
  }
  async title(): Promise<string> {
    return 'HRCEN';
  }
  async evaluateStableDom<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }
  async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    return fn();
  }
  async close(): Promise<void> {}
}

function fakeSession(page: FakePage): HmsReadSession {
  return {
    id: 'test-session',
    origin: 'http://127.0.0.1:17888',
    page,
    violation: () => null,
    terminal: () => false,
    close: async () => {},
  };
}

describe('confirmationBase / confirmationMatches', () => {
  it('exact dashed match wins', () => {
    expect(confirmationBase(LEG1)).toBe(BASE);
    expect(confirmationMatches(LEG1, LEG1)).toBe(true);
    expect(confirmationMatches(LEG1, LEG2)).toBe(false);
  });

  it('bare base matches HMS leg', () => {
    expect(confirmationMatches(BASE, LEG1)).toBe(true);
    expect(confirmationMatches(BASE, LEG2)).toBe(true);
    expect(confirmationMatches(BASE, '99001122-1')).toBe(false);
  });
});

describe('row correlation', () => {
  it('bare candidate matches the dashed Guest Stay row', () => {
    const html = `<table data-testid="results">${rowHtml(LEG1)}</table>`;
    const result = parseAndCorrelateGuestStayHtml(html, {
      id: 'c1',
      kind: 'confirmation',
      value: BASE,
    });
    expect(result.outcome).toBe('matched');
    if (result.outcome === 'matched') {
      expect(result.observations[0]?.confirmationNumber).toBe(LEG1);
    }
  });

  it('bare base matching two legs is ambiguous and lists both', () => {
    const html = `<table data-testid="results">${rowHtml(LEG1)}${rowHtml(LEG2)}</table>`;
    const result = parseAndCorrelateGuestStayHtml(html, {
      id: 'c1',
      kind: 'confirmation',
      value: BASE,
    });
    expect(result.outcome).toBe('ambiguous');
    if (result.outcome === 'ambiguous') {
      expect(result.observations.map((row) => row.confirmationNumber)).toEqual([LEG1, LEG2]);
    }
  });
});

describe('search cascade', () => {
  it('retries bare base as <base>-1', () => {
    expect(confirmationSearchValues(BASE)).toEqual([
      { searchValue: BASE, matchedBy: 'confirmation' },
      { searchValue: LEG1, matchedBy: 'confirmation_leg_retry' },
    ]);
    expect(confirmationSearchValues(LEG1)).toEqual([
      { searchValue: LEG1, matchedBy: 'confirmation' },
    ]);
  });

  it('adapter retries -1 when the bare search returns no rows', async () => {
    const page = new FakePage((fields) => {
      if (fields.confirmationNumber === LEG1) {
        return `<table data-testid="results">${reservationRow(LEG1)}</table>`;
      }
      return '<p data-testid="no-results">No reservations found</p>';
    });
    const adapter = new InforReadAdapter({
      session: fakeSession(page),
      manifest: loadCenturionManifest(),
      now: () => new Date('2099-01-01T12:00:00.000Z'),
    });
    const candidate = confCandidate(BASE);
    const result = await adapter.findReservation(
      { candidateId: candidate.id },
      new Map([[candidate.id, candidate]]),
      new AbortController().signal,
    );
    expect(page.posts.map((post) => post.fields.confirmationNumber)).toEqual([BASE, LEG1]);
    expect(result.status).toBe('ok');
    expect(result.data.matches[0]?.confirmationNumber).toBe(LEG1);
    expect(result.data.matchedBy).toBe('confirmation_leg_retry');
  });
});

describe('extraction', () => {
  it('takes a subject # tag as a confirmation base', () => {
    const candidates = extractLookupCandidates('Re: booking #88002233 please advise');
    expect(candidates).toContainEqual(
      expect.objectContaining({ kind: 'confirmation', value: '88002233' }),
    );
  });

  it('takes a labelled bare base as confirmation', () => {
    const candidates = extractLookupCandidates('Please check confirmation number 88001122');
    expect(candidates).toContainEqual(
      expect.objectContaining({ kind: 'confirmation', value: '88001122' }),
    );
  });

  it('routes agent refs to external_reference', () => {
    const candidates = extractLookupCandidates(
      'Agent ref PA88000001 and 8800SG006921 on the voucher.',
    );
    expect(
      candidates.filter((c) => c.kind === 'external_reference').map((c) => 'value' in c && c.value),
    ).toEqual(expect.arrayContaining(['PA88000001', '8800SG006921']));
    expect(candidates.some((c) => c.kind === 'confirmation')).toBe(false);
  });

  it('does not capture phone numbers or dates as confirmation', () => {
    const candidates = extractLookupCandidates(
      'Call 0821234567 arriving 2026-10-15 amount 1500.00',
    );
    expect(candidates.filter((c) => c.kind === 'confirmation' || c.kind === 'external_reference')).toEqual(
      [],
    );
  });
});

describe('resolveThreadConfirmationEvidence', () => {
  it('treats a bare base and matching dashed conf as the same booking', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: '88001122-1.pdf' },
        { filename: 'note.txt', text: 'confirmation number 88001122' },
      ]),
    ).toEqual({ confirmation: LEG1, reason: null });
  });

  it('fails closed when a labelled bare base disagrees with the dashed conf base', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: '88001122-1.pdf' },
        { filename: 'note.txt', text: 'confirmation number 99002233' },
      ]),
    ).toEqual({ confirmation: null, reason: THREAD_CONFIRMATION_AMBIGUOUS });
  });

  it('keeps one dashed conf when the labelled bare base is the same booking', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: '88001122-1.pdf' },
        { filename: 'note.txt', text: 'confirmation number 88001122' },
      ]),
    ).toEqual({ confirmation: LEG1, reason: null });
  });

  it('keeps one dashed conf when a 10-digit phone is also in the attachment text', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: '88001122-1.pdf', text: 'Please call 8212345678 about 88001122-1' },
      ]),
    ).toEqual({ confirmation: LEG1, reason: null });
  });

  it('takes a labelled bare base when the thread has no dashed conf', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: 'note.txt', text: 'Please check confirmation number 88001122' },
      ]),
    ).toEqual({ confirmation: BASE, reason: null });
  });

  it('ignores an unlabelled 10-digit token as a booking base', () => {
    expect(
      resolveThreadConfirmationEvidence([{ filename: 'scan.pdf', text: '8212345678' }]),
    ).toEqual({ confirmation: null, reason: null });
  });
});
