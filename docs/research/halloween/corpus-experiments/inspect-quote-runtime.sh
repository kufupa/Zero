#!/usr/bin/env bash
# Read-only, on-box snapshot. Run through the approved SSM runner on the pilot.
# Prints only a checkout SHA, source hashes, service states and one named switch.
# No HMS call, database access, environment modification or service action.
set -euo pipefail

printf 'observed_utc='; date -u '+%F %T UTC'
printf 'checkout_sha='; git -C /home/ubuntu/repos/zero rev-parse HEAD
printf 'source_hashes='; sha256sum \
  /home/ubuntu/repos/zero/apps/server-pilot/src/ai/quote-rate-switch.ts \
  /home/ubuntu/repos/zero/apps/server-pilot/src/ai/staff-quote-run.ts | \
  python3 -c 'import json,sys; hashes=[x.split()[0] for x in sys.stdin]; len(hashes)==2 or sys.exit("source_hashes_unavailable"); print(json.dumps(hashes))'
python3 -I -B - <<'PY'
import json
import pathlib
import re

path = pathlib.Path('/home/ubuntu/repos/zero/apps/server-pilot/.env.production')
try:
    text = path.read_text()
    matches = re.findall(r'^[ \t]*(?:export[ \t]+)?QUOTE_RATE_CONTEXT([ \t]*)=(.*?)[ \t]*$', text, re.M)
    if not matches:
        result = 'unset'
    else:
        before_equals, raw_value = matches[-1]
        value = raw_value.strip()
        # Interpret only simple literal assignments; shell expansion stays unknown.
        literal = re.fullmatch(r'''([A-Za-z0-9_.-]+|'[A-Za-z0-9_.-]*'|"[A-Za-z0-9_.-]*")?(?:[ \t]+#.*)?''', value)
        if before_equals or raw_value[:1] in (' ', '\t') or literal is None:
            result = 'unknown'
        else:
            normalized = (literal.group(1) or '').strip('"\x27').lower()
            result = 'off' if normalized == 'off' else 'not_off'
except OSError:
    result = 'unreadable'
print('durable_quote_rate_context=' + json.dumps(result))
PY

# Avoid launching a PM2 daemon when one is not already present.
if ! test -S /home/ubuntu/.pm2/rpc.sock || ! pgrep -u ubuntu -f 'PM2 v' >/dev/null; then
  printf '%s\n' 'pm2_inspection=daemon_unavailable'
  exit 0
fi
export HOME=/home/ubuntu NVM_DIR=/home/ubuntu/.nvm
if test -s "$NVM_DIR/nvm.sh"; then . "$NVM_DIR/nvm.sh"; fi
if ! command -v pm2 >/dev/null; then
  printf '%s\n' 'pm2_inspection=cli_unavailable'
  exit 0
fi
pm2 jlist | node -e '
const fs = require("fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const flag = value => value === undefined ? "unset" : String(value).trim().toLowerCase() === "off" ? "off" : "not_off";
  let processes;
  try {
    processes = JSON.parse(input);
    if (!Array.isArray(processes)) throw new Error();
  } catch (_) {
    console.error("pm2_inspection=invalid_response");
    process.exitCode = 1;
    return;
  }
  const expected = ["http", "worker", "ai-worker", "remote-http"];
  const result = expected.map(name => {
    const p = processes.find(row => row.name === name);
    if (!p) return {name, status: "missing"};
    const env = p.pm2_env || {};
    let startup = "unreadable";
    try {
      const raw = fs.readFileSync(`/proc/${p.pid}/environ`, "utf8").split("\0");
      const entry = raw.find(value => value.startsWith("QUOTE_RATE_CONTEXT="));
      startup = flag(entry === undefined ? undefined : entry.slice("QUOTE_RATE_CONTEXT=".length));
    } catch (_) {}
    return {
      name,
      status: env.status === "online" ? "online" : "not_online",
      startup_quote_rate_context: startup,
      pm2_config_quote_rate_context: flag(env.QUOTE_RATE_CONTEXT ?? env.env?.QUOTE_RATE_CONTEXT),
    };
  });
  console.log("pm2_processes=" + JSON.stringify(result));
});'
