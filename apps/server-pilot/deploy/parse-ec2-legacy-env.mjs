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
    if (key === 'PANE_BRAIN' && value && !['agent', 'classifier'].includes(value)) {
      throw new Error('invalid');
    }
    if (key === 'QUOTE_WORKFLOW_LLM' && value !== undefined && !['on', 'off'].includes(value)) {
      throw new Error('invalid');
    }
    if (key === 'PANE_WRITE_AMEND' && value !== undefined && !['off', 'lab'].includes(value)) throw new Error('invalid');
    if (key === 'PANE_HMS_LAB_AMEND_WORKER' && value !== undefined && !['off', 'on'].includes(value)) throw new Error('invalid');
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
