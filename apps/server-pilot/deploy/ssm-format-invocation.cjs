#!/usr/bin/env node
/**
 * Fetch SSM invocation fields separately and emit ASCII-safe JSON.
 * Avoids Windows AWS CLI charmap failures on vitest unicode box-drawing.
 */
const { execSync } = require('node:child_process');

const awsEnv = {
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
};

const commandId = process.argv[2];
if (!commandId) {
  console.error('usage: ssm-format-invocation.cjs <command-id>');
  process.exit(2);
}

const region = process.env.AWS_REGION ?? 'af-south-1';
const instanceId = process.env.INSTANCE_ID ?? 'i-008f737974a9ba9b3';

function fetchField(field) {
  const out = execSync(
    [
      'aws ssm get-command-invocation',
      `--region ${region}`,
      `--command-id ${commandId}`,
      `--instance-id ${instanceId}`,
      `--query ${field}`,
      '--output json',
    ].join(' '),
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: awsEnv },
  );
  const parsed = JSON.parse(out.trim());
  if (parsed === null || parsed === undefined) return '';
  return String(parsed).replace(/\r/g, '');
}

function asciiSafe(text) {
  return text.replace(/[^\t\n\r\x20-\x7e]/g, '?');
}

const status = fetchField('Status').trim();
const responseCodeRaw = fetchField('ResponseCode').trim();
const statusDetails = asciiSafe(fetchField('StatusDetails'));
const stdout = asciiSafe(fetchField('StandardOutputContent'));
const stderr = asciiSafe(fetchField('StandardErrorContent'));

const responseCode = Number.parseInt(responseCodeRaw, 10);

console.log(
  JSON.stringify({
    Status: status,
    ResponseCode: Number.isFinite(responseCode) ? responseCode : null,
    StatusDetails: statusDetails,
    Stdout: stdout,
    Stderr: stderr,
  }),
);