/** Score stay-pick JSONL. No DB. Usage: pnpm exec tsx scripts/replay-stay-pick.ts --in file.jsonl */
import { readFileSync } from 'node:fs';
import { pickStayFromFindRows, type StayPickAsk, type StayPickPop } from '../src/ai/aop/stay-pick.js';

export type StayPickReplayRow = {
  runId: string;
  ask: StayPickAsk;
  rows: unknown[];
  workflow: string;
  goldConf: string | null;
  pop?: StayPickPop;
};

export function scoreStayPickReplay(rows: StayPickReplayRow[]) {
  const wrongIds: string[] = [];
  let pick_correct = 0;
  let pick_wrong = 0;
  let check_conf = 0;
  let none = 0;
  for (const row of rows) {
    const pick = pickStayFromFindRows(row);
    if (pick.status === 'check_conf') check_conf += 1;
    else if (pick.status === 'none') none += 1;
    else if (pick.confirmationNumber === row.goldConf) pick_correct += 1;
    else {
      pick_wrong += 1;
      wrongIds.push(row.runId);
    }
  }
  return { n: rows.length, pick_correct, pick_wrong, check_conf, none, wrongIds };
}

export function parseStayPickReplayJsonl(text: string): StayPickReplayRow[] {
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    return trimmed ? [JSON.parse(trimmed) as StayPickReplayRow] : [];
  });
}

function main(argv: string[]): void {
  const flag = argv.indexOf('--in');
  const path = flag >= 0 ? argv[flag + 1] : undefined;
  if (!path || path.startsWith('-')) {
    console.error('usage: pnpm exec tsx scripts/replay-stay-pick.ts --in <jsonl>');
    process.exit(2);
  }
  const { n, pick_correct, pick_wrong, check_conf, none, wrongIds } = scoreStayPickReplay(
    parseStayPickReplayJsonl(readFileSync(path, 'utf8')),
  );
  console.log({ n, pick_correct, pick_wrong, check_conf, none });
  if (wrongIds.length) console.log(wrongIds.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
