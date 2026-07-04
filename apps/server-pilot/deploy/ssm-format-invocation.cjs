#!/usr/bin/env node
/**
 * Fetch SSM invocation fields separately and emit ASCII-safe JSON.
 * Avoids Windows AWS CLI charmap failures on vitest unicode box-drawing.
 */
const { execSync } = require('node:child_process');

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
      '--output text',
    ].join(' '),
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return out.replace(/\r/g, '');
}

function asciiSafe(text) {
  return text.replace(/[^\t\n\r\x20-\x7e]/g, '?');
}

const status = fetchField('Status').trim();
const stdout = asciiSafe(fetchField('StandardOutputContent'));
const stderr = asciiSafe(fetchField('StandardErrorContent'));

console.log(JSON.stringify({ Status: status, Stdout: stdout, Stderr: stderr }));
