# Native Playwright fetch-quote

Standalone, attach-only Hotel Availability reader. No Stagehand runtime, model
credentials, database, server integration or booking actions. It owns one isolated
browser context and tab per invocation, closes that context and disconnects; it does not stop the remote
browser. Importing the module does not start the CLI or a browser.

## Run from the worktree root

Prerequisites: Node >=22.18, the existing isolated Playwright **1.63.0** install
under `../stagehand`, an approved PMS-connected browser owner, private CDP
tunnel, and the existing PMS credential secret. Module resolution is anchored
to the sibling package manifest, not the server's older Playwright install.
The server workspace dependencies must also be installed: audit capture reuses
`src/hms/trace-privacy.ts` and its existing pinned `fflate` 0.8.2 dependency.
The Centurion guard also needs the pinned `tsx` package and the checked-out
`src/hms` source at the same reviewed revision as this tool. It loads that
source directly; no server build is needed for the guard. A missing loader or
source stops the run with `HMS_QUOTE_CANONICAL_POLICY_UNAVAILABLE`.

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

For the registered, read-only Da Vinci availability proof, select the transport
instead of supplying a secret override. The registry fetches its mapped secret,
checks the tenant/property/user/transport and `view_only` binding, then permits
only the Hotel Availability inquiry POST while the read runs:

```bash
env -u HMS_READ_SECRET_ARN -u HMS_QUOTE_SECRET_PATH \
  HMS_STAGEHAND_CDP_URL=http://127.0.0.1:19223 \
  HMS_STAGEHAND_BROWSER_OWNERSHIP=borrowed \
  HMS_PROPERTY_TRANSPORT_ID=transport-davinci \
  AWS_REGION=af-south-1 \
  node apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs \
    --request apps/server-pilot/tooling/playwright-quote/examples/davinci-availability.json \
    --output .private/playwright-quote/runs
```

Each invocation writes a timestamped private audit bundle. Outputs must be inside
this worktree's `.private/playwright-quote`. Exit 0 means `quote`, `no_match` or
verified `unavailable` **and** complete requested capture. Exit 2 covers incomplete
audit capture, `input_gap`, `partial`, or `execution_failure`. The business outcome
and `result.audit.status` are separate; inspect both.

## Audit bundle and video

Add `--video` to the command above to save a real viewport recording directly on
this VPS, even though Chromium runs on EC2. Playwright **1.63.0** supports
`page.screencast.start()` after attachment; owner-side `recordVideo` is not
required. The pinned Playwright FFmpeg binary must be installed on the controller
(already present on this VPS). To restore it if absent:

```bash
node apps/server-pilot/tooling/stagehand/node_modules/playwright/cli.js install ffmpeg
```

```text
<timestamp>-<run-id>/
  request.json
  result.json                 # outcome plus audit status and artifact hashes
  events.jsonl                # ordered, timestamped phases and checkpoints
  trace.zip                   # sanitized Playwright actions, DOM and network
  screenshots/
    login-complete.png
    hotel-availability.png
    group-1-criteria-applied.png
    group-1-availability-results.png   # after Search; missing this png is not a quote
    group-1-night-1-details.png
    group-1-room-information.png
    failure.png               # when capture started and failure screen is safe
  video.webm                  # only with --video
  group-1-criteria.json        # actual applied request, no session credentials
  group-1-source.json          # selected native response + matching visible grid
  group-1.json
  summary.txt
```

A run without `screenshots/group-N-availability-results.png` (the after-search grid) is not a quote. Missing `screenshots/group-N-criteria-applied.png` is not a quote either. `result.json` lists both paths; outcome `quote` is refused when either path is absent.

The adjacent `audit.mjs` is reusable by future native tools: create an audit,
call `start(ownedPage, secretValues)` **after verified login**, use `checkpoint`
at meaningful business steps, and call `finish()` before closing the context.
The quote tool is its first adopter; other tools are not retrofitted by this change.

Login is intentionally unrecorded. Trace, screenshots and optional video start
only after tenant/property and authenticated-shell verification. Pre-auth failures
and input gaps retain events/result/summary with capture explicitly `not_started`.
Never trace a shared borrowed context. The existing HMS bounded trace sanitizer
removes credential-bearing headers/request bodies and known secret values before
publishing `trace.zip`; the exact temporary raw archive is deleted even if
sanitization fails. Capture errors are reported, never silently called complete.

These artifacts are still **private**, not safe for public upload: images/video
are not visually redacted and may show guest information, account identity and
hotel pricing. Directories use 0700 and files 0600. Retain them only as long as
needed; do not commit recordings, inputs or traces. No public hosting is started.

Open `video.webm` in a local player. Inspect the trace locally with the pinned CLI:

```bash
node apps/server-pilot/tooling/stagehand/node_modules/playwright/cli.js show-trace /absolute/private/run/trace.zip
```

Video demonstrates the interaction, not quote correctness by itself. Review the
applied occupancy/dates, selected native response, visible prices and each
night's Availability Details together. No booking, price lock or inventory hold
is performed; policy and total limitations still apply.

## Browser owner and tunnel

Use the existing remote owner mechanism on the approved PMS-connected EC2 host,
not on this VPS. Do not restart another owner's browser without permission.
The execution used instance `i-008f737974a9ba9b3` in `af-south-1` and the existing
script below. It launches Chromium 1243 with a new persistent profile and does
not authenticate. The CLI performs login in its own isolated context/tab.

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

`examples/` holds sanitized adult, child, unavailable, missing-age and v2
requests. Dates are recorded verification windows, not future inventory
guarantees. Keep real customer inputs/outputs in `.private/playwright-quote/`.
The missing-age example is deliberately invalid and needs no browser.

Canonical request is `schemaVersion: 2` (`quote-tool.schema.json` `$defs.request`).
Absent `schemaVersion` is legacy: property/dates/occupancy stay; missing group
ids become `group-1` then `group-2`; root `roomCode`/`rateCode` become singleton
required lists on every group; bed/board aliases and room/flexibility/payment
text map to preferred features. Conflicting legacy and v2 fields are input
gaps, not silent winners. Legacy defaults to full details. Both paths return
the v2 result (multiple options, not the historical single-row winner).

v2 examples:

- `examples/v2-broad.json` — two adults, one room, no room/rate filter
- `examples/v2-required-preferred.json` — required queen, preferred breakfast
- `examples/v2-full-narrow.json` — full details, at most five native identities
- `examples/v2-scoped-context.json` — organization/agency/group via exact native
  `code` or unique name. Replace the placeholder; never invent a picker code.

```json
{
  "schemaVersion": 2,
  "propertyCode": "HRCEN",
  "arrivalDate": "2026-09-24",
  "departureDate": "2026-09-27",
  "rooms": [{"id": "share", "quantity": 1, "adults": 2, "children": 0, "childAges": []}]
}
```

Arrival/departure are ISO dates; departure is exclusive. Each room entry is an
occupancy group, not a sum of guests across rooms. Quantity multiplies per-room
occupancy. Child ages must be supplied individually; adults-only requests must
have `children: 0, childAges: []`. Up to eight groups and 1–30 nightly stays.
Tenant age picker accepts 0–99; that is a transport bound, not the property’s
commercial child definition. Unknown codes or unverifiable data fail rather
than becoming sold-out claims.

Search uses the ordinary **BAR sales-strategy filter**, leaving Shop by Day,
sales restrictions and property configuration untouched. Preset returned no
calendar despite positive BAR inventory and is not a sold-out oracle. Public
eligibility starts at verified `BAR` / `BARRO`. Other returned rates stay
conditional until entitlement is proven. Restricted rows are information, not
eligible quotes. When every matching row of a group is restricted, the group
lists each room type and night HMS closes to sale in `restrictedNights`; it is
never a quote. `includemultirateoptions` is Show Restricted Sell Options.

The tool enumerates source-bound room/rate options for each occupancy group.
There is no Standard/first-row winner. Required lists are OR within a field
and AND across fields. A preference miss does not reject. Match, alternative
and unresolved stay distinct. Native descriptions are retained; STWN labelled
“Standard Twin” can still say Two Double Beds — never infer bed type from the
room name.

Broad searches return useful options with `allocation.status: not_selected`.
A complete multi-group `quote` requires every group to select exactly one
room code and one rate code via `rooms[].required.roomCodes` /
`rateCodes`. Joint demand uses proven `property:building:roomCode` pools when
`buildingCode` is present on the source room. Missing pool identity stays
`unknown`, never an invented allotment. Sequential occupancy searches are not
an atomic hold. Alternatives are never summed. Displayed-nightly sums use
exact decimals and `official:false`; they are not PMS payable totals.

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

Run these from the worktree root on the approved test host, following the
project's serialized test route; do not run the suite on the shared VPS.

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL
node --check apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs
node --check apps/server-pilot/tooling/playwright-quote/quote-contract.mjs
node --check apps/server-pilot/tooling/playwright-quote/audit.mjs
node --import tsx --test --test-concurrency=1 apps/server-pilot/tooling/playwright-quote/*.test.mjs
(cd apps/server-pilot && node_modules/.bin/vitest run tests/hms-trace-privacy.test.ts tests/hms-browser-artifacts.test.ts)
```

The full Node glob includes `create-tool.schema.test.mjs`, which needs the
private `.private/create-screen/new-record.md` fixture. Focused tests use no
database or live PMS. Live run IDs, hashes, outcomes,
timing and remaining source limits sit in
`.private/playwright-quote/widening-handoff.md` (this widening) and historical
`.private/playwright-quote/handoff.md`. Those records, not this README, prove
verified capabilities. Partial/unknown outcomes mean unestablished coverage,
eligibility or joint allocation — not sold out and not a payable quote.

## Hotel slot owner (native)

`slot-owner.mjs` is the production Chromium owner for hotel slots. It uses
Playwright `launchPersistentContext` and loopback CDP. It does not load the
Stagehand extension. systemd template: `apps/server-pilot/deploy/hms-slot@.service`
(instances `hrcen`, `hrdav`). Do not enable the unit from this slice.

Env names (values live in `/etc/nava/hms-slot-%i.env`, not here):

- `HMS_SLOT_PROFILE_DIR` — persistent profile directory for one slot
- `HMS_SLOT_CDP_PORT` — loopback debug port
- `HMS_SLOT_DEBUG_ADDRESS` — must be loopback (`127.0.0.1`); non-loopback is refused
- `HMS_SLOT_PHASE_PATH` — `ready` / `recovering` / `down` JSON
- `HMS_SLOT_HEADLESS` — unit default `1`; headed vs headless is not decided here
- `HMS_STAGEHAND_CDP_URL` — Centurion pane attach name (existing)
- `HMS_STAGEHAND_CDP_URL_DAVINCI` — Da Vinci pane attach name
- `PLAYWRIGHT_BROWSERS_PATH` — Playwright browser cache, not a Stagehand trial path

