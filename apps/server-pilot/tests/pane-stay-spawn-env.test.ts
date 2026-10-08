import type { StaffQuoteInstallationConfiguration } from '../src/ai/staff-quote-installation.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from '../src/ai/pane-stay-spawn-env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const configuration = {
  tenantId: 'tenant-1',
  owner: {
    cdpUrl: 'http://127.0.0.1:19223',
    browserOwnership: 'borrowed',
    propertyCode: 'HRCEN',
    secretPath: '/repo/.private/owner/secret.json',
  },
  outputDir: '/repo/.private/playwright-quote/out',
  ratePolicyConfigurationPath: '/repo/.private/rate-policy.json',
} as StaffQuoteInstallationConfiguration;

afterEach(() => vi.restoreAllMocks());

describe('paneStaySpawnEnv', () => {
  it('passes the installed borrowed browser and credential file, like the staff quote spawner', () => {
    const env = paneStaySpawnEnv(
      { PATH: '/usr/bin', HMS_READ_SECRET_ARN: 'arn' },
      () => configuration,
    );
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HMS_READ_SECRET_ARN: 'arn',
      HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
      HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
      HMS_QUOTE_SECRET_PATH: '/repo/.private/owner/secret.json',
    });
  });

  it('keeps a browser already set in the environment', () => {
    const read = vi.fn(() => configuration);
    const env = paneStaySpawnEnv(
      {
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
      },
      read,
    );
    expect(env.HMS_STAGEHAND_CDP_URL).toBe('http://127.0.0.1:9222');
    expect(env.HMS_QUOTE_SECRET_PATH).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves the environment alone when no installation is configured', () => {
    const env = paneStaySpawnEnv({ PATH: '/usr/bin' }, () => {
      throw new Error('staff_quote_installation_unavailable');
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('warnPaneStaySpawnFailed', () => {
  it('logs the code and a short message without the command line or confirmation numbers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = Object.assign(
      new Error(
        'Command failed: node stay-lookup.mjs --last-name Smith --confirmation 61143613-1\nCDP_URL_REQUIRED for 61143613-1',
      ),
      { code: 1 },
    );
    warnPaneStaySpawnFailed('find', error);
    expect(warn).toHaveBeenCalledWith('pane_stay_spawn_failed', {
      mode: 'find',
      code: 1,
      msg: 'CDP_URL_REQUIRED for <n>',
    });
  });

  it('falls back to the error name and caps the message at 120 characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnPaneStaySpawnFailed('save', new TypeError('x'.repeat(300)));
    const [, payload] = warn.mock.calls[0] as [string, { code: unknown; msg: string }];
    expect(payload.code).toBe('TypeError');
    expect(payload.msg).toHaveLength(120);
  });
});
