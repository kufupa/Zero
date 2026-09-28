import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertLabOverlayBranch,
  assertHotelOutlookSourcePresent,
  assertBuiltSpaKeepsHotelOutlook,
  assertDownloadsPreserved,
  HOTEL_SPA_REQUIRED_MARKERS,
} from '../scripts/lab-spa-overlay-guards.mjs';

const temps: string[] = [];

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-overlay-guards-'));
  temps.push(dir);
  return dir;
}

describe('lab SPA overlay hotel-safety guards', () => {
  it('allows main and outlook download branch only', () => {
    expect(assertLabOverlayBranch('main')).toBe('main');
    expect(assertLabOverlayBranch('feat/outlook-setup-download-button')).toBe(
      'feat/outlook-setup-download-button',
    );
    expect(() => assertLabOverlayBranch('feat/centurion-dashboard-tools')).toThrow(
      /REFUSING_CUTOVER/,
    );
  });

  it('refuses overlay when Outlook setup source is missing from the worktree', () => {
    const root = tempDir();
    expect(() => assertHotelOutlookSourcePresent(root)).toThrow(/REFUSING_OVERLAY: missing/);
  });

  it('refuses a built SPA that dropped the Outlook download button', () => {
    const client = tempDir();
    const assets = join(client, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'page-lab-only.js'), 'centurion-eval-lab only');
    expect(() => assertBuiltSpaKeepsHotelOutlook(client)).toThrow(/missing hotel Outlook markers/);
  });

  it('accepts a built SPA that keeps Outlook download markers', () => {
    const client = tempDir();
    const assets = join(client, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(
      join(assets, 'page-catchup.js'),
      HOTEL_SPA_REQUIRED_MARKERS.join(' ') + ' other spa bits',
    );
    const result = assertBuiltSpaKeepsHotelOutlook(client);
    expect(result.filesChecked).toBe(1);
  });

  it('requires downloads exe when asked after a prior live installer', () => {
    const web = tempDir();
    expect(assertDownloadsPreserved(web)).toEqual({ present: false, exePresent: false });
    expect(() => assertDownloadsPreserved(web, { required: true })).toThrow(/missing/);

    const downloads = join(web, 'downloads');
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, 'NavaOutlookSetup.exe'), 'fake');
    expect(assertDownloadsPreserved(web, { required: true })).toEqual({
      present: true,
      exePresent: true,
    });
  });

  it('overlay script wires preflight, downloads exclude, and postflight rollback', () => {
    const script = readFileSync(
      new URL('../scripts/overlay-centurion-lab-spa.sh', import.meta.url),
      'utf8',
    );
    expect(script).toContain('lab-spa-overlay-guards.mjs');
    expect(script).toContain('preflight');
    expect(script).toContain("postflight-spa");
    expect(script).toContain("--exclude='downloads'");
    expect(script).toContain('OVERLAY_POSTFLIGHT_FAILED');
    expect(script).toContain('assert-branch');
  });
});
