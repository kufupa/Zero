import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseCombo } from '../tooling/playwright-quote/create-lab-stay.mjs';
import {
  bookingStateFields,
  envelopeShape,
  stdoutPayload,
} from '../tooling/playwright-quote/read-reservation-fields.mjs';

type FixtureLocator = {
  first: () => FixtureLocator;
  last: () => FixtureLocator;
  locator: (sel: string) => FixtureLocator;
  getByText: (label: string) => FixtureLocator;
  count: () => Promise<number>;
  waitFor: () => Promise<void>;
  press: () => Promise<void>;
  click: () => Promise<void>;
};

function fixturePage(options: string[], events: string[]) {
  const loc = (sel = ''): FixtureLocator => {
    const node: FixtureLocator = {
      first: () => node,
      last: () => node,
      locator: (next) => loc(`${sel} >> ${next}`),
      getByText: (label) => loc(`${sel} >> text=${label}`),
      count: async () => 1,
      waitFor: async () => undefined,
      press: async () => undefined,
      click: async () => {
        events.push(/x-boundlist-item|text=/.test(sel) ? 'option-click' : 'other-click');
      },
    };
    return node;
  };
  return {
    locator: (sel: string) => loc(sel),
    evaluate: async () => options,
  };
}

describe('reservation booking-state reader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns guarantee, deposit, A/R, agency, company from DOM when present', () => {
    const html = [
      '<input name="guaranteetype" value="Non-Guaranteed Individual">',
      '<input name="depositreceived" value="0.00">',
      '<input name="araccountname" value="AR-SYNTH">',
      '<input name="ta1" value="AG-SYNTH">',
      '<input name="company" value="ORG-SYNTH">',
    ].join('');
    expect(bookingStateFields(html)).toEqual({
      guaranteeType: 'Non-Guaranteed Individual',
      depositReceived: '0.00',
      arAccount: 'AR-SYNTH',
      agency: 'AG-SYNTH',
      company: 'ORG-SYNTH',
    });
  });

  it('returns null when DOM fields are absent and never guesses payment', () => {
    const absent = bookingStateFields('<input name="status" value="Reserved">');
    expect(absent).toEqual({
      guaranteeType: null,
      depositReceived: null,
      arAccount: null,
      agency: null,
      company: null,
    });
    expect(JSON.stringify(absent).includes('unpaid')).toBe(false);
    expect(JSON.stringify(absent).includes('paid')).toBe(false);
  });

  it('uses allow-listed HDR JSON keys and stays fail-closed', () => {
    expect(
      bookingStateFields(
        JSON.stringify({
          confirmationnumber: '00000000-1',
          guaranteetype: 'Walk in',
          depositreceived: '0',
          araccountname: 'AR-SYNTH',
          ta1: 'AG-SYNTH',
          company: 'ORG-SYNTH',
        }),
      ),
    ).toEqual({
      guaranteeType: 'Walk in',
      depositReceived: '0',
      arAccount: 'AR-SYNTH',
      agency: 'AG-SYNTH',
      company: 'ORG-SYNTH',
    });
    const missing = bookingStateFields(
      JSON.stringify({ confirmationnumber: '00000000-1', status: 'Reserved' }),
    );
    expect(missing.guaranteeType).toBeNull();
    expect(missing.depositReceived).toBeNull();
    expect(missing.arAccount).toBeNull();
    expect(missing.agency).toBeNull();
    expect(missing.company).toBeNull();
  });

  it('omits bookingState values from stdout payload', () => {
    const payload = stdoutPayload({
      phase: 'search',
      outcome: 'read',
      rowCount: 1,
      bookingState: { guaranteeType: 'Walk in', depositReceived: '0' },
      envelope: envelopeShape({ GRIDRESULT: { GRID: { DATA: [{ lastname: 'PII' }] } } }),
      positiveControl: true,
    });
    const json = JSON.stringify(payload);
    expect('bookingState' in payload).toBe(false);
    expect(json.includes('Walk in')).toBe(false);
    expect(json.includes('PII')).toBe(false);
  });

  it('chooseCombo logs the option list before any click', async () => {
    const events: string[] = [];
    const options = ['Walk in', 'Non-Guaranteed Individual'];
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      events.push('log');
      return true;
    }) as typeof process.stderr.write);

    await chooseCombo(fixturePage(options, events), 'guaranteetype', 'Walk in');

    const payload = writes
      .map((chunk) => {
        try {
          return JSON.parse(chunk.trim()) as { phase?: string; options?: string[] };
        } catch {
          return null;
        }
      })
      .find((row) => row?.phase === 'chooseCombo');
    expect(payload?.options).toEqual(options);
    expect(events.indexOf('log')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('log')).toBeLessThan(events.indexOf('option-click'));
  });
});
