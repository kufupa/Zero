/** Gold overlay loader (v4 patches by default; v5 full gold via BENCH_GOLD=v5). Never mutates case.json on disk. */
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
  gold_patches?: Array<{path: string; expectation: string; basis?: string; value?: unknown}>;
  /** gold-v5: full replacement gold array (provenance-tagged). */
  gold?: GoldField[];
  /** gold-v5 filing: voucher | pop | none (top-level, not inside gold[]). */
  doc_kind?: string;
};

export type GoldV4Map = Record<string, GoldV4Entry>;

export type GoldSetName = 'holdout-fresh' | 'holdout-v2' | 'holdout-v3' | 'v1' | 'dev-fresh' | 'dev-v2';

export type GoldVersion = 'v4' | 'v5';

/** Map casesDir → gold-audit set name when gold overlay is the default. */
export function goldSetFromCasesDir(casesDir: string): GoldSetName | null {
  const base = basename(casesDir.replace(/\/$/, ''));
  if (base === 'holdout-fresh') return 'holdout-fresh';
  if (base === 'holdout-v2') return 'holdout-v2';
  if (base === 'holdout-v3') return 'holdout-v3';
  if (base === 'v1') return 'v1';
  if (base === 'dev-fresh') return 'dev-fresh';
  if (base === 'dev-v2') return 'dev-v2';
  return null;
}

/** Active gold version. Default v4 until orchestrator flips BENCH_GOLD=v5. */
export function activeGoldVersion(): GoldVersion {
  const raw = (process.env.BENCH_GOLD || process.env.NAVA_BENCH_GOLD || 'v4').toLowerCase();
  return raw === 'v5' ? 'v5' : 'v4';
}

export function goldOverlayPath(setName: GoldSetName, version: GoldVersion = activeGoldVersion()): string {
  return join(DATA_ROOT, 'gold-audit', setName, version === 'v5' ? 'gold-v5.json' : 'gold-v4.json');
}

export function goldV4Path(setName: GoldSetName): string {
  return goldOverlayPath(setName, 'v4');
}

export function goldV5Path(setName: GoldSetName): string {
  return goldOverlayPath(setName, 'v5');
}

export async function loadGoldV4(casesDir: string): Promise<GoldV4Map | null> {
  const setName = goldSetFromCasesDir(casesDir);
  if (!setName) return null;
  if (process.env.NAVA_BENCH_GOLD_OVERLAY === 'off' || process.env.NAVA_BENCH_GOLD_OVERLAY === '0') {
    return null;
  }
  const version = activeGoldVersion();
  try {
    const raw = await readFile(goldOverlayPath(setName, version), 'utf8');
    return JSON.parse(raw) as GoldV4Map;
  } catch {
    // v5 requested but missing → do not silently fall back (would mix rulers).
    if (version === 'v5') return null;
    return null;
  }
}

/** Alias for callers that want an explicit name; same as loadGoldV4 (respects BENCH_GOLD). */
export const loadGoldOverlay = loadGoldV4;

export function applyGoldV4(card: CaseCard, overlay: GoldV4Entry | undefined): CaseCard {
  return applyGoldOverlay(card, overlay, activeGoldVersion());
}

/** Apply overlay with an explicit version (for rescore --gold). */
export function applyGoldOverlay(
  card: CaseCard,
  overlay: GoldV4Entry | undefined,
  version: GoldVersion = activeGoldVersion(),
): CaseCard {
  if (!overlay) return card;
  let next: CaseCard = overlay.workflow
    ? {...card, workflow: overlay.workflow as CaseCard['workflow']}
    : {...card};

  // gold-v5: full gold array replaces case gold (provenance-tagged).
  if (version === 'v5' && Array.isArray(overlay.gold)) {
    const withGold: CaseCard = {...next, gold: overlay.gold};
    if (overlay.doc_kind != null) {
      return {...withGold, doc_kind: overlay.doc_kind};
    }
    return withGold;
  }

  const patches = overlay.gold_patches ?? [];
  if (patches.length && Array.isArray(next.gold)) {
    const byPath = new Map(patches.map(p => [p.path, p]));
    next = {
      ...next,
      gold: next.gold.map(g => {
        const patch = byPath.get(g.path);
        if (!patch) return g;
        const patched = {
          ...g,
          expectation: patch.expectation as GoldField['expectation'],
          basis: patch.basis ?? g.basis,
        } as GoldField;
        if (patch.value !== undefined && patch.expectation === 'expected') {
          (patched as {value?: unknown}).value = patch.value;
        }
        return patched;
      }),
    };
  }
  return next;
}
