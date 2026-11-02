import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', () => ({ installReadOnlyGuard: vi.fn(async () => {}) }));
import { consumeLabtestPreimage, searchLabtestBatchPreimage, searchLabtestPreimage } from '../tooling/hms-cloud/labtest-preimage.mjs';

const binding = { manifestDigest: 'a'.repeat(64), childId: 'b'.repeat(64), childDigest: 'c'.repeat(64) };
const dates = { arrival: '2027-03-01', departure: '2027-03-03' };
const offset = (date) => (Date.parse(`${date}T00:00:00Z`) - Date.parse('2026-11-02T00:00:00Z')) / 86_400_000;
function makePage({ firstName = 'Proof', duringText, duringGrid, extraForm, query = '' } = {}) {
  const page = new EventEmitter();
  const form = new URLSearchParams({ MADDON_FILTER_ALIAS_NAME_1: 'departuredate', MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_VALUE_1: String(offset('2027-02-20')), MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
    MADDON_FILTER_OPERATOR_2: '<=', MADDON_FILTER_VALUE_2: String(offset('2027-03-20')),
    MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter', MADDON_FILTER_OPERATOR_5: 'BEGINS', MADDON_FILTER_VALUE_5: 'Labtest', GRID_NAME: 'OSRESS' });
  if (extraForm) for (const [key, value] of Array.isArray(extraForm[0]) ? extraForm : [extraForm]) form.append(key, value);
  const request = { method: () => 'POST', url: () => `https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESS.search${query}`, postData: () => form.toString() };
  const response = { request: () => request, status: () => 200, text: async () => {
    duringText?.(page, request);
    return JSON.stringify({ pageData: { grid: { GRIDRESULT: { GRID: { METADATA: { GRIDNAME: 'OSRESS', RECORDS: '1', MORERECORDPRESENT: '-' },
      DATA: [{ confirmationnumber: 'C1', firstname: firstName, lastname: 'Labtest', arrivaldate: '01-MAR-2027', departuredate: '03-MAR-2027', status: 'Reserved' }] } } } } });
  } };
  const grid = { count: async () => 1, evaluateAll: async () => { duringGrid?.(page, request); return [[['C1'], [], [], ['01-MAR-2027', '03-MAR-2027']]]; } };
  const popup = { boundingBox: async () => ({ x: 0, y: 20, width: 100, height: 100 }),
    evaluate: async () => ({ displayed: 1, total: 1, history: false, loading: false }),
    locator: (selector) => selector === '.x-grid-row:visible' ? grid : { count: async () => 1, innerText: async () => 'Feb 20, 2027 - Mar 20, 2027' } };
  const input = { first() { return this; }, waitFor: async () => {}, count: async () => 1,
    boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 20 }), fill: async () => {} };
  const run = { boundingBox: async () => ({ x: 100, y: 0, width: 20, height: 20 }), click: async () => page.emit('request', request) };
  page.url = () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base';
  page.title = async () => 'Infor HMS - HRCEN'; page.context = () => ({});
  page.waitForResponse = async (predicate) => { if (!predicate(response)) throw new Error('UNMATCHED_RESPONSE'); return response; };
  page.locator = (selector) => selector.startsWith('input[name="search"]') ? input : selector === '.x-window.x-menu:visible'
    ? { count: async () => 1, nth: () => popup }
    : { filter() { return this; }, count: async () => 1, nth: () => run };
  return page;
}

afterEach(() => vi.useRealTimers());
describe('Labtest batch native census proof', () => {
  it('keeps the original clear single-create proof page-bound and single-use', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const page = makePage({ firstName: 'Someone' });
    const result = await searchLabtestPreimage(page, dates);
    expect(result.outcome).toBe('clear');
    expect(consumeLabtestPreimage(page, { ...dates, preimageId: result.preimageId })).toBe(true);
    expect(consumeLabtestPreimage(page, { ...dates, preimageId: result.preimageId })).toBe(false);
  });
  it('requires matching trusted binding and rejects a legacy consumer', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const authorizeSiblings = vi.fn(async () => ({ authorized: true, matches: [{ confirmation: 'C1', recordDigest: 'd'.repeat(64) }] }));
    const page = makePage(); const result = await searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings });
    expect(result.outcome).toBe('siblings_verified');
    expect(consumeLabtestPreimage(page, { ...dates, preimageId: result.preimageId, batchBinding: binding })).toBe(true);
    const other = makePage(); const second = await searchLabtestBatchPreimage(other, dates, { binding, authorizeSiblings });
    expect(consumeLabtestPreimage(other, { ...dates, preimageId: second.preimageId })).toBe(false);
    expect(consumeLabtestPreimage(other, { ...dates, preimageId: second.preimageId, batchBinding: binding })).toBe(false);
  });
  it('holds when a mutation or extra search occurs during census correlation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const mutation = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/delete' };
    const nativeSave = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR',
      postData: () => 'pageaction=SAVE' };
    for (const page of [makePage({ duringText: (p) => p.emit('request', mutation) }),
      makePage({ duringText: (p) => p.emit('request', nativeSave) }),
      makePage({ duringGrid: (p, request) => p.emit('request', request) })]) {
      const result = await searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings: vi.fn() });
      expect(result).toMatchObject({ outcome: 'incomplete', issue: 'SEARCH_CHANGED_DURING_OBSERVATION' });
      expect(consumeLabtestPreimage(page, { ...dates, preimageId: result.preimageId, batchBinding: binding })).toBe(false);
    }
  });
  it('holds a census when a case-variant filter duplicates a matched request field', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const page = makePage({ extraForm: ['maddon_filter_value_5', 'Other'] });
    const authorizeSiblings = vi.fn();
    const result = await searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings });
    expect(result.outcome).toBe('incomplete');
    expect(authorizeSiblings).not.toHaveBeenCalled();
  });
  it('holds a narrower census with extra filters or unknown request semantics', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const cases = [
      { extraForm: [['MADDON_FILTER_ALIAS_NAME_3', 'firstname'], ['MADDON_FILTER_OPERATOR_3', '='],
        ['MADDON_FILTER_VALUE_3', 'Someone']] },
      { extraForm: ['MADDON_FILTER_JOINER_1', 'OR'] },
      { extraForm: ['UNKNOWN_SEARCH_FILTER', 'Someone'] },
      { query: '?firstname=Someone' },
    ];
    for (const options of cases) {
      const authorizeSiblings = vi.fn();
      const result = await searchLabtestBatchPreimage(makePage(options), dates, { binding, authorizeSiblings });
      expect(result.outcome).toBe('incomplete');
      expect(authorizeSiblings).not.toHaveBeenCalled();
    }
  });
  it('keeps existing same-arrival matches unavailable to the single-create path', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const result = await searchLabtestPreimage(makePage(), dates);
    expect(result.outcome).toBe('existing_matches');
    expect(result.preimageId).toBeUndefined();
  });
  it('rejects a proof if the clock moves behind the census start', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const page = makePage({ firstName: 'Someone' });
    const result = await searchLabtestPreimage(page, dates);
    vi.setSystemTime(new Date('2026-11-02T11:59:00Z'));
    expect(consumeLabtestPreimage(page, { ...dates, preimageId: result.preimageId })).toBe(false);
  });
  it('holds a census that expires while response and grid are correlated', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const page = makePage({ duringGrid: () => vi.setSystemTime(new Date('2026-11-02T12:06:00Z')) });
    const result = await searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings: vi.fn() });
    expect(result).toMatchObject({ outcome: 'incomplete', issue: 'SEARCH_EXPIRED_DURING_OBSERVATION' });
  });
  it('invalidates a pending verifier if the page closes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    let started; const running = new Promise((resolve) => { started = resolve; });
    const authorizeSiblings = ({ signal }) => { started(); return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))); };
    const page = makePage(), result = searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings });
    await running; page.emit('close');
    expect(await result).toMatchObject({ outcome: 'incomplete', issue: 'BATCH_SIBLINGS_UNVERIFIED' });
  });
  it('rejects sibling sets not matching the observed census', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const page = makePage();
    const result = await searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings: async () => ({ authorized: true,
      matches: [{ confirmation: 'OTHER', recordDigest: 'd'.repeat(64) }] }) });
    expect(result).toMatchObject({ outcome: 'incomplete', issue: 'BATCH_SIBLINGS_UNVERIFIED' });
  });
});
