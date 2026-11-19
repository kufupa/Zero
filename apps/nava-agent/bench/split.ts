/** Stratified 150/50 split by workflow, fixed seed. */
import {createHash} from 'node:crypto';
import type {CaseCard} from './types.js';

export const SPLIT_SEED = 'replay-bench-20261119-v1';
export const DEV_N = 150;
export const HOLDOUT_N = 50;

function hashRank(caseId: string, workflow: string): number {
  const digest = createHash('sha256').update(`${SPLIT_SEED}|${workflow}|${caseId}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/** Assign every case to dev or holdout; stratified by workflow with ~75%/25% per wf. */
export function assignSplit(cards: CaseCard[]): {dev: CaseCard[]; holdout: CaseCard[]; labels: Record<string, 'dev' | 'holdout'>} {
  const byWf = new Map<string, CaseCard[]>();
  for (const card of cards) {
    const list = byWf.get(card.workflow) ?? [];
    list.push(card);
    byWf.set(card.workflow, list);
  }
  const labels: Record<string, 'dev' | 'holdout'> = {};
  const holdout: CaseCard[] = [];
  const dev: CaseCard[] = [];
  for (const [workflow, list] of byWf) {
    const ranked = [...list].sort((a, b) => hashRank(a.case_id, workflow) - hashRank(b.case_id, workflow));
    const nHold = Math.max(1, Math.round(ranked.length * (HOLDOUT_N / (DEV_N + HOLDOUT_N))));
    // Cap so totals land near 50 holdout when summed
    const holdList = ranked.slice(0, nHold);
    const devList = ranked.slice(nHold);
    for (const card of holdList) {
      labels[card.case_id] = 'holdout';
      holdout.push(card);
    }
    for (const card of devList) {
      labels[card.case_id] = 'dev';
      dev.push(card);
    }
  }
  // Rebalance to exactly 50 holdout if over/under
  holdout.sort((a, b) => hashRank(a.case_id, a.workflow) - hashRank(b.case_id, b.workflow));
  while (holdout.length > HOLDOUT_N) {
    const card = holdout.pop()!;
    labels[card.case_id] = 'dev';
    dev.push(card);
  }
  while (holdout.length < HOLDOUT_N && dev.length) {
    // pull from largest workflow surplus in dev
    const counts = new Map<string, number>();
    for (const card of holdout) counts.set(card.workflow, (counts.get(card.workflow) ?? 0) + 1);
    const rankedDev = [...dev].sort((a, b) => {
      const ca = counts.get(a.workflow) ?? 0;
      const cb = counts.get(b.workflow) ?? 0;
      if (ca !== cb) return ca - cb;
      return hashRank(a.case_id, a.workflow) - hashRank(b.case_id, b.workflow);
    });
    const card = rankedDev[0]!;
    const idx = dev.findIndex(c => c.case_id === card.case_id);
    dev.splice(idx, 1);
    labels[card.case_id] = 'holdout';
    holdout.push(card);
  }
  return {dev, holdout, labels};
}
