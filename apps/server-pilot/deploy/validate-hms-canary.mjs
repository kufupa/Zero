import { existsSync, readFileSync } from 'node:fs';
import { effectiveWorkflowPolicy, hmsWriterReady, HMS_PROPERTIES, HMS_WORKFLOWS, HMS_WRITE_WORKFLOWS } from '../tooling/hms-cloud/hms-workflow-policy.mjs';

const [newPath, oldPath, canaryOverride, liveSha] = process.argv.slice(2);
const workflows = {
  HMS_DAVINCI_CREATE: 'create', HMS_DAVINCI_MAKE_QUOTE: 'quote', HMS_DAVINCI_READS: 'reads',
  HMS_DAVINCI_AMEND: 'amend', HMS_DAVINCI_CANCEL: 'cancel', HMS_DAVINCI_ATTACH: 'attach',
  HMS_DAVINCI_ADDONS: 'addons', HMS_DAVINCI_GUEST_PROFILE_CREATE: 'guest_profile_create',
  HMS_QUOTE_PREPARE: 'quote', HMS_QUOTE_REST_FAST_PATH: 'quote', HMS_PREFETCH_ENABLED: 'prefetch', HMS_AVAILABILITY_PREFETCH: 'availability',
  PARTY_MATCH_V2: 'party', INBOUND_TRIAGE_CLASSIFIER: 'triage', LEGACY_INBOUND_TRIAGE_PIPELINE: 'triage',
  INBOUND_EXTRACTION: 'extraction', PANE_WRITE_CREATE: 'create', PANE_HMS_LAB_CREATE_WORKER: 'create',
  PANE_CLOUD_CREATE_DISPATCH: 'create', PANE_WRITE_AMEND_UNPAID: 'amend', PANE_WRITE_AMEND_PAID: 'amend',
  PANE_WRITE_AMEND: 'amend', PANE_HMS_LAB_AMEND_WORKER: 'amend', PANE_WRITE_CANCEL_UNPAID: 'cancel',
  PANE_WRITE_CANCEL_PAID: 'cancel', PANE_WRITE_ADDONS: 'addons', PANE_WRITE_ATTACH: 'attach',
  PANE_HMS_LAB_ATTACH_WORKER: 'attach', RESERVATIONIST_PANE_SAVE: 'save', HMS_JOB_QUEUE: 'queue',
};
const configuredPropertyFlags = new Set(['HMS_JOB_QUEUE', 'HMS_QUOTE_PREPARE', 'HMS_PREFETCH_ENABLED', 'HMS_AVAILABILITY_PREFETCH', 'PARTY_MATCH_V2']);
const isOn = value => /^(on|true|1)$/i.test(value ?? '');
const davinciEnabled = env => (env.HMS_DAVINCI_ENABLED_PROPERTIES || '').split(',').filter(Boolean);
function parse(path) {
  const values = {};
  if (!path || !existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw new Error('invalid environment');
    values[match[1]] = match[2].replace(/'\\''/g, "'");
  }
  return values;
}
function fail(message) {
  process.stderr.write(`write-ec2-remote-env: refuse: ${message}\n`);
  process.exit(2);
}
try {
  const next = parse(newPath);
  const prev = parse(oldPath);
  const needed = new Map();
  const add = (workflow, property) => needed.set(`${workflow}:${property}`, { workflow, property });

  // Compare scope even when every flag already reads "on".
  for (const property of HMS_PROPERTIES) {
    for (const workflow of HMS_WORKFLOWS) {
      const before = effectiveWorkflowPolicy(prev, property, workflow);
      const after = effectiveWorkflowPolicy(next, property, workflow);
      if (after.mode === 'on' && (before.mode !== 'on' || before.credentialIdentity !== after.credentialIdentity ||
          before.writerDependencyDigest !== after.writerDependencyDigest)) add(workflow, property);
    }
  }
  for (const [flag, workflow] of Object.entries(workflows)) {
    const value = next[flag];
    const widensAmend = flag === 'PANE_WRITE_AMEND' && value === 'on' && prev[flag] !== 'on';
    const changedLegacyScope = configuredPropertyFlags.has(flag) && isOn(value) && isOn(prev[flag]) &&
      ((next.HMS_EXPECTED_PROPERTY_CODE || 'HRCEN') !== (prev.HMS_EXPECTED_PROPERTY_CODE || 'HRCEN') ||
       next.HMS_EXPECTED_TENANT !== prev.HMS_EXPECTED_TENANT || next.HMS_EXPECTED_TRANSPORT_ID !== prev.HMS_EXPECTED_TRANSPORT_ID);
    // The REST quote read is one global flag, used by HRCEN and by every enabled DaVinci property.
    const restQuoteProperties = flag === 'HMS_QUOTE_REST_FAST_PATH' && isOn(value)
      ? ['HRCEN', ...davinciEnabled(next)].filter(property => !isOn(prev[flag]) ||
        (property !== 'HRCEN' && !davinciEnabled(prev).includes(property))) : [];
    if (!widensAmend && !changedLegacyScope && !restQuoteProperties.length && (!isOn(value) || isOn(prev[flag]))) continue;
    if ((flag === 'PANE_CLOUD_CREATE_DISPATCH' && next.PANE_WRITE_CREATE === 'lab') ||
        (flag === 'PANE_HMS_LAB_CREATE_WORKER' && next.PANE_WRITE_CREATE === 'lab') ||
        (flag === 'PANE_HMS_LAB_AMEND_WORKER' && next.PANE_WRITE_AMEND === 'lab') ||
        (flag === 'PANE_HMS_LAB_ATTACH_WORKER' && next.PANE_WRITE_ATTACH === 'lab')) continue;
    if (flag.startsWith('HMS_DAVINCI_')) {
      const enabled = (next.HMS_DAVINCI_ENABLED_PROPERTIES || '').split(',').filter(Boolean);
      // Legacy DaVinci entry points predate the explicit property set.
      for (const property of enabled.length ? enabled : ['HRDAV']) add(workflow, property);
    } else if (flag === 'HMS_QUOTE_REST_FAST_PATH') {
      for (const property of restQuoteProperties) add(workflow, property);
    } else {
      add(workflow, configuredPropertyFlags.has(flag) ? (next.HMS_EXPECTED_PROPERTY_CODE || 'HRCEN') : 'HRCEN');
    }
  }
  if (needed.size === 0) process.exit(0);
  if (!/^[0-9a-fA-F]{40}$/.test(liveSha ?? '')) fail('40-character live SHA missing for scope widening');
  const canaryPath = canaryOverride || next.NAVA_CANARY_PASS_FILE || '/etc/nava/hms-canary-passes.txt';
  let text = '';
  try { text = readFileSync(canaryPath, 'utf8'); } catch { /* Missing evidence fails closed below. */ }
  const rows = new Set(text.split(/\r?\n/).filter(line => /^CANARY PASS [a-z_]+ (HRCEN|HRDAV|HRDAVS) [0-9a-fA-F]{40}$/.test(line)).map(line => line.toLowerCase()));
  for (const { workflow, property } of needed.values()) {
    if (!rows.has(`canary pass ${workflow} ${property} ${liveSha}`.toLowerCase())) {
      fail(`no exact CANARY PASS ${workflow} ${property} ${liveSha}`);
    }
    if (HMS_WRITE_WORKFLOWS.includes(workflow) && !hmsWriterReady({ ...next, NAVA_CANARY_PASS_FILE: canaryPath }, property, workflow, liveSha)) {
      fail(`no compatible writer readiness for ${workflow} ${property} ${liveSha}`);
    }
  }
} catch {
  fail('invalid scope or environment');
}
