/**
 * Guest Stay detail open (inert). Wave A1 surface — allowed here; denied on find.
 * Prefer Playwright dblclick on the matched ExtJS result row; fall back to reviewed
 * OSRESV.HDR open by confirmation / reservationstayid. Never save.
 */
import type { HmsPage, HmsReadSession } from './runtime.js';
import { HmsRuntimeError } from './runtime.js';
import type { ReservationDetailDumpV1 } from './reservation-detail-projection.js';

export interface ReservationDetailFacade {
  /** Open matched search-grid row into detail; return key inventory (+ optional values). */
  openMatchedRowAndDump(options?: {
    captureValues?: boolean;
    /** Confirmation / external ref token expected in the result row text. */
    matchToken?: string;
    /** OSRESS GRID DATA.id → reservationstayid when present. */
    reservationStayId?: string | null;
  }): Promise<ReservationDetailDumpV1>;
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
      if (
        [
          'search',
          'dataspylist',
          'showfilter',
          'filterfields',
          'selfiltervaluectrl',
          'appmenusearch',
        ].includes(k)
      ) {
        continue;
      }
      filledNonSearch += 1;
    }
    return { keys: keyList.sort(), values, searchChrome, filledNonSearch };
  });
}

function dumpFromForm(collected: FormDump, captureValues: boolean): ReservationDetailDumpV1 {
  const dump: ReservationDetailDumpV1 = {
    schemaVersion: 1,
    surface: 'guest_stay_detail',
    keys: collected.keys.filter((k) => !SEARCH_CHROME_KEYS.has(k)),
  };
  if (captureValues) {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(collected.values)) {
      if (SEARCH_CHROME_KEYS.has(k)) continue;
      values[k] = v;
    }
    dump.values = values;
  }
  return dump;
}

function keysFromHdrBody(body: string): FormDump {
  const keys = new Set<string>();
  const values: Record<string, string> = {};
  for (const m of body.matchAll(/\bname=["']([^"']+)["']/gi)) {
    const name = (m[1] || '').trim().toLowerCase();
    if (!name) continue;
    const normalized = name.replace(/^ff_/, '').replace(/^filter_/, '');
    keys.add(normalized);
    keys.add(name);
  }
  for (const m of body.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    const k = m[1]!.toLowerCase();
    if (k.length > 48) continue;
    keys.add(k);
  }
  const keyList = Array.from(keys).sort();
  const searchChrome = keyList.some((k) =>
    ['search', 'dataspylist', 'showfilter', 'filterfields', 'selfiltervaluectrl'].includes(k),
  );
  // HDR body is not the search filter surface when it carries stay identity keys.
  const stayHints = ['confirmationnumber', 'arrivaldate', 'departuredate', 'roomtype', 'status'];
  const filledNonSearch = stayHints.filter((k) => keyList.includes(k)).length;
  return { keys: keyList, values, searchChrome, filledNonSearch };
}

async function waitDetailForm(page: HmsPage, budgetMs: number): Promise<FormDump | null> {
  let collected: FormDump | null = null;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    collected = await collectFormKeys(page);
    if (collected.filledNonSearch >= 3 && !(collected.searchChrome && collected.filledNonSearch < 3)) {
      return collected;
    }
    if (collected.filledNonSearch >= 3) return collected;
  }
  return collected;
}

export function createReservationDetailFacade(input: {
  session: HmsReadSession;
}): ReservationDetailFacade {
  return {
    async openMatchedRowAndDump(options) {
      const page = input.session.page;
      const matchToken = (options?.matchToken || '').trim();
      const stayId = (options?.reservationStayId || '').trim();
      let opened = false;
      let lastOpenError: unknown;

      if (matchToken && typeof page.dblclickRowContaining === 'function') {
        try {
          await page.dblclickRowContaining(matchToken);
          opened = true;
        } catch (err) {
          lastOpenError = err;
        }
      }

      if (!opened) {
        const selectors = ['.x-grid3-row', '.x-grid-row', 'tr.x-grid3-row'];
        for (const selector of selectors) {
          try {
            await page.dblclick(selector);
            opened = true;
            break;
          } catch (err) {
            lastOpenError = err;
            try {
              await page.click(selector);
              await new Promise((resolve) => setTimeout(resolve, 250));
              await page.dblclick(selector);
              opened = true;
              break;
            } catch (err2) {
              lastOpenError = err2;
            }
          }
        }
      }

      let collected = opened ? await waitDetailForm(page, 12_000) : null;
      if (collected && collected.filledNonSearch >= 3) {
        return dumpFromForm(collected, Boolean(options?.captureValues));
      }

      // Reviewed inert HDR open — confirmation / stay id from matched OSRESS row.
      if (matchToken || stayId) {
        const fields: Record<string, string> = {
          CURRENT_TAB_NAME: 'HDR',
          MENU_MODULE_KEY: '0',
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'OSRESV',
          removescreenflows: 'yes',
          propertycode: 'HRCEN',
        };
        if (matchToken) fields.confirmationnumber = matchToken;
        if (stayId) fields.reservationstayid = stayId;
        const hdrBody = await page.postForm(`${input.session.origin}/web/base/OSRESV.HDR`, fields);
        collected = await waitDetailForm(page, 8_000);
        if (collected && collected.filledNonSearch >= 3) {
          return dumpFromForm(collected, Boolean(options?.captureValues));
        }
        const fromBody = keysFromHdrBody(hdrBody || '');
        if (fromBody.filledNonSearch >= 3) {
          return dumpFromForm(fromBody, Boolean(options?.captureValues));
        }
        lastOpenError = new Error('HDR open did not yield stay fields');
      }

      if (!opened) {
        const msg =
          lastOpenError instanceof Error ? lastOpenError.message.slice(0, 120) : '';
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          msg
            ? `guest stay detail open: no grid row (${msg})`
            : 'guest stay detail open: no grid row',
        );
      }
      if (!collected || collected.keys.length === 0) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'guest stay detail dump produced zero form keys');
      }
      if (collected.searchChrome && collected.filledNonSearch < 3) {
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          'guest stay detail open still on search chrome (no stay fields filled)',
        );
      }
      return dumpFromForm(collected, Boolean(options?.captureValues));
    },
  };
}
