import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cheerio from 'cheerio';
import {
  fillTrackBeforeGuarantee,
  inspectFieldValidation,
  pickTrackLookup,
} from '../tooling/playwright-quote/create-lab-stay.mjs';
import {
  assertTrackReadyForGuarantee,
  matchTrackRow,
  parseTrackLookupText,
} from '../tooling/playwright-quote/create-request.mjs';

type CheerioNode = { type?: string; attribs?: Record<string, string>; parent?: CheerioNode | null };

function elFromCheerio($: cheerio.CheerioAPI, node: CheerioNode | undefined) {
  if (!node || node.type !== 'tag') return null;
  const attribs = node.attribs ?? {};
  const api = {
    className: attribs.class || '',
    value: attribs.value || '',
    style: { cssText: attribs.style || '', display: /display\s*:\s*none/i.test(attribs.style || '') ? 'none' : '' },
    offsetParent: null as object | null,
    getClientRects: () => [],
    getAttribute: (name: string) => (Object.hasOwn(attribs, name) ? attribs[name] : null),
    hasAttribute: (name: string) => Object.hasOwn(attribs, name),
    closest: (sel: string) => {
      const found = $(node as never).closest(sel).get(0) as CheerioNode | undefined;
      return found ? elFromCheerio($, found) : null;
    },
    querySelector: (sel: string) => {
      const found = $(node as never).find(sel).get(0) as CheerioNode | undefined;
      return found ? elFromCheerio($, found) : null;
    },
    parentElement: node.parent && node.parent.type === 'tag' ? elFromCheerio($, node.parent) : null,
  };
  return api;
}

function documentFromHtml(html: string) {
  const $ = cheerio.load(html);
  return {
    querySelector: (sel: string) => {
      const found = $(sel).get(0) as CheerioNode | undefined;
      return found ? elFromCheerio($, found) : null;
    },
  };
}

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
  rowWaitError?: string;
}) {
  const loc = (sel = ''): FixtureLocator => {
    const node: FixtureLocator = {
      first: () => node,
      last: () => node,
      locator: (next) => loc(`${sel} >> ${next}`),
      count: async () => 1,
      waitFor: async () => {
        if (opts.rowWaitError && /boundlist-item|x-grid-row/.test(sel)) {
          throw new Error(opts.rowWaitError);
        }
      },
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

  it('valid field with a hidden invalid icon and empty qtip is not an error', () => {
    const document = documentFromHtml(`
      <table class="x-form-item">
        <tr>
          <td>
            <input name="track" class="x-form-text" value="BAR" aria-invalid="false" data-errorqtip="">
            <div class="x-form-invalid-icon" style="display:none" data-errorqtip="" data-qtip=""></div>
          </td>
        </tr>
      </table>
    `);
    expect(inspectFieldValidation('track', document)).toEqual({
      invalid: false,
      messages: [],
      value: 'BAR',
    });
  });

  it('throws track_lookup_timeout when no lookup row becomes visible', async () => {
    const events: string[] = [];
    const page = fixtureTrackPage({
      events,
      validation: { invalid: false, messages: [], value: 'BAR' },
      averageRate: '1250.00',
      rowTexts: [],
      rowWaitError: 'Timeout 5000ms exceeded.',
    });
    await expect(pickTrackLookup(page, 'BAR')).rejects.toThrow(/track_lookup_timeout:Timeout 5000ms exceeded/);
  });
});
