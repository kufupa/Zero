import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoMailListDraftsQueryKey } from '../lib/demo/demo-mail-query-keys';
import { listDemoDrafts, resetDemoStoreForTests } from '../lib/demo/local-store';

vi.mock('../lib/demo/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/demo/runtime')>();
  return {
    ...actual,
    isFrontendOnlyDemo: () => true,
  };
});

beforeEach(() => {
  resetDemoStoreForTests();
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
});

describe('demo draft seed + query key', () => {
  it('seeds drafts when store empty so Drafts folder can list rows', () => {
    const drafts = listDemoDrafts();

    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.some((d) => d.id === 'sa-002-msg-02')).toBe(true);
    expect(drafts.some((d) => d.id === 'sa-006-msg-02')).toBe(true);
  });

  it('uses stable react-query key prefix for draft list invalidation', () => {
    expect(demoMailListDraftsQueryKey('')).toEqual(['demo', 'mail', 'listDrafts', '']);
    expect(demoMailListDraftsQueryKey('tax')).toEqual(['demo', 'mail', 'listDrafts', 'tax']);
  });
});
