#!/usr/bin/env node
/**
 * Smoke-test xAI grok-4.3 with reasoning_effort=high (independent of War Room UI).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(root, '.env'));
loadEnvFile(join(root, '..', '..', '.env'));
loadEnvFile(join(homedir(), '.t3mp3st', '.env'));

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  console.error('XAI_API_KEY missing — copy tools/t3mp3st/.env.example → .env');
  process.exit(1);
}

const model = process.env.LLM_MODEL || 'grok-4.3';
const reasoningEffort = process.env.XAI_REASONING_EFFORT || 'high';

const body = {
  model,
  messages: [{ role: 'user', content: 'Reply with exactly: grok-ok' }],
  max_tokens: 64,
  reasoning_effort: reasoningEffort,
};

const res = await fetch('https://api.x.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
if (!res.ok) {
  console.error(`xAI ${res.status}: ${text}`);
  process.exit(1);
}

const data = JSON.parse(text);
const content = data.choices?.[0]?.message?.content ?? '';
console.log(
  JSON.stringify({
    ok: true,
    model: data.model || model,
    reasoning_effort: reasoningEffort,
    content: content.trim().slice(0, 200),
  }),
);
