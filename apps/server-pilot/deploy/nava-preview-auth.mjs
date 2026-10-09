#!/usr/bin/env node
// Secret handling for nava-preview-gate.sh. Secrets only ever travel on stdin and files
// with mode 600. The one value printed is the password the caller captures.
//   password <email>            pilot-users secret JSON on stdin -> password on stdout
//   signin-body <email> <out>   password on stdin -> sign-in JSON body written to <out>
// Errors are fixed messages. Parse errors never echo their input.
import { writeFileSync } from 'node:fs';

const [command, email, outPath] = process.argv.slice(2);

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  // printf '%s' sends no newline; tolerate one anyway so a stray newline cannot break sign-in.
  return raw.replace(/\r?\n$/, '');
}

if (command === 'password') {
  if (!email) fail('usage: nava-preview-auth.mjs password <email>', 2);
  let parsed;
  try {
    parsed = JSON.parse(await readStdin());
  } catch {
    fail('pilot secret is not JSON', 4);
  }
  const entry = parsed && typeof parsed === 'object' ? parsed[email] : undefined;
  const password =
    typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? entry.password
        : undefined;
  if (typeof password !== 'string' || password.length === 0) {
    fail('pilot account is not in the secret', 4);
  }
  process.stdout.write(password);
} else if (command === 'signin-body') {
  if (!email || !outPath) fail('usage: nava-preview-auth.mjs signin-body <email> <out>', 2);
  const password = await readStdin();
  if (!password) fail('no password on stdin', 4);
  writeFileSync(outPath, JSON.stringify({ email, password }), { mode: 0o600 });
} else {
  fail('usage: nava-preview-auth.mjs password <email> | signin-body <email> <out>', 2);
}
