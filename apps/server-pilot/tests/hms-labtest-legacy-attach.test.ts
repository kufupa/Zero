import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), execFile: calls.execFile,
}));

import { spawnAttachDocument } from '../src/ai/pane-hms-write.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';

const request = { confirmation: '123-1', arrival: '2027-10-12', file: '/tmp/synthetic.pdf', documentName: 'synthetic.pdf' };
afterEach(() => calls.execFile.mockReset());

it('refuses the HRCEN legacy entry point before spawning an ops upload', async () => {
  for (const propertyCode of ['HRCEN', 'hrcen', ' HRCEN ']) {
    const result = await spawnAttachDocument({ ...request, target: { ...CENTURION_HMS_READ_TARGET, propertyCode } });
    expect(result).toEqual({ outcome: 'refused_cloud_upload_unavailable', uploadSent: false, screenshots: [] });
  }
  expect(calls.execFile).not.toHaveBeenCalled();
});

it('keeps the existing non-HRCEN legacy target path', async () => {
  calls.execFile.mockImplementation((_exe: string, args: string[], _options: unknown, done: (error: null) => void) => {
    const dir = args[args.indexOf('--out') + 1]!;
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ outcome: 'refused', uploadSent: false, screenshots: [] }));
    done(null);
  });
  const result = await spawnAttachDocument({ ...request, target: DAVINCI_HMS_READ_TARGET });
  try {
    expect(result.outcome).toBe('refused'); expect(calls.execFile).toHaveBeenCalledOnce();
    const args = calls.execFile.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--property') + 1]).toBe('HRDAV');
  } finally { if (result.runDir) await rm(result.runDir, { recursive: true, force: true }); }
});
