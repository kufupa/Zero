import { EventEmitter } from 'node:events';
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

  it('removes listeners if navigation fails', async () => {
    const page = new EventEmitter();
    mocks.open.mockRejectedValueOnce(new Error('navigation failed'));
    await expect(readDocumentsFromStay360(page, confirmation, { identity: identity() })).rejects.toThrow('navigation failed');
    expect(page.listenerCount('request')).toBe(0);
  });
});
