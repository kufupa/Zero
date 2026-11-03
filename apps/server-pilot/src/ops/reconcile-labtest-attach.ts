// Operator only: obtain owner authorization before updating a live work item.
import { getDb } from '../db/client.js';
import { recoverHmsLabtestAttach } from '../ai/hms-labtest-dispatch.js';

async function main() {
  const [flag, holdId, ...extra] = process.argv.slice(2);
  if (flag !== '--hold' || !holdId || extra.length) throw new Error('usage: reconcile-labtest-attach --hold <uuid>');
  await recoverHmsLabtestAttach(getDb(), holdId);
  process.stdout.write('Filing positively reconciled from exact document metadata.\n');
}

main().catch(() => {
  process.stderr.write('Recovery outcome unconfirmed; inspect durable state before any further action.\n');
  process.exitCode = 1;
});
