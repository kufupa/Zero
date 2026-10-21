import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillTrackBeforeGuarantee } from '../tooling/playwright-quote/create-lab-stay.mjs';
import {
  assertTrackReadyForGuarantee,
  matchTrackRow,
  parseTrackLookupText,
} from '../tooling/playwright-quote/create-request.mjs';

type FixtureLocator = {
  first: () => FixtureLocator;
  last: () => FixtureLocator;
  locator: (sel: string) => FixtureLocator;
  count: () => Promise<number>;
  waitFor: () => Promise<void>;
  click: () => Promise<void>;
};

function fixtureTrackPage(opts: {
  events: string[];
  validation: { invalid: boolean; messages: string[]; value: string };
  averageRate: string;
  rowTexts: string[];
}) {
  const loc = (sel = ''): FixtureLocator => {
    const node: FixtureLocator = {
      first: () => node,
      last: () => node,
      locator: (next) => loc(`${sel} >> ${next}`),
      count: async () => 1,
      waitFor: async () => undefined,
      click: async () => {
        opts.events.push(sel.includes('trigger') ? 'trigger-click' : 'other-click');
      },
    };
    return node;
  };
  return {
    locator: (sel: string) => loc(sel),
    evaluate: async (fn: (...args: unknown[]) => unknown, arg?: unknown) => {
      const src = Function.prototype.toString.call(fn);
      if (src.includes('data-errorqtip')) return opts.validation;
      if (arg === 'averagerate') return opts.averageRate;
      if (arg && typeof arg === 'object' && arg !== null && ('code' in arg || 'description' in arg)) {
        const picked = arg as { code?: string; description?: string };
        opts.events.push(`row-click:${picked.code}:${picked.description}`);
        return true;
      }
      if (src.includes('x-boundlist-item') || src.includes('x-grid-row')) return opts.rowTexts;
      return undefined;
    },
  };
}

describe('create-lab-stay track lookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects by description Best Available and stores code BAR', () => {
    const rows = [
      parseTrackLookupText('COR Corporate Rate'),
      parseTrackLookupText('BAR Best Available'),
    ];
    const picked = matchTrackRow(rows, 'Best Available');
    expect(picked?.description).toBe('Best Available');
    expect(picked?.code).toBe('BAR');
    expect(matchTrackRow(rows, 'BAR')?.code).toBe('BAR');
  });

  it('fails a red validation mark before guarantee is opened', () => {
    let guaranteeOpened = false;
    expect(() => {
      assertTrackReadyForGuarantee({
        validation: { invalid: true, messages: ['Invalid value'] },
        averageRate: '1250.00',
      });
      guaranteeOpened = true;
    }).toThrow(/track_invalid:Invalid value/);
    expect(guaranteeOpened).toBe(false);
  });

  it('logs track rows before the lookup click and throws on a red mark', async () => {
    const events: string[] = [];
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      events.push('log');
      return true;
    }) as typeof process.stderr.write);

    const page = fixtureTrackPage({
      events,
      validation: { invalid: true, messages: ['Invalid value'], value: 'BAR' },
      averageRate: '',
      rowTexts: ['COR Corporate Rate', 'BAR Best Available'],
    });

    await expect(fillTrackBeforeGuarantee(page, 'BAR')).rejects.toThrow(/track_invalid/);
    const lookup = writes
      .map((chunk) => {
        try {
          return JSON.parse(chunk.trim()) as { phase?: string; rows?: Array<{ code: string; description: string }> };
        } catch {
          return null;
        }
      })
      .find((row) => row?.phase === 'trackLookup');
    expect(lookup?.rows).toEqual([
      { code: 'COR', description: 'Corporate Rate', text: 'COR Corporate Rate' },
      { code: 'BAR', description: 'Best Available', text: 'BAR Best Available' },
    ]);
    expect(events.indexOf('log')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('log')).toBeLessThan(events.indexOf('row-click:BAR:Best Available'));
    const validationLog = writes.some((chunk) => chunk.includes('trackValidation') && chunk.includes('Invalid value'));
    expect(validationLog).toBe(true);
  });
});
