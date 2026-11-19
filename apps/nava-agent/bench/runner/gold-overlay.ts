/** Default gold-v4 overlay loader (routing workflow + measurement patches). Never mutates case.json on disk. */
import {readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import type {CaseCard, GoldField} from '../types.js';

const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

export type GoldV4Entry = {
  workflow?: string;
  old_workflow?: string;
  changed?: boolean;
  skip?: boolean;
  evidence_quote?: string | null;
  gold_patches?: Array<{path: string; expectation: string; basis?: string}>;
};

export type GoldV4Map = Record<string, GoldV4Entry>;

/** Map casesDir → gold-audit set name when gold-v4 is the default. */
export function goldSetFromCasesDir(casesDir: string): 'holdout-fresh' | 'v1' | null {
  const base = basename(casesDir.replace(/\/$/, ''));
  if (base === 'holdout-fresh') return 'holdout-fresh';
  if (base === 'v1') return 'v1';
  return null;
}

export function goldV4Path(setName: 'holdout-fresh' | 'v1'): string {
  return join(DATA_ROOT, 'gold-audit', setName, 'gold-v4.json');
}

export async function loadGoldV4(casesDir: string): Promise<GoldV4Map | null> {
  const setName = goldSetFromCasesDir(casesDir);
  if (!setName) return null;
  if (process.env.NAVA_BENCH_GOLD_OVERLAY === 'off' || process.env.NAVA_BENCH_GOLD_OVERLAY === '0') {
    return null;
  }
  try {
    const raw = await readFile(goldV4Path(setName), 'utf8');
    return JSON.parse(raw) as GoldV4Map;
  } catch {
    return null;
  }
}

export function applyGoldV4(card: CaseCard, overlay: GoldV4Entry | undefined): CaseCard {
  if (!overlay) return card;
  let next: CaseCard = overlay.workflow
    ? {...card, workflow: overlay.workflow as CaseCard['workflow']}
    : {...card};
  const patches = overlay.gold_patches ?? [];
  if (patches.length && Array.isArray(next.gold)) {
    const byPath = new Map(patches.map(p => [p.path, p]));
    next = {
      ...next,
      gold: next.gold.map(g => {
        const patch = byPath.get(g.path);
        if (!patch) return g;
        return {
          ...g,
          expectation: patch.expectation as GoldField['expectation'],
          basis: patch.basis ?? g.basis,
        };
      }),
    };
  }
  return next;
}
