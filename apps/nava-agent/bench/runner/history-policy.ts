import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {findPolicyRows, historyRowKey, indexHistoryPolicy, type PolicyKeys} from '../../src/history-policy.js';
import {indexPolicyHistory} from '../../src/policy-history-data.js';
import type {TwinWorld} from '../twin/world.js';

export function loadReplayHistoryInputs() {
  const read = (path: string | undefined) => path ? readFileSync(path) : null;
  const history = read(process.env.NAVA_BENCH_HISTORY_FILE);
  const policy = read(process.env.NAVA_BENCH_POLICY_FILE);
  const mail = read(process.env.NAVA_BENCH_HISTORY_MAIL);
  const sha = (bytes: Buffer | null) => bytes && createHash('sha256').update(bytes).digest('hex');
  const digest = {history: sha(history), policy: sha(policy), history_mail: sha(mail)};
  // last_seen dates the winning value only. Without the observation window we cannot
  // tell whether a frozen row's support/agreement uses later, possibly disagreeing stays.
  if (policy && !history) throw new Error('Replay policy needs NAVA_BENCH_HISTORY_FILE for cutoff checks');
  const snapshot = policy ? indexHistoryPolicy(JSON.parse(policy.toString())) : {};
  const observations = indexPolicyHistory(history?.toString() ?? '', mail?.toString() ?? '');
  return {digest, forWorld(world: TwinWorld) {
    const lookup = (keys: PolicyKeys) => world.propertyCode === 'HRCEN' ? findPolicyRows(snapshot, keys).filter(row => {
      const source = observations.latest.get(historyRowKey(row.key_type, row.key))?.get(row.field);
      return source !== undefined && Math.max(source, Date.parse(row.last_seen)) < world.cutoff;
    }) : [];
    return {lookup, organizationUse: () => observations.organizationUse(world.cutoff)};
  }};
}
