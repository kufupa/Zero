import { describe, expect, it } from 'vitest';
import {
  looksLikeUnauthenticatedLoginPage,
  resolveProofLandingUrl,
} from '../src/hms/runtime.js';

describe('looksLikeUnauthenticatedLoginPage', () => {
  it('treats logindisp as login even without password inputs', () => {
    expect(
      looksLikeUnauthenticatedLoginPage(
        'https://hms.example/web/base/logindisp?tenant=THECENTURION_PRD',
        '<html><body>Sign in</body></html>',
      ),
    ).toBe(true);
  });

  it('does not treat COMMON shell with username/password chrome as login', () => {
    const html = `
      <html><body>
        <input name="userid" value="viewonly" />
        <input name="password" type="password" />
        <div>"tenantid":"THECENTURION_PRD","property":"HRCEN"</div>
      </body></html>`;
    expect(
      looksLikeUnauthenticatedLoginPage(
        'https://hms.example/web/base/COMMON?REQ_KEY=abc',
        html,
      ),
    ).toBe(false);
  });

  it('detects fixture /login password form on unknown paths', () => {
    expect(
      looksLikeUnauthenticatedLoginPage(
        'https://fixture.example/login',
        '<label>Password <input aria-label="Password" name="password" type="password" /></label>',
      ),
    ).toBe(true);
  });
});

describe('resolveProofLandingUrl', () => {
  it('maps spent COMMON landing to OSRESV for proof handoff', () => {
    expect(
      resolveProofLandingUrl('https://hms.example/web/base/COMMON?REQ_KEY=spent-token'),
    ).toBe('https://hms.example/web/base/OSRESV');
  });

  it('leaves non-COMMON landings unchanged', () => {
    expect(resolveProofLandingUrl('https://fixture.example/property')).toBe(
      'https://fixture.example/property',
    );
  });
});
