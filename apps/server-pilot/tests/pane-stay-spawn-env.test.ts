import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StaffQuoteInstallationConfiguration } from '../src/ai/staff-quote-installation.js';
import {
  PANE_CLI_ENV_ALLOWLIST,
  paneStaySpawnEnv,
  warnPaneStaySpawnFailed,
} from '../src/ai/pane-stay-spawn-env.js';
import { DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
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
      { PATH: '/usr/bin', HMS_READ_SECRET_ARN: 'arn', RESERVATIONIST_PANE_SAVE: 'lab' },
      () => configuration,
    );
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HMS_READ_SECRET_ARN: 'arn',
      RESERVATIONIST_PANE_SAVE: 'lab',
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

  it('drops every variable outside the allowlist, including the lab cancel flag and the database URL', () => {
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        LAB_CANCEL_CONFIRMATION: '61143613-1',
        DATABASE_URL: 'postgres://zero:secret@db.internal:5432/zero',
        OPENAI_API_KEY: 'sk-test',
      },
      () => configuration,
    );
    expect(env).not.toHaveProperty('LAB_CANCEL_CONFIRMATION');
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(Object.keys(env).sort()).toEqual([
      'HMS_QUOTE_SECRET_PATH',
      'HMS_STAGEHAND_BROWSER_OWNERSHIP',
      'HMS_STAGEHAND_CDP_URL',
      'PATH',
    ]);
  });

  it('passes only the shared save gate, not ad-hoc lab or cancel flags', () => {
    expect(PANE_CLI_ENV_ALLOWLIST).toContain('RESERVATIONIST_PANE_SAVE');
    expect(PANE_CLI_ENV_ALLOWLIST).not.toContain('LAB_CANCEL_CONFIRMATION');
    expect(
      PANE_CLI_ENV_ALLOWLIST.filter(
        (name) => /CANCEL|CONFIRM|LAB|DATABASE/.test(name) && !name.startsWith('PANE_WRITE_'),
      ),
    ).toEqual([]);
  });

  it('forwards all five PANE_WRITE_* flags to HRCEN and strips them for HRDAV', () => {
    const PANE_WRITE_ENV_NAMES = [
      'PANE_WRITE_CREATE',
      'PANE_WRITE_AMEND_UNPAID',
      'PANE_WRITE_AMEND_PAID',
      'PANE_WRITE_CANCEL_UNPAID',
      'PANE_WRITE_CANCEL_PAID',
    ] as const;
    for (const name of PANE_WRITE_ENV_NAMES) {
      expect(PANE_CLI_ENV_ALLOWLIST).toContain(name);
    }
    const flags = Object.fromEntries(PANE_WRITE_ENV_NAMES.map((name) => [name, 'lab']));
    const hrcen = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
        ...flags,
      },
      () => configuration,
    );
    for (const name of PANE_WRITE_ENV_NAMES) {
      expect(hrcen[name]).toBe('lab');
    }
    const hrdav = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        ...flags,
      },
      () => configuration,
      DAVINCI_HMS_READ_TARGET,
    );
    for (const name of PANE_WRITE_ENV_NAMES) {
      expect(hrdav[name]).toBeUndefined();
    }
  });

  it('forwards the slot storageState path so pane CLIs can skip a repeat login', () => {
    expect(PANE_CLI_ENV_ALLOWLIST).toContain('HMS_SLOT_PROFILE_DIR');
    expect(PANE_CLI_ENV_ALLOWLIST).toContain('HMS_SLOT_STORAGE_STATE');
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
        HMS_SLOT_PROFILE_DIR: '/var/lib/nava/hms-slot/hrcen/profile',
      },
      () => configuration,
    );
    expect(env.HMS_SLOT_PROFILE_DIR).toBe('/var/lib/nava/hms-slot/hrcen/profile');
  });

  it('leaves the environment alone when no installation is configured', () => {
    const env = paneStaySpawnEnv({ PATH: '/usr/bin' }, () => {
      throw new Error('staff_quote_installation_unavailable');
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('HRDAV target plus Centurion-only install fails closed before reading that install', () => {
    expect(() =>
      paneStaySpawnEnv(
        {
          PATH: '/usr/bin',
          HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        },
        () => {
          throw new Error('centurion installation must not be read for HRDAV');
        },
        DAVINCI_HMS_READ_TARGET,
      ),
    ).not.toThrow();
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
      },
      () => {
        throw new Error('centurion installation must not be read for HRDAV');
      },
      DAVINCI_HMS_READ_TARGET,
    );
    expect(env.HMS_STAGEHAND_CDP_URL).toBeUndefined();
    expect(env.HMS_READ_SECRET_ARN).toBe('nava-zero/server-pilot/infor-hms-read-davinci');
  });

  it('forwards HMS_DAVINCI_CREATE to HRDAV so the CLI can keep the lab guard', () => {
    expect(PANE_CLI_ENV_ALLOWLIST).toContain('HMS_DAVINCI_CREATE');
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_STAGEHAND_CDP_URL_DAVINCI: 'http://127.0.0.1:19225',
        HMS_DAVINCI_CREATE: 'lab',
      },
      () => configuration,
      DAVINCI_HMS_READ_TARGET,
    );
    expect(env.HMS_DAVINCI_CREATE).toBe('lab');
    expect(env.HMS_STAGEHAND_CDP_URL).toBe('http://127.0.0.1:19225');
  });

  it('Da Vinci never inherits the Centurion slot storageState path', () => {
    const env = paneStaySpawnEnv(
      {
        PATH: '/usr/bin',
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
        HMS_SLOT_PROFILE_DIR: '/var/lib/nava/hms-slot/hrcen/profile',
        HMS_SLOT_STORAGE_STATE: '/var/lib/nava/hms-slot/hrcen/storageState.json',
      },
      () => configuration,
      DAVINCI_HMS_READ_TARGET,
    );
    expect(env.HMS_SLOT_PROFILE_DIR).toBeUndefined();
    expect(env.HMS_SLOT_STORAGE_STATE).toBeUndefined();
  });
});

describe('worker HRCEN hardcode', () => {
  it('read_tool default property remains Centurion on the non-quote/non-folio branch', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/ai/worker.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/: 'HRCEN'/);
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
