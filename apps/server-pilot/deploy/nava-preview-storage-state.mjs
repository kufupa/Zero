#!/usr/bin/env node
// Turns the better-auth sign-in response headers into a Playwright storage state.
// Usage: nava-preview-storage-state.mjs <headers-file> <out-file> <cookie-domain>
// Only the session cookies are copied. Nothing secret is printed: the success line
// carries a count, and failures carry a fixed message.
import { readFileSync, writeFileSync } from 'node:fs';

const [headersPath, outPath, domain] = process.argv.slice(2);
if (!headersPath || !outPath || !domain) {
  console.error('usage: nava-preview-storage-state.mjs <headers-file> <out-file> <cookie-domain>');
  process.exit(2);
}

// Production cookies carry the __Secure- prefix; development ones do not.
const SESSION_COOKIE = /^(?:__Secure-)?better-auth\.session_(?:token|data)$/;

const cookies = [];
for (const line of readFileSync(headersPath, 'utf8').split(/\r?\n/)) {
  if (!/^set-cookie:/i.test(line)) continue;
  const pair = line.replace(/^set-cookie:\s*/i, '').split(';')[0] ?? '';
  const eq = pair.indexOf('=');
  if (eq < 1) continue;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!SESSION_COOKIE.test(name) || !value) continue;
  cookies.push({
    name,
    value,
    domain,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
}

if (!cookies.some((cookie) => cookie.name.endsWith('better-auth.session_token'))) {
  console.error('sign-in response carried no session cookie');
  process.exit(3);
}

writeFileSync(outPath, `${JSON.stringify({ cookies, origins: [] })}\n`, { mode: 0o600 });
console.log(`storage state written: ${cookies.length} session cookie(s)`);
