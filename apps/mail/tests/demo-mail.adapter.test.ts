import { describe, expect, it } from 'vitest';
import { getDemoThread, listDemoThreads } from '../lib/demo-mail/adapter';
import { isFrontendOnlyDemo } from '../lib/demo-frontonly';
import { getDemoConnection } from '../hooks/use-connections';

describe('demo-mail adapter', () => {
  it('returns inbox threads for default list call', () => {
    const result = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: [],
    });

    expect(result.threads.length).toBeGreaterThan(0);
    expect(result.nextPageToken).toBeNull();
  });

  it('returns empty list for non-inbox folder', () => {
    const result = listDemoThreads({
      folder: 'sent',
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: [],
    });

    expect(result.threads).toEqual([]);
  });

  it('returns thread detail for known id', () => {
    const list = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: [],
    });

    const firstId = list.threads[0]?.id;
    expect(firstId).toBeTruthy();

    const thread = getDemoThread(firstId!);
    expect(thread.latest?.subject).toBeTruthy();
    expect(thread.messages.length).toBeGreaterThan(0);
  });

  it('throws for unknown thread ids', () => {
    expect(() => {
      getDemoThread('does-not-exist');
    }).toThrow('Demo thread not found: does-not-exist');
  });

  it('flags frontend-only demo when both flags are enabled', () => {
    expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '1', VITE_FRONTEND_ONLY: '1' })).toBe(true);
  });

  it('does not flag frontend-only demo when both flags are not enabled', () => {
    expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '1', VITE_FRONTEND_ONLY: '0' })).toBe(false);
    expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '0', VITE_FRONTEND_ONLY: '1' })).toBe(false);
    expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '1' })).toBe(false);
  });

  it('returns demo connection shape', () => {
    const connection = getDemoConnection();
    expect(connection.providerId).toBe('google');
    expect(connection.email).toContain('legacyhotels.com');
  });

  it('paginates threads with cursor offsets', () => {
    const firstPage = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 1,
      labelIds: [],
    });
    expect(firstPage.threads).toHaveLength(1);
    expect(firstPage.nextPageToken).toBe('1');

    const secondPage = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: firstPage.nextPageToken ?? '',
      maxResults: 1,
      labelIds: [],
    });
    expect(secondPage.threads).toHaveLength(1);
    expect(secondPage.threads[0]?.id).not.toBe(firstPage.threads[0]?.id);

    const beyondLast = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '9999',
      maxResults: 1,
      labelIds: [],
    });
    expect(beyondLast.threads).toEqual([]);
    expect(beyondLast.nextPageToken).toBeNull();
  });
});
