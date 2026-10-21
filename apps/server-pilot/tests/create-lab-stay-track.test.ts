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
  fill: (value: string) => Promise<void>;
  press: (key: string) => Promise<void>;
};

function fixtureTrackPage(opts: {
  events: string[];
  validation: { invalid: boolean; messages: string[]; value: string };
  averageRate: string;
  rowTexts: string[];
  rowWaitError?: string;
  maskVisible?: boolean;
}) {
  let maskVisible = opts.maskVisible ?? false;
  let averageRate = opts.averageRate;
  const loc = (sel = ''): FixtureLocator => {
    const node: FixtureLocator = {
      first: () => node,
      last: () => node,
      locator: (next) => loc(`${sel} >> ${next}`),
      count: async () => (sel.includes('ancestor::table[1]') ? 0 : 1),
      waitFor: async () => {
        if (opts.rowWaitError && /boundlist-item|x-grid-row/.test(sel)) {
          throw new Error(opts.rowWaitError);
        }
      },
      click: async () => {
        opts.events.push(`click:${sel}`);
      },
      fill: async (value) => {
        opts.events.push(`fill:${value}`);
      },
      press: async (key) => {
        opts.events.push(`press:${key}`);
      },
    };
    return node;
  };
  return {
    locator: (sel: string) => loc(sel),
    waitForTimeout: async () => {
      opts.events.push('wait');
      maskVisible = false;
      if (!averageRate) averageRate = '1250.00';
    },
    evaluate: async (fn: (...args: unknown[]) => unknown, arg?: unknown) => {
      const src = Function.prototype.toString.call(fn);
      if (src.includes('x-mask-msg')) return maskVisible;
      if (src.includes('data-errorqtip') || src.includes('inspectFieldValidation') || src.includes('aria-invalid')) {
        return opts.validation;
      }
      if (arg === 'averagerate') return averageRate;
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

  it('does not open a lookup when Track is already valid', async () => {
    const events: string[] = [];
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    await fillTrackBeforeGuarantee(
      fixtureTrackPage({
        events,
        validation: { invalid: false, messages: [], value: 'Best Available' },
        averageRate: '1250.00',
        rowTexts: ['BAR Best Available'],
      }),
      'BAR',
    );

    expect(events.some((event) => event.startsWith('fill:Best Available'))).toBe(true);
    expect(events.some((event) => event.includes('trigger') || event.startsWith('row-click'))).toBe(false);
    expect(writes.some((chunk) => chunk.includes('"phase":"track_typed"'))).toBe(true);
    expect(writes.some((chunk) => chunk.includes('"phase":"track_valid"') && chunk.includes('"valid":true'))).toBe(true);
    expect(writes.some((chunk) => chunk.includes('"phase":"mask_cleared"'))).toBe(true);
    expect(writes.some((chunk) => chunk.includes('"phase":"average_rate"'))).toBe(true);
  });

  it('waits while the HMS processing mask is visible', async () => {
    const events: string[] = [];
    await fillTrackBeforeGuarantee(
      fixtureTrackPage({
        events,
        validation: { invalid: false, messages: [], value: 'Best Available' },
        averageRate: '',
        rowTexts: [],
        maskVisible: true,
      }),
      'BAR',
    );
    expect(events.filter((event) => event === 'wait').length).toBeGreaterThan(0);
  });

  it('opens the Track trigger inside its own wrapper, not a table-wide trigger', async () => {
    const events: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      fillTrackBeforeGuarantee(
        fixtureTrackPage({
          events,
          validation: { invalid: true, messages: ['Invalid value'], value: 'BAR' },
          averageRate: '1250.00',
          rowTexts: ['COR Corporate Rate', 'BAR Best Available'],
        }),
        'BAR',
      ),
    ).rejects.toThrow(/track_invalid/);
    const triggerClicks = events.filter((event) => event.startsWith('click:') && event.includes('trigger'));
    expect(triggerClicks.length).toBeGreaterThan(0);
    expect(triggerClicks.every((event) => event.includes('x-form-item') || event.includes('x-field'))).toBe(true);
    expect(triggerClicks.some((event) => event.includes('ancestor::table[1]'))).toBe(false);
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
