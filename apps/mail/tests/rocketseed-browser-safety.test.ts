import {
  MAIL_MESSAGE_ROOT_SELECTOR,
  blockedHarnessRequestReason,
  requireLoopbackBaseUrl,
} from './e2e/helpers/rocketseed-safety';
import { describe, expect, it } from 'vitest';

describe('Rocketseed browser harness safety', () => {
  it.each([
    'http://127.0.0.1:3000/mail',
    'https://localhost/api/auth/session',
    'http://[::1]:8787/api/mail',
    'data:image/png;base64,AA==',
    'blob:http://127.0.0.1:3000/synthetic-object',
  ])('allows loopback or non-network URL %s', (url) => {
    expect(blockedHarnessRequestReason({ url, method: 'GET' })).toBeNull();
  });

  it.each([
    ['https://mail.example.invalid/api/auth/session', 'non-loopback-http'],
    ['http://10.0.0.8/api/mail', 'non-loopback-http'],
    ['cid:image-banner@localhost', 'unsupported-scheme'],
    ['file:///tmp/synthetic', 'unsupported-scheme'],
  ] as const)('blocks forbidden URL %s', (url, reason) => {
    expect(blockedHarnessRequestReason({ url, method: 'GET' })).toBe(reason);
  });

  it('blocks mail.send even on loopback', () => {
    expect(
      blockedHarnessRequestReason({
        url: 'http://127.0.0.1:3000/api/trpc/mail.send',
        method: 'POST',
        postData: '{"mail.send":{"subject":"synthetic"}}',
      }),
    ).toBe('mail-send');
  });

  it('requires a loopback HTTP(S) base URL', () => {
    expect(requireLoopbackBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(() => requireLoopbackBaseUrl('https://mail.example.invalid')).toThrow(
      /refuses non-loopback baseURL/,
    );
    expect(() => requireLoopbackBaseUrl('data:text/html,synthetic')).toThrow(
      /requires HTTP\(S\) baseURL/,
    );
  });

  it('scopes duplicate counting to semantic MailDisplay roots', () => {
    expect(MAIL_MESSAGE_ROOT_SELECTOR).toBe('#mail-thread-panel [data-mail-message-id]');
  });
});
