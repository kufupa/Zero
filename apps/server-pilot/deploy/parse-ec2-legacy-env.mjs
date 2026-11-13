import { readFileSync, writeFileSync } from 'node:fs';

const QUOTED_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/;
const SAFE_UNQUOTED_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:=?@%+,-]+)$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

function fail() {
  process.stderr.write('legacy runtime env malformed\n');
  process.exit(2);
}

function parseAssignments(source) {
  if (source.includes('\r') || source.includes('\0')) throw new Error('invalid');

  // Blank lines carry no assignment (install-gotenberg.sh appends after one); every other line must still parse.
  const lines = source.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error('invalid');

  const values = new Map();
  for (const line of lines) {
    const quoted = QUOTED_ASSIGNMENT.exec(line);
    const unquoted = SAFE_UNQUOTED_ASSIGNMENT.exec(line);
    const match = quoted ?? unquoted;
    if (!match || values.has(match[1])) throw new Error('invalid');
    values.set(match[1], quoted ? quoted[2].replace(/'\\''/g, "'") : unquoted[2]);
  }
  return values;
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateReleaseControl(key, value) {
  if (value === undefined || value === '') return;
  const groups = [
    [['PANE_WRITE_CREATE', 'PANE_WRITE_AMEND', 'PANE_WRITE_AMEND_UNPAID', 'PANE_WRITE_AMEND_PAID',
      'PANE_WRITE_CANCEL_UNPAID', 'PANE_WRITE_CANCEL_PAID', 'PANE_WRITE_ATTACH'], ['off', 'lab', 'on']],
    [['PANE_HMS_LAB_CREATE_WORKER', 'PANE_HMS_LAB_ATTACH_WORKER', 'PANE_HMS_LAB_AMEND_WORKER',
      'PANE_CLOUD_CREATE_DISPATCH', 'HMS_JOB_QUEUE', 'HMS_AVAILABILITY_PREFETCH',
      'LEGACY_INBOUND_TRIAGE_PIPELINE', 'RESERVATION_V2_ARRIVAL_PREFILL', 'PANE_STAY_LOOKUP'], ['off', 'on']],
    [['HMS_PREFETCH_ENABLED', 'HMS_LANE_PAUSED', 'PARTY_MATCH_V2'], ['true', 'false', '1', '0']],
    [['HMS_QUOTE_PREPARE'], ['true', 'false', '1', '0', 'on', 'off']],
  ];
  for (const [keys, allowed] of groups) {
    if (keys.includes(key) && !allowed.includes(value)) throw new Error('invalid');
  }
  if (key === 'QUOTE_RATE_CONTEXT' && value.trim() &&
    !['off', 'on'].includes(value.trim().toLowerCase())) throw new Error('invalid');
  if (['HMS_PREFETCH_PER_HOUR', 'HMS_GUEST_PREFETCH_PER_HOUR', 'HMS_AVAILABILITY_PER_HOUR',
    'HMS_QUOTE_PREPARE_PER_HOUR'].includes(key) && !/^\d{1,15}$/.test(value)) throw new Error('invalid');
  if (['HMS_MEMORY_PMS_PATH', 'HMS_MEMORY_OUTBOUND_PATH', 'HMS_MEMORY_DATA_DIR',
    'HMS_NATIVE_CATALOG_PATH', 'HMS_MEMORY_OBSERVATIONS_PATH', 'PARTY_INDEX_PATH', 'PARTY_INDEX_PATH_HRDAV'].includes(key) &&
    !/^\/[A-Za-z0-9._/-]+$/.test(value)) throw new Error('invalid');
  const patterns = {
    HMS_EXPECTED_TENANT: /^[A-Z][A-Z0-9_]+$/,
    HMS_EXPECTED_PROPERTY_CODE: /^[A-Z][A-Z0-9]+$/,
    HMS_EXPECTED_TRANSPORT_ID: /^transport-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  };
  if (Object.hasOwn(patterns, key) && !patterns[key].test(value)) throw new Error('invalid');
}

try {
  const [legacyEnvPath, remoteCommonPath, ...allowlist] = process.argv.slice(2);
  if (
    !legacyEnvPath ||
    !remoteCommonPath ||
    allowlist.length === 0 ||
    new Set(allowlist).size !== allowlist.length ||
    allowlist.some((key) => !ENV_KEY.test(key) || key === 'NODE_ENV')
  ) {
    throw new Error('invalid');
  }

  const values = parseAssignments(readFileSync(legacyEnvPath, 'utf8'));
  if (values.get('NODE_ENV') !== 'production') throw new Error('invalid');
  for (const key of ['DATABASE_URL', 'AWS_REGION', 'S3_BUCKET']) {
    if (values.get(key)?.trim().length === 0 || !values.has(key)) {
      throw new Error('invalid');
    }
  }

  const lines = ["NODE_ENV='production'"];
  for (const key of allowlist) {
    const value = values.get(key);
    validateReleaseControl(key, value);
    if (key === 'PANE_BRAIN' && value && !['agent', 'classifier'].includes(value)) {
      throw new Error('invalid');
    }
    if (key === 'QUOTE_WORKFLOW_LLM' && value !== undefined && !['on', 'off'].includes(value)) {
      throw new Error('invalid');
    }
    if (['AZURE_OPENAI_BASE_URL', 'AZURE_FOUNDRY_API_KEY'].includes(key) &&
      value !== undefined && value.trim().length === 0) {
      throw new Error('invalid');
    }
    if (value !== undefined && value.length > 0) {
      lines.push(`${key}=${quote(value)}`);
    }
  }
  writeFileSync(remoteCommonPath, `${lines.join('\n')}\n`, 'utf8');
} catch {
  fail();
}
