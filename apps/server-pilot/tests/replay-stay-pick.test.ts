import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStayPickReplayJsonl, scoreStayPickReplay } from '../scripts/replay-stay-pick.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/stay-pick-replay.jsonl');

describe('replay-stay-pick', () => {
  it('scores a fixture JSONL without a database', () => {
    const score = scoreStayPickReplay(parseStayPickReplayJsonl(readFileSync(fixture, 'utf8')));
    expect(score).toEqual({
      n: 3,
      pick_correct: 1,
      pick_wrong: 0,
      check_conf: 1,
      none: 1,
      wrongIds: [],
    });
  });
});
