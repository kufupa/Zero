# Native Playwright fetch-quote

Standalone, attach-only Hotel Availability reader. No Stagehand runtime, model
credentials, database, server integration or booking actions. It owns one tab
per invocation, closes that tab and disconnects; it does not stop the remote
browser. Importing the module does not start the CLI or a browser.

## Run from the worktree root

Prerequisites: Node >=22.18, the existing isolated Playwright **1.63.0** install
under `../stagehand`, an approved PMS-connected browser owner, private CDP
tunnel, and the existing PMS credential secret. Module resolution is anchored
to the sibling package manifest, not the server's older Playwright install.

Restore the exact checked-in dependency installation when needed:

```bash
npm ci --prefix apps/server-pilot/tooling/stagehand
```

The sibling manifest/lockfile intentionally retain the existing Stagehand
extension dependency used by the browser launcher. The quote command does not
import the Stagehand SDK or call a model.

```bash
HMS_STAGEHAND_CDP_URL=http://127.0.0.1:19223 \
HMS_STAGEHAND_BROWSER_OWNERSHIP=borrowed \
HMS_READ_SECRET_ARN=nava-zero/server-pilot/infor-hms-read \
AWS_REGION=af-south-1 \
node apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs \
  --request apps/server-pilot/tooling/playwright-quote/examples/adult.json \
  --output .private/playwright-quote/runs
```

Alternatively set `HMS_QUOTE_SECRET_PATH` to private JSON containing `loginUrl`,
`username`, `password`, `expectedTenant`, `expectedPropertyCode`, and
`expectedPropertyName`. Never commit that file or print its contents. AWS CLI
uses the operator's existing configuration/credential files. No extension ID,
LLM API key, spend ledger or telemetry configuration is required by this CLI.

Each invocation writes a timestamped private directory: request, applied search
criteria, selected option, per-night details screenshot, `result.json`, and
`summary.txt`. Outputs must be inside this worktree's `.private/playwright-quote`.
Exit 0 means `quote` or verified `unavailable`; exit 2 means `input_gap`,
`partial`, or `execution_failure`. Inspect the outcome, not just the exit code.

## Browser owner and tunnel

Use the existing remote owner mechanism on the approved PMS-connected EC2 host,
not on this VPS. Do not restart another owner's browser without permission.
The execution used instance `i-008f737974a9ba9b3` in `af-south-1` and the existing
script below. It launches Chromium 1243 with a new persistent profile and does
not authenticate. The CLI performs login in its own tab.

The adjacent `remote-owner.mjs` is a byte-for-byte, credential-free copy of that
verified EC2 launcher, retained with its historical comments and extension
flags. It must run at the EC2 path below, with the existing pinned SDK/browser
installation; do not run it on this VPS or treat it as part of the CLI's import
path. It is checked in for reproducibility; this commit does not deploy it.

The following commands run **on EC2 through `AWS-RunShellScript`**. First inspect
`ps` and `ss -lntp` for port 19223 and verify an existing owner's run ID/PID.
When the port is free, choose a new unused run ID (never reuse a profile when
claiming fresh-session verification):

```bash
runuser -u ubuntu -- env HMS_QUOTE_OWNER_RUN=playwright-release-20260917-2323 \
  bash -c 'nohup node /opt/nava/stagehand-trial-20260917/quote-mvp-owner/remote-owner.mjs > /opt/nava/stagehand-trial-20260917/quote-mvp-owner/playwright-release-20260917-2323.log 2>&1 < /dev/null &'
```

That is the actual final-verification startup command. For another run replace
both occurrences of the run ID. The existing script creates
`/opt/nava/stagehand-trial-20260917/quote-mvp-owner/<run-id>/owner.json` and
`profile/`. Check the metadata **and the live process/listener** before attaching.
Submit EC2 commands using:

```bash
aws ssm send-command --region af-south-1 --instance-ids i-008f737974a9ba9b3 \
  --document-name AWS-RunShellScript --parameters '<JSON commands array>'
aws ssm get-command-invocation --region af-south-1 \
  --instance-id i-008f737974a9ba9b3 --command-id <returned-command-id>
```

On the VPS, keep this terminal open for the private tunnel:

```bash
PATH=/tmp/ssm-plugin.nKo2Cd/root/usr/local/sessionmanagerplugin/bin:$PATH \
aws ssm start-session --region af-south-1 --target i-008f737974a9ba9b3 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["19223"],"localPortNumber":["19223"]}'
```

The temporary plugin path is the existing installation used during verification;
omit that PATH prefix when `session-manager-plugin` is already installed on PATH.
If that temporary installation has been removed, restore the Session Manager
plugin before running the tunnel. Never expose remote CDP publicly.

Shutdown is separate from the quote command. Read this run's owner metadata,
verify the PID still names this exact owner script, then send `kill -TERM <pid>`
through SSM. It closes its Chromium/profile cleanly. Preserve evidence/profile
files. End only your tunnel with Ctrl-C or `aws ssm terminate-session
--session-id <your-session-id>`. Do not kill an unrelated browser or tunnel.

## Inputs and interpretation

`examples/` contains sanitized versions of the adult, child, unavailable and
missing-age validation inputs, without mailbox/corpus references or customer
identities. Their dates are the recorded verification windows, not guarantees
of future inventory. Adjust dates for a new request, and keep real customer
inputs and outputs in `.private/playwright-quote/`. The missing-age example is
deliberately invalid and can be run without browser or credential configuration.

```json
{
  "propertyCode": "HRCEN",
  "arrivalDate": "2026-09-24",
  "departureDate": "2026-09-27",
  "rooms": [{"quantity": 2, "adults": 1, "children": 0, "childAges": []}],
  "preferences": {"room": "Standard", "bed": "Double", "board": "Breakfast"}
}
```

Arrival/departure are ISO dates; departure is exclusive. Each room entry is an
occupancy group, not a sum of guests across rooms. Child ages must be supplied
individually; adults-only requests must have `children: 0, childAges: []`.
Up to eight groups are accepted. The recorded tenant age picker accepts 0–99;
the command never guesses an age. Optional exact `roomCode` / `rateCode`
constrain the selected product (for example `STQN` / `BAR`). Unknown codes or
unverifiable data fail rather than becoming sold-out claims.

Search uses the ordinary **BAR sales-strategy filter**, leaving Shop by Day,
sales restrictions and property configuration untouched. Preset returned no
calendar despite positive BAR inventory and is not a sold-out oracle. Without
an exact rate code, selection considers public `BAR` / `BARRO`, prefers matching
room/board text and an available option, and returns one option, not every rate.
Native descriptions are retained; “Queen” is not silently mapped to “Double”.

This tenant exposes a daily calendar, not arrival/departure/nights input fields.
The tool binds every requested night to its rendered date, price and inventory,
opens Availability Details for each night, and checks departure restrictions.
The stay and its departure must fit the displayed calendar; otherwise the
command fails explicitly. It does not add a hidden date control or change PMS
configuration. Prices are **per room per night**, not PMS-certified whole-stay
or all-room totals. Tax inclusion remains unknown. Room quantity is checked
against each night's native inventory; there is no quantity input or hold.
Separate occupancy-group searches do not prove joint/additive inventory.

Availability Details and Room Type Information were inspected. BAR's displayed
meal label is retained; cancellation, date-change and payment policy text was
not displayed there. `configuredPolicies: true` is retained when the source
reports it, so “not shown” must not be read as “no policy exists”. Do not promise
flexibility, bank transfer, tax inclusion or child-meal inclusions beyond the
PMS's displayed meal-plan label.

## Checks and evidence

```bash
node --check apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs
node --test apps/server-pilot/tooling/playwright-quote/fetch-quote.test.mjs
```

The focused tests use no database or live PMS. Actual run IDs, hashes, outcomes,
timing, fresh-profile identity and final resource state are recorded privately
in `.private/playwright-quote/handoff.md`. Those live records, not synthetic
tests or the existence of this README, establish the verified capabilities.
