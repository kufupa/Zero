import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prepare } from './index.js';

const summary = z.object({
  outcome: z.literal('prepared'),
  changed_fields: z.array(z.string()),
  availability: z.object({ status: z.string() }),
  price: z.object({ basis: z.string() }),
});

async function main() {
  const [, , command, mode = 'live', ...extra] = process.argv;
  if (command !== 'prepare' || !['live', 'labtest', 'historical'].includes(mode) || extra.length) {
    process.stderr.write('Usage: tsx tools/amend/cli.ts prepare [live|labtest|historical] < private-input.json\n');
    process.exitCode = 2;
    return;
  }
  let input = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    input += chunk;
    if (input.length > 64_000) throw new Error('INPUT_TOO_LARGE');
  }
  const result = await prepare(JSON.parse(input), {
    sessionId: randomUUID(), mode: mode === 'labtest' ? 'labtest' : mode === 'historical' ? 'historical' : 'live',
  });
  if (!result.ok) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = 1;
    return;
  }
  const { outcome, changed_fields, availability, price } = summary.parse(result.data);
  process.stdout.write(JSON.stringify({ ok: true, outcome, staged_fields: changed_fields,
    availability: availability.status, price_basis: price.basis }) + '\n');
}

main().catch(() => {
  process.stderr.write('AMEND_CLI_FAILED: invalid input or unexpected adapter output.\n');
  process.exitCode = 2;
});
