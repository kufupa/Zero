#!/usr/bin/env node
// Read-only: two party searches in one spawn on a borrowed CDP. Coordinator runs this
// on EC2 against HRDAV. Prints outcomes and phaseMs only — never names, candidates, or secrets.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopbackCdpUrl, scrubNavError } from './hms-deeplink-probe.mjs';
import { lookupParty, redactPartyLookupProbe } from './party-lookup.mjs';

const PROBE_SEARCHES = [
  { kind: 'organization', name: 'ZZPROBEAAA' },
  { kind: 'bookingAgency', name: 'ZZPROBEBBB' },
];

export function probeCommandEnv(env = process.env) {
  const cdp = loopbackCdpUrl(env.HMS_STAGEHAND_CDP_URL ?? '');
  if (!cdp) throw new Error('LOOPBACK_CDP_REQUIRED');
  if (env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') throw new Error('BORROWED_OWNERSHIP_REQUIRED');
  if (!env.HMS_READ_SECRET_ARN && !env.HMS_QUOTE_SECRET_PATH && !env.HMS_PROPERTY_TRANSPORT_ID) {
    throw new Error('SECRET_SOURCE_REQUIRED');
  }
  return { ...env, HMS_STAGEHAND_CDP_URL: cdp };
}

export async function runPartyLookupBatchProbe({ env = process.env } = {}) {
  process.umask(0o077);
  const slotEnv = probeCommandEnv(env);
  const dir = await mkdtemp(join(tmpdir(), 'party-batch-probe-'));
  try {
    const requestPath = join(dir, 'request.json');
    await writeFile(requestPath, JSON.stringify({ searches: PROBE_SEARCHES }), { mode: 0o600, flag: 'wx' });
    const result = await lookupParty({ requestPath, env: slotEnv });
    return redactPartyLookupProbe(result);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function probeSucceeded(result) {
  const searches = Array.isArray(result?.searches) ? result.searches : [];
  return searches.length === PROBE_SEARCHES.length
    && searches.every((item) => !item.skipped && ['resolved', 'ambiguous', 'no_match'].includes(item.outcome));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPartyLookupBatchProbe({ env: process.env })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = probeSucceeded(result) ? 0 : 2;
    })
    .catch((error) => {
      process.stderr.write(`party lookup batch probe failed: ${scrubNavError(error?.message ?? error) ?? 'unknown'}\n`);
      process.exitCode = 2;
    });
}
