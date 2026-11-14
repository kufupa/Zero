import {
  PANE_CLI_ENV_ALLOWLIST,
  paneStayHmsTargetForTransport,
  paneStaySpawnEnv,
  warnPaneStaySpawnFailed,
} from '../src/ai/pane-stay-spawn-env.js';
import { quoteRequestFor } from '../src/ai/hms-availability.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('paneStaySpawnEnv', () => {
  it('forwards Cloud credential lease and current credential metadata', () => {
    const env = { PATH: '/usr/bin', DATABASE_URL: 'postgres://localhost/disposable', AWS_REGION: 'af-south-1',
      HMS_EVIDENCE_HMAC_SECRET_ARN: 'test-evidence-ref', HMS_EVIDENCE_HMAC_KEY_VERSION: 'test-version',
      HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRCEN: 'a'.repeat(64), PANE_WRITE_CREATE: 'lab' };
    expect(paneStaySpawnEnv(env, CENTURION_HMS_READ_TARGET)).toEqual(env);
  });
  it('drops borrowed-browser state, credential files and ad hoc write flags for every property', () => {
    for (const target of [CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET]) {
      expect(paneStaySpawnEnv({ PATH: '/usr/bin', HMS_STAGEHAND_CDP_URL: 'http://localhost:9222',
        HMS_STAGEHAND_CDP_URL_DAVINCI: 'http://localhost:9223', HMS_QUOTE_SECRET_PATH: '/private/obsolete.json',
        HMS_SLOT_STORAGE_STATE: '/private/obsolete-state.json', LAB_CANCEL_CONFIRMATION: '12345678-1',
        OPENAI_API_KEY: 'synthetic-unrelated' }, target)).toEqual({ PATH: '/usr/bin' });
    }
  });
  it('retains explicit Da Vinci workflow controls', () => {
    const env = { HMS_DAVINCI_ENABLED_PROPERTIES: 'HRDAV,HRDAVS', HMS_DAVINCI_CREATE: 'lab',
      HMS_DAVINCI_READS: 'on', PANE_WRITE_ATTACH: 'lab' };
    expect(paneStaySpawnEnv(env, DAVINCI_HMS_READ_TARGET)).toEqual(env);
  });
  it('rejects a property target carrying another credential or origin', () => {
    for (const target of [{ ...DAVINCI_HMS_READ_TARGET, secretId: CENTURION_HMS_READ_TARGET.secretId },
      { ...DAVINCI_HMS_READ_TARGET, origin: 'https://foreign.invalid' }]) {
      expect(() => paneStaySpawnEnv({}, target)).toThrow('hms_cloud_target_mismatch');
    }
  });
  it('declares lease configuration while excluding obsolete browser-owner variables', () => {
    expect(PANE_CLI_ENV_ALLOWLIST).toContain('DATABASE_URL');
    expect(PANE_CLI_ENV_ALLOWLIST).not.toContain('HMS_STAGEHAND_CDP_URL');
    expect(PANE_CLI_ENV_ALLOWLIST).not.toContain('LAB_CANCEL_CONFIRMATION');
  });
});

describe('paneStayHmsTargetForTransport', () => {
  it('resolves Da Vinci selection only inside the authenticated mailbox group', () => {
    expect(paneStayHmsTargetForTransport('transport-davinci')).toEqual({ ok: true, target: DAVINCI_HMS_READ_TARGET });
    expect(paneStayHmsTargetForTransport('transport-faith', 'HRDAVS')).toMatchObject({
      ok: true, target: { propertyCode: 'HRDAVS', browserSlot: 'davinci' },
    });
    expect(paneStayHmsTargetForTransport('transport-davinci', 'HRCEN')).toEqual({ ok: false, reason: 'property_mismatch' });
    expect(paneStayHmsTargetForTransport('transport-centurion', 'HRDAV')).toEqual({ ok: false, reason: 'property_mismatch' });
    expect(paneStayHmsTargetForTransport('transport-centurion', 'UNKNOWN')).toEqual({ ok: false, reason: 'property_mismatch' });
  });

  it('maps a Centurion transport to HRCEN', () => {
    expect(paneStayHmsTargetForTransport('transport-centurion')).toEqual({ ok: true, target: CENTURION_HMS_READ_TARGET });
  });

  it('refuses an unknown or blank transport before any spawn', () => {
    expect(paneStayHmsTargetForTransport('transport-unknown')).toEqual({
      ok: false,
      reason: 'unknown_transport',
    });
    expect(paneStayHmsTargetForTransport('')).toEqual({ ok: false, reason: 'unknown_transport' });
    expect(paneStayHmsTargetForTransport(undefined)).toEqual({
      ok: false,
      reason: 'unknown_transport',
    });
  });

  it('does not give the Nava collector an HMS target', () => {
    expect(paneStayHmsTargetForTransport('transport-nava')).toEqual({
      ok: false,
      reason: 'collector_no_hotel',
    });
  });
});

describe('availability quote request property', () => {
  const request = {
    kind: 'availability' as const,
    arrival: '2027-09-14',
    departure: '2027-09-16',
    rooms: [{ roomType: 'STQN', quantity: 1, adults: 1, childAges: [] }],
  };

  it('a DV target writes HRDAV; a Centurion target writes HRCEN', () => {
    expect(quoteRequestFor(request, DAVINCI_HMS_READ_TARGET).propertyCode).toBe('HRDAV');
    expect(quoteRequestFor(request, CENTURION_HMS_READ_TARGET).propertyCode).toBe('HRCEN');
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
