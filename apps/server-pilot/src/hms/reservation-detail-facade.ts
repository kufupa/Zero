/**
 * Guest Stay detail open (inert). Wave A1 surface — allowed here; denied on find.
 * Uses Playwright dblclick on ExtJS grid rows. Never save.
 */
import type { HmsPage, HmsReadSession } from './runtime.js';
import { HmsRuntimeError } from './runtime.js';
import type { ReservationDetailDumpV1 } from './reservation-detail-projection.js';

export interface ReservationDetailFacade {
  /** Open first search-grid match into detail; return key inventory (+ optional values). */
  openMatchedRowAndDump(options?: { captureValues?: boolean }): Promise<ReservationDetailDumpV1>;
}

type FormDump = {
  keys: string[];
  values: Record<string, string>;
  searchChrome: boolean;
  filledNonSearch: number;
};

const SEARCH_CHROME_KEYS = new Set([
  'search',
  'dataspylist',
  'showfilter',
  'filterfields',
  'selfiltervaluectrl',
  'appmenusearch',
]);

async function collectFormKeys(page: HmsPage): Promise<FormDump> {
  return page.evaluateStableDom(() => {
    const doc = (globalThis as unknown as {
      document?: {
        querySelectorAll(sel: string): ArrayLike<{
          getAttribute(name: string): string | null;
          value?: string;
        }>;
      };
    }).document;
    const keys = new Set<string>();
    const values: Record<string, string> = {};
    if (!doc) {
      return { keys: [], values: {}, searchChrome: false, filledNonSearch: 0 };
    }
    const nodes = doc.querySelectorAll('input[name], select[name], textarea[name]');
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const name = (node.getAttribute('name') || '').trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      const normalized = lower.replace(/^ff_/, '').replace(/^filter_/, '');
      keys.add(normalized);
      keys.add(lower);
      const raw = typeof node.value === 'string' ? node.value : '';
      if (raw && raw.length <= 128 && !/password|secret|token|cookie/i.test(lower)) {
        values[normalized] = raw;
      }
    }
    const keyList = Array.from(keys);
    const searchChrome = keyList.some((k) =>
      ['search', 'dataspylist', 'showfilter', 'filterfields', 'selfiltervaluectrl'].includes(k),
    );
    let filledNonSearch = 0;
    for (const [k, v] of Object.entries(values)) {
      if (!v) continue;
      if (['search', 'dataspylist', 'showfilter', 'filterfields', 'selfiltervaluectrl', 'appmenusearch'].includes(k)) {
        continue;
      }
      filledNonSearch += 1;
    }
    return { keys: keyList.sort(), values, searchChrome, filledNonSearch };
  });
}

export function createReservationDetailFacade(input: {
  session: HmsReadSession;
}): ReservationDetailFacade {
  return {
    async openMatchedRowAndDump(options) {
      const page = input.session.page;
      const selectors = [
        '.x-grid3-row',
        '.x-grid-row',
        'tr.x-grid3-row',
        '.x-grid3-row-table',
      ];
      let opened = false;
      for (const selector of selectors) {
        try {
          await page.dblclick(selector);
          opened = true;
          break;
        } catch {
          // try next selector
        }
      }
      if (!opened) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail open: no grid row');
      }
      // Wait for ExtJS detail chrome / HDR.
      let collected: FormDump | null = null;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        collected = await collectFormKeys(page);
        if (collected.filledNonSearch >= 3) break;
      }
      if (!collected || collected.keys.length === 0) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail dump produced zero form keys');
      }
      // Reject search-only dumps (dblclick failed to leave OSRESS list).
      if (collected.searchChrome && collected.filledNonSearch < 3) {
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          'guest stay detail open still on search chrome (no stay fields filled)',
        );
      }
      const dump: ReservationDetailDumpV1 = {
        schemaVersion: 1,
        surface: 'guest_stay_detail',
        keys: collected.keys.filter((k) => !SEARCH_CHROME_KEYS.has(k)),
      };
      if (options?.captureValues) {
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(collected.values)) {
          if (SEARCH_CHROME_KEYS.has(k)) continue;
          values[k] = v;
        }
        dump.values = values;
      }
      return dump;
    },
  };
}
