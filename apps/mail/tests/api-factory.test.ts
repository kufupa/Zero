import { describe, expect, it } from 'vitest';
import { createDemoLocalAdapter, createHostedHttpAdapter } from '../lib/api/factory';

describe('frontend api factory helpers', () => {
  it('demo adapter lists threads', async () => {
    const api = createDemoLocalAdapter();
    const res = await api.mail.listThreads({ folder: 'inbox', maxResults: 50 });
    expect(res.threads.length).toBeGreaterThan(0);
    expect(api.capabilities.mode).toBe('demo');
  });

  it('hosted adapter rejects reads', async () => {
    const api = createHostedHttpAdapter();
    await expect(api.settings.get()).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  });
});
