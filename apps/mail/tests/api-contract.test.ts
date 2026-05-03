import { describe, expect, it } from 'vitest';
import { UnsupportedFeatureError } from '../lib/api/errors';
import { createHostedHttpAdapter } from '../lib/api/factory';

describe('frontend api contract', () => {
  it('UnsupportedFeatureError exposes metadata', () => {
    const err = new UnsupportedFeatureError('mail.listThreads', 'hosted');
    expect(err.code).toBe('UNSUPPORTED_FEATURE');
    expect(err.feature).toBe('mail.listThreads');
    expect(err.mode).toBe('hosted');
  });

  it('hosted adapter rejects mail.listThreads', async () => {
    const api = createHostedHttpAdapter();
    await expect(api.mail.listThreads({ folder: 'inbox' })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    try {
      await api.mail.listThreads({});
    } catch (e) {
      expect(e).toMatchObject({
        code: 'UNSUPPORTED_FEATURE',
        feature: 'mail.listThreads',
        mode: 'hosted',
      });
    }
  });
});
