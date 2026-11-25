import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {eligiblePolicyRow, exactHistoryKey, HISTORY_FIELDS, historyFieldAllowed, historyRowKey, indexHistoryPolicy,
  policyKeys, policyValue, type PolicyKeys, type PolicyRow} from '../../src/history-policy.js';
import {anchorCaptures, createdFieldValue, parseCreatedOn, type TwinWorld} from '../twin/world.js';

type NativeField = PolicyRow['field'];
type Row = Record<string, unknown>;
type Observation = {at: number; value: string};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonl = (bytes: Buffer) => bytes.toString().split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as Row);

export function loadReplayHistoryInputs() {
  const read = (path: string | undefined) => path ? readFileSync(path) : null;
  const history = read(process.env.NAVA_BENCH_HISTORY_FILE);
  const policy = read(process.env.NAVA_BENCH_POLICY_FILE);
  const mail = read(process.env.NAVA_BENCH_HISTORY_MAIL);
  const digest = {history: history && sha(history), policy: policy && sha(policy), history_mail: mail && sha(mail)};
  const snapshot = policy && indexHistoryPolicy(JSON.parse(policy.toString()));
  const historyRows = history && jsonl(history);
  const mailByStay = new Map((mail ? jsonl(mail) : []).filter(row => row.has_pre_create_request !== false).map(row => [
    String(row.conf ?? row.confirmation ?? ''), {
      booker_email: row.booker_email ?? row.sender, booker_domain: row.booker_domain ?? row.sender_domain,
    },
  ]));
  const byProperty = new Map<string, ReturnType<typeof indexObservations>>();
  return {digest, forWorld(world: TwinWorld) {
    const property = world.propertyCode;
    let timelines = byProperty.get(property);
    if (!timelines) {
      timelines = indexObservations(property === 'HRCEN' ? historyRows ?? fromAnchors(world) : [], mailByStay);
      byProperty.set(property, timelines);
    }
    const indexed = timelines;
    return (keys: PolicyKeys): PolicyRow[] => policyKeys(keys).flatMap(([type, key]) => {
      const token = historyRowKey(type, key);
      const fields = indexed.get(token);
      if (!fields) return [];
      return [...fields].flatMap(([field, observations]) => {
        const last = observations.at(-1)!;
        // The full snapshot is admissible only if ALL contributing stays were already created.
        // An early last_seen alone cannot rule out later observations of other values.
        const exported = snapshot?.[token]?.find(row => row.field === field);
        if (exported && last.at < world.cutoff && Date.parse(exported.last_seen) < world.cutoff) return [exported];
        const counts = new Map<string, {n: number; last: number}>();
        let total = 0;
        for (const {at, value} of observations) {
          if (at >= world.cutoff) break;
          const prev = counts.get(value);
          counts.set(value, {n: (prev?.n ?? 0) + 1, last: at});
          total++;
        }
        if (total < 2) return [];
        const [value, top] = [...counts].sort(([av, a], [bv, b]) => b.n - a.n || b.last - a.last || av.localeCompare(bv))[0];
        const row = {key_type: type, key, field, value, support: total, agreement: top.n / total, last_seen: new Date(top.last).toISOString()};
        return eligiblePolicyRow(row) ? [row] : [];
      });
    });
  }};
}

function fromAnchors(world: TwinWorld): Row[] {
  return world.anchors.flatMap(anchor => {
    const capture = anchorCaptures(anchor)[0];
    const fields = capture?.hms_fields as Row | undefined ?? anchor.hms_fields;
    const raw = createdFieldValue(fields);
    const at = parseCreatedOn(raw) ?? world.createdOn.get(anchor.confirmation);
    if (at == null || !Number.isFinite(at)) return [];
    // HMS DD-MON-YYYY HH:mm is local SAST; normalized sidecars have a timezone.
    const offset = typeof raw === 'string' && /^\d{1,2}-[a-z]{3}-\d{4}/i.test(raw) ? 7200000 : 0;
    return [{...fields, conf: anchor.confirmation, created_at: new Date(at - offset).toISOString()}];
  });
}

function indexObservations(history: Row[], mailByStay: Map<string, {booker_email: unknown; booker_domain: unknown}>) {
  const byKey = new Map<string, Map<NativeField, Observation[]>>();
  const seen = new Set<string>();
  for (const row of history) {
    const at = Date.parse(String(row.created_at ?? ''));
    const conf = String(row.conf ?? '').trim();
    if (!conf || seen.has(conf) || !Number.isFinite(at)
      || /\b(?:labtest|proof)\b/i.test(String(row.guest_name ?? `${row.firstname ?? ''} ${row.lastname ?? ''}`))
      || /\bNAVAAI\b/i.test(String(row.created_by ?? row.createdby ?? ''))) continue;
    seen.add(conf);
    const mail = mailByStay.get(conf);
    const email = exactHistoryKey(row.booker_email ?? mail?.booker_email);
    const domain = exactHistoryKey(row.booker_domain ?? mail?.booker_domain) || email.split('@')[1];
    for (const [type, key] of policyKeys({booker_email: email, booker_domain: domain,
      company: exactHistoryKey(row.company), ta1: exactHistoryKey(row.ta1), guest_id: exactHistoryKey(row.guest_id ?? row.guestid)})) {
      const token = historyRowKey(type, key);
      const byField = byKey.get(token) ?? new Map<NativeField, Observation[]>();
      byKey.set(token, byField);
      for (const field of Object.keys(HISTORY_FIELDS) as NativeField[]) {
        if (!historyFieldAllowed(type, field)) continue;
        const value = policyValue(field, row[field]);
        if (!value) continue;
        const observations = byField.get(field) ?? [];
        observations.push({at, value});
        byField.set(field, observations);
      }
    }
  }
  for (const byField of byKey.values()) for (const observations of byField.values()) observations.sort((a, b) => a.at - b.at);
  return byKey;
}
