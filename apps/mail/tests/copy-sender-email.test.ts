import { afterEach, describe, expect, it, vi } from 'vitest';
import { copySenderEmail } from '../lib/mail/copy-sender-email';

describe('copySenderEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns empty when email is blank', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copySenderEmail('')).resolves.toBe('empty');
    await expect(copySenderEmail('   ')).resolves.toBe('empty');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns copied when clipboard write succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copySenderEmail('aurora@example.com')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('aurora@example.com');
  });

  it('returns failed when clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copySenderEmail('aurora@example.com')).resolves.toBe('failed');
  });
});
