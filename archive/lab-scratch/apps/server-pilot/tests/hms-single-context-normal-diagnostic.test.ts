import {
  diagnosticKeysHash,
  diagnosticFieldHashes,
  diagnosticMode,
  diagnosticSessionInput,
  sanitizeDiagnosticResponse,
  diagnosticLocaleBootstrap,
} from '../scripts/hms-single-context-normal-diagnostic.js';
import { describe, expect, it } from 'vitest';

describe('single-context normal diagnostic helpers', () => {
  it('reports locale bootstrap structure without cookie or form values', () => {
    const html =
      '<html><script>function loadLocalizedPage(allcookies){document.cookie; document.langform.submit()}</script><form name="langform" method="post" action="/web/base/OSRESV.HDR?secret=do-not-retain"><input name="ewslanguage" value="do-not-retain"><input name="tenant" value="do-not-retain"></form></html>';
    const result = diagnosticLocaleBootstrap(html);
    expect(result).toEqual({
      recognized: true,
      actionPath: '/web/base/OSRESV.HDR',
      method: 'POST',
      readsCookie: true,
      submitsForm: true,
    });
    expect(JSON.stringify(result)).not.toContain('do-not-retain');
    expect(diagnosticLocaleBootstrap('<html>plain</html>').recognized).toBe(false);
  });
  it('defaults to one-session mode and admits only the explicit split probe', () => {
    expect(diagnosticMode(undefined)).toBe('single');
    expect(diagnosticMode('single')).toBe('single');
    expect(diagnosticMode('after_find')).toBe('after_find');
    expect(() => diagnosticMode('unexpected')).toThrow('DIAGNOSTIC_MODE_INVALID');
  });

  it('hashes sorted key names without retaining their order as evidence', () => {
    expect(diagnosticKeysHash(['b', 'a'])).toBe(diagnosticKeysHash(['a', 'b']));
    expect(diagnosticKeysHash(['a'])).not.toBe(diagnosticKeysHash(['b']));
  });

  it('does not pass a candidate that could replace the exact detail manifest', () => {
    const input = diagnosticSessionInput(
      {
        mailboxTransportId: 'transport',
        username: 'u',
        password: 'p',
        loginUrl: 'https://example.test',
        expectedTenant: 't',
        expectedPropertyCode: 'HRCEN',
        expectedPropertyName: 'n',
        credentialMode: 'view_only',
      },
      new AbortController().signal,
    );
    expect('exactSearchCandidate' in input).toBe(false);
  });

  it('hashes request fields without retaining their values', () => {
    const first = diagnosticFieldHashes({ b: 'private-two', a: 'private-one' });
    const second = diagnosticFieldHashes({ a: 'private-one', b: 'private-two' });

    expect(first).toEqual(second);
    expect(first.names).toEqual(['a', 'b']);
    expect(JSON.stringify(first)).not.toContain('private-one');
    expect(JSON.stringify(first)).not.toContain('private-two');
  });

  it('retains only a bounded safe response and redacts known secret values', () => {
    const capture = sanitizeDiagnosticResponse('confirmation=1234567890&user=private-user', {
      username: 'private-user',
      password: 'private-password',
    });

    expect(capture.retention).toBe('captured');
    expect(capture.bytes).toBeGreaterThan(0);
    expect(capture.body).toContain('[redacted-secret]');
    expect(capture.body).not.toContain('private-user');
  });

  it.each([
    ['password=private-password', 'sensitive_marker'],
    ['cardnumber=4111111111111111', 'sensitive_marker'],
    ['x'.repeat(4097), 'size_limit'],
  ])('keeps unsafe or oversized response metadata-only: %s', (body, reason) => {
    const capture = sanitizeDiagnosticResponse(body, {
      username: 'private-user',
      password: 'private-password',
    });

    expect(capture.retention).toBe('metadata_only');
    expect(capture.body).toBeNull();
    expect(capture.reason).toBe(reason);
  });

  it('keeps only structural keys and redacted error fields for marked JSON', () => {
    const capture = sanitizeDiagnosticResponse(
      JSON.stringify({
        success: false,
        error: 'Re-authentication required',
        message: 'The read session expired',
        token: 'private-token',
        nested: { secret: { value: 'private-secret', message: 'must not leak' } },
        access_token: 'private-access-token',
        sessionId: 'private-session-id',
        csrftckt: 'private-csrf',
      }),
      { username: 'private-user', password: 'private-password' },
    );

    expect(capture.retention).toBe('metadata_only');
    expect(capture.structure.format).toBe('json');
    expect(capture.structure.keys).toEqual(
      expect.arrayContaining(['error', 'message', 'nested', 'secret', 'success', 'token']),
    );
    expect(capture.structure.markerNames).toEqual(
      expect.arrayContaining(['access_token', 'csrf', 'secret', 'session', 'token']),
    );
    expect(capture.structure.messages).toEqual(
      expect.arrayContaining(['Re-authentication required', 'The read session expired']),
    );
    const serialized = JSON.stringify(capture.structure);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('must not leak');
    expect(serialized).not.toContain('private-access-token');
    expect(serialized).not.toContain('private-session-id');
    expect(serialized).not.toContain('private-csrf');
  });

  it('extracts bounded visible error text and structural names from marked HTML', () => {
    const capture = sanitizeDiagnosticResponse(
      '<html><body><h1 class="error">Timed out</h1><input name="status" value="private-value"><input name="token" value="private-token"></body></html>',
      { username: 'private-user', password: 'private-password' },
    );

    expect(capture.retention).toBe('metadata_only');
    expect(capture.structure.format).toBe('html');
    expect(capture.structure.keys).toEqual(expect.arrayContaining(['status', 'token']));
    expect(capture.structure.messages).toContain('Timed out');
    expect(JSON.stringify(capture.structure)).not.toContain('private-value');
    expect(JSON.stringify(capture.structure)).not.toContain('private-token');
  });

  it('does not retain raw composite token fields', () => {
    const capture = sanitizeDiagnosticResponse(
      JSON.stringify({ token1: 'opaque-private', message: 'Request rejected' }),
      { username: 'private-user', password: 'private-password' },
    );
    expect(capture.retention).toBe('metadata_only');
    expect(capture.body).toBeNull();
    expect(capture.structure.messages).toContain('Request rejected');
    expect(JSON.stringify(capture.structure)).not.toContain('opaque-private');
  });
});
