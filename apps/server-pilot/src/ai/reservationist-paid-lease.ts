import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** One local paid-accounting owner. Existing locks require explicit reconciliation, never age-based reclaim. */
export async function acquirePaidAccountingLease(path: string): Promise<{ release: () => Promise<void> }> {
  const token = randomUUID(), file = await open(path, 'wx', 0o600);
  await file.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));
  await file.close();
  let released = false;
  return { async release() {
    if (released) return;
    const current = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
    if (current.token !== token) throw new Error('paid_accounting_lease_owner_changed');
    await unlink(path); released = true;
  } };
}
