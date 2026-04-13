import { beforeEach, describe, expect, it } from 'vitest';
import { demoMailListDraftsQueryKey } from '../lib/demo/demo-mail-query-keys';
import { listDemoDrafts, resetDemoStoreForTests } from '../lib/demo/local-store';

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
    expect(drafts.some((d) => d.id === 'draft-demo-kleinkaap')).toBe(true);
    expect(drafts.some((d) => d.id === 'draft-demo-morake')).toBe(true);
  });

  it('uses stable react-query key prefix for draft list invalidation', () => {
    expect(demoMailListDraftsQueryKey('')).toEqual(['demo', 'mail', 'listDrafts', '']);
    expect(demoMailListDraftsQueryKey('tax')).toEqual(['demo', 'mail', 'listDrafts', 'tax']);
  });
});
