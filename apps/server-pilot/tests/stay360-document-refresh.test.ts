import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(), dismiss: vi.fn(), notes: vi.fn() }));
vi.mock('../tooling/hms-cloud/stay360-record-tabs.mjs', () => ({ openStay360RecordTab: mocks.open }));
vi.mock('../tooling/playwright-quote/stay360-notes.mjs', () => ({
  dismissNotesOrThrow: mocks.dismiss, takeHandledNotes: mocks.notes,
}));
import { observeDocumentRefresh } from '../tooling/hms-cloud/stay360-document-refresh.mjs';
import { readDocumentsFromStay360 } from '../tooling/hms-cloud/stay360-documents.mjs';

const confirmation = '123456-1';
const identity = () => ({ propertyCode: 'HRCEN', reservationId: '123', reservationStayId: '456' });
const frame = () => ({ url: () => 'https://hms.example/record', isDetached: () => false });
function request(target = frame(), overrides: Record<string, string> = {}) {
  const fields = new URLSearchParams({ CURRENT_TAB_NAME: 'DOC', confirmationnumber: confirmation,
    reservationstayid: '456', propertycode: 'HRCEN', daeRentity: 'RESV', daeCode: `123#${confirmation}#HRCEN` });
  for (const [key, value] of Object.entries(overrides)) fields.set(key, value);
  return { frame: () => target, method: () => 'POST', url: () => 'https://hms.example/web/base/OSRESV.DOC',
    postData: () => fields.toString() };
}
function done(page: EventEmitter, req: ReturnType<typeof request>, status = 200) {
  page.emit('request', req);
  page.emit('response', { request: () => req, status: () => status });
  page.emit('requestfinished', req);
}

describe('document refresh observation', () => {
  it('observes one exact same-frame request without claiming document coverage', () => {
    const page = new EventEmitter(), target = frame(), expected = identity();
    const observer = observeDocumentRefresh(page, confirmation, expected);
    expected.reservationId = 'changed-after-start';
    done(page, request(target));
    expect(observer.result(target)).toEqual({ status: 'matched_response' });
    observer.stop();
    for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) expect(page.listenerCount(event)).toBe(0);
  });

  it('rejects wrong stay, native identity, property, frame or duplicate fields', () => {
    for (const fields of [
      { confirmationnumber: 'other' }, { reservationstayid: 'other' }, { propertycode: 'HRDAV' },
      { daeCode: `999#${confirmation}#HRCEN` }, { daeRentity: 'OTHER' }, { CURRENT_TAB_NAME: 'FOL' },
    ]) {
      const page = new EventEmitter(), target = frame(), observer = observeDocumentRefresh(page, confirmation, identity());
      done(page, request(target, fields));
      expect(observer.result(target)).toEqual({ status: 'unverified' });
      observer.stop();
    }
    const page = new EventEmitter(), target = frame(), observer = observeDocumentRefresh(page, confirmation, identity());
    done(page, request(frame()));
    expect(observer.result(target)).toEqual({ status: 'unverified' });
    const duplicate = request(target);
    const original = duplicate.postData();
    duplicate.postData = () => `${original}&propertycode=HRCEN`;
    done(page, duplicate);
    expect(observer.result(target)).toEqual({ status: 'unverified' });
    observer.stop();
  });

  it('rejects multiple requests, failed, pending, non-200 and wrong-origin responses', () => {
    for (const scenario of ['multiple', 'failed', 'pending', 'http', 'origin', 'query', 'get']) {
      const page = new EventEmitter(), target = frame(), observer = observeDocumentRefresh(page, confirmation, identity());
      const req = request(target);
      if (scenario === 'origin') req.url = () => 'https://wrong.example/web/base/OSRESV.DOC';
      if (scenario === 'query') req.url = () => 'https://hms.example/web/base/OSRESV.DOC?x=1';
      if (scenario === 'get') req.method = () => 'GET';
      if (scenario === 'pending') page.emit('request', req);
      else done(page, req, scenario === 'http' ? 500 : 200);
      if (scenario === 'failed') page.emit('requestfailed', req);
      if (scenario === 'multiple') done(page, request(target));
      expect(observer.result(target), scenario).toEqual({ status: 'unverified' });
      observer.stop();
    }
  });

  it('fails closed for invalid identities and excessive candidate traffic', () => {
    const page = new EventEmitter(), target = frame();
    for (const bad of [{ ...identity(), reservationId: '' }, { ...identity(), propertyCode: 'hrcen' },
      { ...identity(), reservationStayId: 'x#y' }, { ...identity(), extra: 'x' }]) {
      expect(() => observeDocumentRefresh(page, confirmation, bad)).toThrow('DOCUMENT_REFRESH_IDENTITY_INVALID');
    }
    const observer = observeDocumentRefresh(page, confirmation, identity());
    for (let index = 0; index < 101; index++) page.emit('request', request(target));
    expect(observer.result(target)).toEqual({ status: 'unverified' });
    observer.stop();
  });

  it('keeps correlated network evidence distinct from freshness and completeness', async () => {
    const page = Object.assign(new EventEmitter(), { waitForTimeout: vi.fn(async () => {}) });
    const target = Object.assign(frame(), { waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ documents: [], coverage: { refreshVerified: false, complete: null } })) });
    mocks.open.mockImplementation(async () => { done(page, request(target)); return { frame: target, notes: [] }; });
    mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
    const result = await readDocumentsFromStay360(page, confirmation, { identity: identity() });
    expect(result.coverage).toEqual({ refreshVerified: false, complete: null, refreshObservation: { status: 'matched_response' } });
    expect(page.listenerCount('request')).toBe(0);
  });

  it('retains document descriptions without inventing stable native IDs', async () => {
    const page = Object.assign(new EventEmitter(), { waitForTimeout: vi.fn(async () => {}) });
    const child = { isLeaf: () => true, data: { documentFileName: 'voucher.pdf', documentcode: 'NAVA123',
      description: 'NAVA123 voucher.pdf', id: 'not-proven-stable' } };
    const root = { isLoaded: () => true, cascadeBy: (visit: (node: unknown) => void) => {
      visit({ isLeaf: () => false, isLoaded: () => true }); visit(child);
    } };
    const store = { getRootNode: () => root, isLoading: () => false };
    vi.stubGlobal('Ext', { ComponentQuery: { query: () => [{ isVisible: () => true, getStore: () => store }] } });
    try {
      const target = Object.assign(frame(), { waitForFunction: vi.fn(async () => {}),
        evaluate: async (read: () => unknown) => read() });
      mocks.open.mockResolvedValue({ frame: target, notes: [] });
      mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
      const result = await readDocumentsFromStay360(page, confirmation);
      expect(result.documents).toEqual([{ name: 'voucher.pdf', documentCode: 'NAVA123', documentId: null,
        description: 'NAVA123 voucher.pdf', label: '' }]);
      expect(result.coverage).toMatchObject({ complete: null, refreshVerified: false,
        refreshObservation: { status: 'not_requested' } });
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves raw field states, nested values and unknown leaves', async () => {
    const page = Object.assign(new EventEmitter(), { waitForTimeout: vi.fn(async () => {}) });
    const child = { isLeaf: () => true, data: { documentFileName: 'voucher.pdf', documentcode: 'NAVA123',
      description: '  ', nil: null, blank: '', missingValue: undefined, nested: { note: '  text  ' },
      list: [null, ''] } };
    const unknown = { isLeaf: () => true, data: { text: 'Unexpected item', extra: '  raw  ' } };
    const root = { isLoaded: () => true, cascadeBy: (visit: (node: unknown) => void) => {
      visit({ isLeaf: () => false, isLoaded: () => true }); visit(child); visit(unknown);
    } };
    const store = { getRootNode: () => root, isLoading: () => false };
    vi.stubGlobal('Ext', { ComponentQuery: { query: () => [{ isVisible: () => true, getStore: () => store }] } });
    try {
      const target = Object.assign(frame(), { waitForFunction: vi.fn(async () => {}),
        evaluate: async (read: () => unknown) => read() });
      mocks.open.mockResolvedValue({ frame: target, notes: [] });
      mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
      const result = await readDocumentsFromStay360(page, confirmation);
      const item = result.observedNodes[1];
      expect(item.documentIndex).toBe(0);
      expect(item.data.type).toBe('object');
      expect(item.data.fields).toContainEqual({ key: 'description', value: { type: 'string', value: '  ' } });
      expect(item.data.fields).toContainEqual({ key: 'nil', value: { type: 'null' } });
      expect(item.data.fields).toContainEqual({ key: 'blank', value: { type: 'string', value: '' } });
      expect(item.data.fields).toContainEqual({ key: 'missingValue', value: { type: 'undefined' } });
      expect(item.data.fields.some((field: { key: string }) => field.key === 'absent')).toBe(false);
      expect(item.data.fields).toContainEqual({ key: 'nested', value: { type: 'object', fields: [
        { key: 'note', value: { type: 'string', value: '  text  ' } },
      ] } });
      expect(item.data.fields).toContainEqual({ key: 'list', value: { type: 'array', fields: [
        { key: '0', value: { type: 'null' } }, { key: '1', value: { type: 'string', value: '' } },
        { key: 'length', value: { type: 'number', value: '2' } },
      ] } });
      expect(result.observedNodes[2]).toMatchObject({ leaf: true, documentIndex: null,
        data: { fields: expect.arrayContaining([{ key: 'extra', value: { type: 'string', value: '  raw  ' } }]) } });
      expect(result.coverage).toMatchObject({ metadataCapture: 'captured', metadataIssues: 0,
        unrecognizedLeaves: 1, status: 'partial', refreshVerified: false, complete: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it('marks unsupported raw values incomplete and never treats them as coverage proof', async () => {
    const page = Object.assign(new EventEmitter(), { waitForTimeout: vi.fn(async () => {}) });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const data: Record<string | symbol, unknown> = { documentFileName: 'voucher.pdf', documentcode: 'NAVA123', cyclic };
    const getter = vi.fn(() => { throw new Error('must not invoke'); });
    Object.defineProperty(data, 'unreadable', { get: getter, enumerable: true });
    data[Symbol('native')] = 'not-serializable';
    const child = { isLeaf: () => true, data };
    const root = { isLoaded: () => true, cascadeBy: (visit: (node: unknown) => void) => {
      visit({ isLeaf: () => false, isLoaded: () => true }); visit(child);
    } };
    const store = { getRootNode: () => root, isLoading: () => false };
    vi.stubGlobal('Ext', { ComponentQuery: { query: () => [{ isVisible: () => true, getStore: () => store }] } });
    try {
      const target = Object.assign(frame(), { waitForFunction: vi.fn(async () => {}),
        evaluate: async (read: () => unknown) => read() });
      mocks.open.mockResolvedValue({ frame: target, notes: [] });
      mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
      const result = await readDocumentsFromStay360(page, confirmation);
      expect(getter).not.toHaveBeenCalled();
      expect(result.documents[0].documentId).toBeNull();
      expect(result.observedNodes[1].data.fields).toContainEqual({ key: 'unreadable',
        value: { type: 'unsupported', reason: 'accessor' } });
      expect(result.coverage.metadataIssues).toBeGreaterThanOrEqual(3);
      expect(result.coverage).toMatchObject({ status: 'partial', metadataCapture: 'partial',
        refreshVerified: false, complete: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it('marks bounded metadata capture as partial rather than silently dropping data', async () => {
    const page = Object.assign(new EventEmitter(), { waitForTimeout: vi.fn(async () => {}) });
    const nested: Record<string, unknown> = {}; let cursor = nested;
    for (let index = 0; index < 14; index++) { const next = {}; cursor.next = next; cursor = next; }
    const child = { isLeaf: () => true, data: { documentFileName: 'voucher.pdf', documentcode: 'NAVA123',
      nested, oversized: 'x'.repeat(2_000_001) } };
    const root = { isLoaded: () => true, cascadeBy: (visit: (node: unknown) => void) => {
      visit({ isLeaf: () => false, isLoaded: () => true }); visit(child);
    } };
    const store = { getRootNode: () => root, isLoading: () => false };
    vi.stubGlobal('Ext', { ComponentQuery: { query: () => [{ isVisible: () => true, getStore: () => store }] } });
    try {
      const target = Object.assign(frame(), { waitForFunction: vi.fn(async () => {}),
        evaluate: async (read: () => unknown) => read() });
      mocks.open.mockResolvedValue({ frame: target, notes: [] });
      mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
      const result = await readDocumentsFromStay360(page, confirmation);
      expect(result.coverage.metadataIssues).toBeGreaterThanOrEqual(2);
      expect(result.coverage).toMatchObject({ status: 'partial', metadataCapture: 'partial',
        refreshVerified: false, complete: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it('bounds unsupported symbol keys as well as captured values', async () => {
    const page = Object.assign(new EventEmitter(), { waitForTimeout: vi.fn(async () => {}) });
    const data: Record<string | symbol, unknown> = { documentFileName: 'voucher.pdf' };
    for (let index = 0; index < 20_005; index++) data[Symbol()] = index;
    const child = { isLeaf: () => true, data };
    const root = { isLoaded: () => true, cascadeBy: (visit: (node: unknown) => void) => {
      visit({ isLeaf: () => false, isLoaded: () => true }); visit(child);
    } };
    const store = { getRootNode: () => root, isLoading: () => false };
    vi.stubGlobal('Ext', { ComponentQuery: { query: () => [{ isVisible: () => true, getStore: () => store }] } });
    try {
      const target = Object.assign(frame(), { waitForFunction: vi.fn(async () => {}),
        evaluate: async (read: () => unknown) => read() });
      mocks.open.mockResolvedValue({ frame: target, notes: [] });
      mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
      const result = await readDocumentsFromStay360(page, confirmation);
      const fields = result.observedNodes[1].data.fields;
      expect(fields.length).toBeLessThanOrEqual(20_001);
      expect(fields).toContainEqual({ key: null, value: { type: 'unsupported', reason: 'capture_limit' } });
      expect(result.coverage).toMatchObject({ status: 'partial', metadataCapture: 'partial',
        refreshVerified: false, complete: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it('removes listeners if navigation fails', async () => {
    const page = new EventEmitter();
    mocks.open.mockRejectedValueOnce(new Error('navigation failed'));
    await expect(readDocumentsFromStay360(page, confirmation, { identity: identity() })).rejects.toThrow('navigation failed');
    expect(page.listenerCount('request')).toBe(0);
  });
});

// A loopback-only Playwright check verifies frame serialization, not HMS freshness.
const chromiumBinary = [
  process.env.HMS_TEST_CHROMIUM_PATH,
  chromium.executablePath(),
  '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate));

it.skipIf(!chromiumBinary)('serializes raw metadata through a real browser frame', async () => {
  const browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>Synthetic documents</title>');
    await page.evaluate(() => {
      const child = { isLeaf: () => true, data: { documentFileName: 'voucher.pdf', description: '  ',
        absentValue: undefined, nil: null, nested: { extra: '' } } };
      const root = { isLoaded: () => true, cascadeBy: (visit: (node: unknown) => void) => {
        visit({ isLeaf: () => false, isLoaded: () => true }); visit(child);
      } };
      const store = { getRootNode: () => root, isLoading: () => false };
      (globalThis as any).Ext = { ComponentQuery: { query: () => [{ isVisible: () => true, getStore: () => store }] } };
    });
    mocks.open.mockResolvedValue({ frame: page, notes: [] });
    mocks.dismiss.mockResolvedValue([]); mocks.notes.mockResolvedValue([]);
    const result = await readDocumentsFromStay360(page, confirmation);
    expect(result.observedNodes[1].data.fields).toEqual(expect.arrayContaining([
      { key: 'description', value: { type: 'string', value: '  ' } },
      { key: 'absentValue', value: { type: 'undefined' } },
      { key: 'nil', value: { type: 'null' } },
    ]));
    expect(result.coverage).toMatchObject({ metadataCapture: 'captured', refreshVerified: false, complete: null });
  } finally { await browser.close(); }
}, 20_000);
