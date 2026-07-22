import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCliEntry } from '../src/lib/is-cli-entry.js';

describe('isCliEntry', () => {
  it('matches direct node argv path', () => {
    const file = path.resolve('apps/server-pilot/src/lib/is-cli-entry.ts');
    const meta = pathToFileURL(file).href;
    const prev = process.argv[1];
    process.argv[1] = file;
    try {
      expect(isCliEntry(meta)).toBe(true);
    } finally {
      process.argv[1] = prev;
    }
  });

  it('matches PM2 ProcessContainerFork via name + pm_id', () => {
    const file = path.resolve('apps/server-pilot/dist/mail/ingest/worker.js');
    const meta = pathToFileURL(file).href;
    const prevArgv = process.argv[1];
    const prevId = process.env.pm_id;
    const prevName = process.env.name;
    process.argv[1] =
      '/home/ubuntu/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/lib/ProcessContainerFork.js';
    process.env.pm_id = '0';
    process.env.name = 'worker';
    try {
      expect(isCliEntry(meta, 'worker')).toBe(true);
      expect(isCliEntry(meta, 'ai-worker')).toBe(false);
    } finally {
      process.argv[1] = prevArgv;
      if (prevId === undefined) delete process.env.pm_id;
      else process.env.pm_id = prevId;
      if (prevName === undefined) delete process.env.name;
      else process.env.name = prevName;
    }
  });
});
