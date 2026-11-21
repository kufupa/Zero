import {readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {CaseCard} from '../types.js';
import {buildScoreboard, gepaFeedback, type CaseScore, type RulerStamp} from './score.js';

export type ReplayOptions = {
  casesDir?: string;
  goldFile?: string;
  gold?: 'v4' | 'v5';
  worldDir?: string;
  skillsDir?: string;
  property?: string;
  model?: string;
  reasoning?: string;
  concurrency?: number;
  limit?: number;
  outDir?: string;
  caseIds?: string[];
};

export function skillsPath(path?: string) {
  return resolve(path ?? process.env.NAVA_SKILLS_DIR ?? fileURLToPath(new URL('../../skills/', import.meta.url)));
}

export async function readOptionalJson(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadCaseCards(casesDir: string, caseIds?: string[]) {
  const requested = caseIds ? new Set(caseIds) : null;
  const entries = (await readdir(casesDir, {withFileTypes: true}))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && (!requested || requested.has(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cards: CaseCard[] = [];
  for (const entry of entries) {
    const card: CaseCard | null = await readOptionalJson(join(casesDir, entry.name, 'case.json'));
    if (card === null) continue;
    if (card.case_id !== entry.name) throw new Error(`Case fixture ID mismatch: ${entry.name}`);
    cards.push(card);
    requested?.delete(entry.name);
  }
  if (requested?.size) throw new Error(`Case fixture missing: ${[...requested].join(', ')}`);
  return cards;
}

export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Positive replay concurrency required');
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  return out;
}

export async function writeBoards(out: string, casesDir: string, scores: CaseScore[], ruler: RulerStamp, wallMs?: number) {
  const board = buildScoreboard(scores);
  board.ruler = ruler;
  if (wallMs !== undefined) board.totals.wall_ms = wallMs;
  const split = basename(casesDir).startsWith('holdout') ? 'holdout' : 'dev';
  const labels = Object.fromEntries(scores.map(score => [score.case_id, split]));
  const devBoard = split === 'dev' ? board : buildScoreboard([]);
  const holdBoard = split === 'holdout' ? board : buildScoreboard([]);
  await Promise.all([
    writeFile(join(out, 'scoreboard.json'), JSON.stringify(board, null, 2)),
    writeFile(join(out, `scoreboard-${split}.json`), JSON.stringify(board, null, 2)),
    writeFile(join(out, 'split.json'), JSON.stringify({labels, n_dev: devBoard.n, n_holdout: holdBoard.n}, null, 2)),
    writeFile(join(out, 'gepa_feedback.jsonl'), scores.map(score => `${JSON.stringify(gepaFeedback(score))}\n`).join('')),
  ]);
  return {outDir: out, board, devBoard, holdBoard, labels};
}
