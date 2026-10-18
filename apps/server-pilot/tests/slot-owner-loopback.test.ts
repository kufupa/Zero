import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attachSlotOwnerSignals,
  parseSlotOwnerConfig,
  resetSlotOwner,
  writeSlotPhase,
} from '../tooling/playwright-quote/slot-owner.mjs';
import { describe, expect, it } from 'vitest';

const unitPath = fileURLToPath(
  new URL('../deploy/hms-slot@.service', import.meta.url),
);

describe('parseSlotOwnerConfig', () => {
  it('refuses a non-loopback debug address', () => {
    expect(() =>
      parseSlotOwnerConfig({
        HMS_SLOT_PROFILE_DIR: '/tmp/slot-a',
        HMS_SLOT_CDP_PORT: '19223',
        HMS_SLOT_DEBUG_ADDRESS: '10.0.0.5',
      }),
    ).toThrow(/SLOT_DEBUG_ADDRESS_NOT_LOOPBACK/);
  });

  it('accepts two instances with distinct profile dirs and port names', () => {
    const hrcen = parseSlotOwnerConfig({
      HMS_SLOT_PROFILE_DIR: '/var/lib/nava/hms-slot/hrcen/profile',
      HMS_SLOT_CDP_PORT: '19223',
      HMS_SLOT_DEBUG_ADDRESS: '127.0.0.1',
    });
    const hrdav = parseSlotOwnerConfig({
      HMS_SLOT_PROFILE_DIR: '/var/lib/nava/hms-slot/hrdav/profile',
      HMS_SLOT_CDP_PORT: '19225',
      HMS_SLOT_DEBUG_ADDRESS: '127.0.0.1',
    });
    expect(hrcen.profileDir).not.toBe(hrdav.profileDir);
    expect(hrcen.cdpPort).not.toBe(hrdav.cdpPort);
    expect(hrcen.debugAddress).toBe('127.0.0.1');
  });
});

describe('slot owner recover/reset/signals', () => {
  it('reset deletes the profile directory then recovers', async () => {
    const seen: string[] = [];
    await resetSlotOwner({
      wipeProfile: async () => {
        seen.push('wipe');
      },
      recover: async () => {
        seen.push('recover');
      },
    });
    expect(seen).toEqual(['wipe', 'recover']);
  });

  it('SIGTERM writes down and closes the fake listener', async () => {
    const written: Array<{ phase: string }> = [];
    let listening = true;
    const processLike = {
      once(signal: string, handler: () => void) {
        if (signal === 'SIGTERM') handler();
      },
    };
    await attachSlotOwnerSignals(processLike, {
      writePhase: async (phase) => {
        written.push({ phase });
      },
      close: async () => {
        listening = false;
      },
    });
    expect(written.map((row) => row.phase)).toContain('down');
    expect(listening).toBe(false);
  });
});

describe('hms-slot@.service', () => {
  it('restarts on failure and uses instance %i with User=ubuntu', () => {
    const unit = readFileSync(unitPath, 'utf8');
    expect(unit).toMatch(/Restart=on-failure/);
    expect(unit).toMatch(/%i/);
    expect(unit).toMatch(/User=ubuntu/);
    expect(unit).toMatch(/hms-slot/);
    expect(unit).not.toMatch(/stagehand-trial/);
  });
});

describe('writeSlotPhase', () => {
  it('records ready recovering and down without a browser', async () => {
    const files = new Map<string, string>();
    const fsLike = {
      writeFile: async (path: string, contents: string) => {
        files.set(path, contents);
      },
    };
    await writeSlotPhase(fsLike, '/tmp/phase.json', 'ready');
    await writeSlotPhase(fsLike, '/tmp/phase.json', 'recovering');
    await writeSlotPhase(fsLike, '/tmp/phase.json', 'down');
    expect(JSON.parse(files.get('/tmp/phase.json') ?? '{}').phase).toBe('down');
  });
});
