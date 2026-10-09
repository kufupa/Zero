import {
  ANALYSIS_PROCEDURES,
  KNOWN_WRITE_PROCEDURES,
  READ_PROCEDURES,
} from '../scripts/nava-preview-run';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { appRouter } from '../src/trpc/router';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keeps the viewer's read allowlist honest. Every name is checked against the real server
 * router (queries are queries, writes are mutations), and every procedure the viewer's
 * client code can reach must be classified. A new procedure in the pane fails here until
 * someone decides whether it is a read or a write.
 */

const here = dirname(fileURLToPath(import.meta.url));
const mailRoot = join(here, '..', '..', 'mail');

/** Client code the viewer can reach: the pane and its panels, the thread and connection hooks, the viewer route. */
const VIEWER_SOURCES = [
  'components/nava-pane',
  'components/quote-workflow',
  'components/workstation',
  'lib/quote-workflow',
  'lib/workstation',
  'app/(routes)/nava-preview',
  'app/(routes)/outlook-pane',
  'hooks/use-threads.ts',
  'hooks/use-connections.ts',
  'providers',
  // App shell the (routes) layout mounts on every page, the viewer included: the hotkey
  // providers and the settings, labels and categories hooks they read.
  'app/(routes)/layout.tsx',
  'hooks/use-settings.ts',
  'hooks/use-labels.ts',
  'hooks/use-categories.ts',
  'lib/hotkeys',
];

const procedureTypes = new Map<string, string>(
  Object.entries(appRouter._def.procedures as Record<string, { _def: { type: string } }>).map(
    ([name, procedure]) => [name, procedure._def.type],
  ),
);

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) {
    return /\.(ts|tsx)$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  }
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

function referencedProcedures(): Set<string> {
  const found = new Set<string>();
  for (const root of VIEWER_SOURCES) {
    for (const file of sourceFiles(join(mailRoot, root))) {
      // Optional chaining (trpc.x?.y) names the same procedure as trpc.x.y.
      const text = readFileSync(file, 'utf8').replace(/\?\./g, '.');
      for (const name of procedureTypes.keys()) {
        const pattern = new RegExp(
          `(?<![A-Za-z0-9_])${name.replace(/\./g, '\\.')}(?![A-Za-z0-9_])`,
        );
        if (pattern.test(text)) found.add(name);
      }
    }
  }
  return found;
}

const referenced = referencedProcedures();
const classified = [...READ_PROCEDURES, ...ANALYSIS_PROCEDURES, ...KNOWN_WRITE_PROCEDURES];

describe('viewer tRPC classification', () => {
  it('every read is a query on the server router', () => {
    for (const name of READ_PROCEDURES) {
      expect(procedureTypes.get(name), name).toBe('query');
    }
  });

  it('the analysis is the only allowed mutation, and it is a mutation on the router', () => {
    expect([...ANALYSIS_PROCEDURES]).toEqual(['quoteWorkflow.analyseSelection']);
    for (const name of ANALYSIS_PROCEDURES) {
      expect(procedureTypes.get(name), name).toBe('mutation');
    }
  });

  it('every known write is a mutation on the router', () => {
    for (const name of KNOWN_WRITE_PROCEDURES) {
      expect(procedureTypes.get(name), name).toBe('mutation');
    }
  });

  it('every procedure the viewer code references is classified', () => {
    expect([...referenced].filter((name) => !classified.includes(name))).toEqual([]);
  });

  it('no classified name is stale: each one is still referenced by the viewer code', () => {
    expect(classified.filter((name) => !referenced.has(name))).toEqual([]);
  });

  it('the scan sees the core paths, so it cannot pass by finding nothing', () => {
    for (const name of [
      'mail.get',
      'mail.listThreads',
      'brain.getCapabilities',
      'quoteWorkflow.analyseSelection',
    ]) {
      expect(referenced.has(name), name).toBe(true);
    }
  });
});
