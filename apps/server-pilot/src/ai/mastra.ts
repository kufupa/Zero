import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { mailTriageWorkflow } from './workflows/mail-triage.js';

export function createMastraRuntime(storagePath = './data/mastra/runtime.db') {
  mkdirSync(dirname(storagePath), { recursive: true });
  const storage = new LibSQLStore({
    id: 'server-pilot-ai',
    url: `file:${storagePath}`,
  });

  return new Mastra({
    workflows: {
      mailTriage: mailTriageWorkflow,
    },
    storage,
  });
}

export type MastraRuntime = ReturnType<typeof createMastraRuntime>;
