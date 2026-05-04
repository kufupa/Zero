import { describe, expect, it } from 'vitest';
import { apiQueryKeys } from '../lib/api/query-keys';

describe('api query keys', () => {
  it('includes mode, account, domain, and input', () => {
    const key = apiQueryKeys.mail.listThreads('legacy', 'conn-1', { folder: 'inbox' });
    expect(key[0]).toBe('frontendApi');
    expect(key[1]).toBe('legacy');
    expect(key[2]).toBe('conn-1');
    expect(key[3]).toBe('mail');
    expect(key[4]).toBe('listThreads');
    expect(key[5]).toEqual({ folder: 'inbox' });
  });

  it('uses anon placeholder when account is null', () => {
    const key = apiQueryKeys.labels.list('demo', null);
    expect(key[2]).toBe('anon');
  });

  it('keys ai prompts list', () => {
    const key = apiQueryKeys.ai.getPrompts('legacy', null);
    expect(key[3]).toBe('ai');
    expect(key[4]).toBe('getPrompts');
  });

  it('keys mail message attachments', () => {
    const key = apiQueryKeys.mail.messageAttachments('legacy', null, { messageId: 'm1' });
    expect(key[3]).toBe('mail');
    expect(key[4]).toBe('messageAttachments');
    expect(key[5]).toEqual({ messageId: 'm1' });
  });

  it('keys connections getDefault', () => {
    const key = apiQueryKeys.connections.getDefault('legacy', null);
    expect(key[3]).toBe('connections');
    expect(key[4]).toBe('getDefault');
  });

  it('keys templates list', () => {
    const key = apiQueryKeys.templates.list('legacy', null, {});
    expect(key[3]).toBe('templates');
    expect(key[4]).toBe('list');
    expect(key[5]).toEqual({});
  });
});
