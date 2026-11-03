// Operator only: obtain owner authorization before updating a live work item.
import { getDb } from '../db/client.js';
import { recoverHmsLabtestCreate } from '../ai/hms-labtest-dispatch.js';

async function main() {
  const [flag, holdId, ...extra] = process.argv.slice(2);
  if (flag !== '--hold' || !holdId || extra.length) throw new Error('usage: reconcile-labtest-create --hold <uuid>');
  await recoverHmsLabtestCreate(getDb(), holdId);
  process.stdout.write('Create positively reconciled.\n');
}

main().catch(() => {
  process.stderr.write('Recovery outcome unconfirmed; inspect durable state before any further action.\n');
  process.exitCode = 1;
});
