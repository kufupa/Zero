---
title: Private Playwright audit bundles for live HMS read tools
date: "2026-09-18"
category: architecture-patterns
module: server-pilot HMS quote tooling
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - A live Playwright-backed HMS read needs an auditable run bundle for debugging or human review
  - A tool attaches to a borrowed remote browser and must preserve the owner's tabs and process
  - Trace, screenshot, or video artifacts may contain guest data, prices, account identity, or credentials
  - A live quote result must be checked against applied inputs, visible UI, native response data, and postconditions
  - A controller-side video is needed even though the remote browser context was not created with recordVideo
related_components:
  - infor-hms
  - hms-trace-privacy
  - browser-automation
  - live-verification
  - playwright-quote
tags:
  - playwright
  - audit-bundle
  - trace-privacy
  - screencast
  - live-hms
  - quote-tool
  - evidence-hashes
  - borrowed-browser
---

# Private Playwright audit bundles for live HMS read tools

## Context

The native Hotel Availability quote tool needed an auditable run product, not
just a returned quote. A useful run must make it possible to answer all of
these questions later: what inputs were applied, what did the operator see,
what did the PMS return, and what postcondition was actually checked? The
answer is a private, timestamped run bundle containing structured evidence and
optional media.

Earlier recorder work showed that a green packaging receipt could coexist with the camera remaining on a login screen, spinner, or wrong HMS surface, and that forcing context video could capture the login flow (session history). Those failures are why the pattern below treats authentication, named checkpoints, source evidence, privacy, and postconditions as one lifecycle rather than calling a video a proof by itself.

The first adopter is the standalone Playwright quote tool. It attaches to a
PMS-connected Chromium over a private CDP tunnel, but it does not own or
restart that browser. It creates a fresh isolated context and tab for the
invocation, performs login in that context, and closes only that context when
finished. The remote browser owner remains running. This ownership boundary is
important: a borrowed owner's existing tabs must not be traced, recorded, or
closed accidentally.

The reusable capture helper is `apps/server-pilot/tooling/playwright-quote/audit.mjs`.
The quote workflow uses it from `fetch-quote.mjs`; trace sanitization is shared
with the native HMS artifact code in `src/hms/trace-privacy.ts`.

Capture deliberately begins only after tenant/property verification and a
successful authenticated-shell check. The login screen and credentials are
therefore outside the recording boundary. A pre-auth failure or input
validation gap still gets durable events, a result, and a summary, but its
audit status explicitly remains `not_started`.

## Guidance

### Standard bundle contract

Every tool that adopts this layer should create one private directory per run.
The helper owns the capture artifacts; the caller owns business-specific
evidence and the final result:

```text
<private-run>/
  request.json                 # sanitized/request-scoped inputs
  result.json                  # structured outcome and audit report
  events.jsonl                 # ordered phase/checkpoint events
  trace.zip                    # sanitized Playwright trace
  screenshots/
    login-complete.png
    hotel-availability.png
    criteria-applied.png
    failure.png                # only when a safe failure screen exists
  video.webm                   # optional, when video was requested
  summary.txt
  <tool-specific-source>.json  # relevant native response projection
```

For the quote workflow, group-specific criteria, source, and result files are
also saved. Checkpoint names are lowercase, hyphen-separated business names,
so they remain easy to find in both `events.jsonl` and the screenshots
directory. The helper rejects unsafe checkpoint names and hashes each finished
artifact in its report.

The helper interface is intentionally small:

```js
const audit = await createAudit(runDirectory, { video: true });

// Do this only after authentication has been verified. Values are retained
// in memory only to extend trace redaction; they are never written as-is.
await audit.start(page, [secret.password, secret.username, secret.loginUrl]);
await audit.checkpoint('login-complete');
await audit.checkpoint('hotel-availability');
// ...perform the business operation and add meaningful checkpoints...
const auditReport = await audit.finish();
await context.close();
```

Call `finish()` while the page and context are still alive. It stops the
optional video, stops tracing to a temporary raw archive, sanitizes that
archive into `trace.zip`, records artifact hashes, removes the raw archive,
and records the final status. Closing the context first can lose the final
trace or video frames.

`fetch-quote.mjs` follows this lifecycle:

```js
const browser = await playwright().chromium.connectOverCDP(privateCdpUrl);
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  acceptDownloads: false,
  serviceWorkers: 'block',
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();

await login(page, secret);
await audit.start(page, [secret.password, secret.username, secret.loginUrl]);
await audit.checkpoint('login-complete');
await openHotelAvailability(page);
await audit.checkpoint('hotel-availability');
const result = await runInPage(page, request, runDirectory, audit.event, audit.checkpoint);
const report = await audit.finish();
await context.close();
await browser.close(); // detaches CDP; it does not stop remote Chromium
```

The actual workflow wraps the last steps in `try/finally`, attempts a safe
`failure` checkpoint for post-auth failures, and stores `result.audit` beside
the business outcome. A CLI success requires both a business outcome of
`quote` or verified `unavailable` and an audit status of `complete`. `partial`,
`execution_failure`, input gaps, and incomplete capture return a non-success
exit code even when some artifacts exist.

### Video and trace ordering

Playwright 1.63 exposes the public `page.screencast.start()` and
`page.screencast.stop()` APIs. The helper uses them on the controller that is
attached to the remote browser, so the controller can produce `video.webm`
even though Chromium runs elsewhere. This is distinct from context-level
`recordVideo`: `recordVideo` must be enabled when a context is created and
cannot be switched on later for a borrowed browser owner.

Video is opt-in because it is sensitive, expensive, and not needed for every
production run. Enable it for development, debugging, write-like operations,
failures, or a deliberate sample. The controller must have the pinned
Playwright FFmpeg installation available for the resulting WebM to be useful.

Start the screencast before starting tracing. The first screencast subscriber
determines the dimensions of the shared received frames; subscribing the trace
first caused the video to be downscaled. The verified implementation requests
a 1280x720 viewport and starts video before `context.tracing.start()`.

Do not claim that video proves a quote. A recording shows interaction and
visible state; it does not by itself establish that hidden request parameters,
network responses, or readback checks were correct. Pair it with the evidence
contract below.

### The evidence-pairing rule

For a business assertion, retain all of these pieces in the same run bundle:

1. **Applied inputs.** Persist the request and the actual criteria sent to the
   PMS, including dates, occupancy, property, strategy, and cleared filters.
2. **Visible checkpoint.** Save a named screenshot and, when enabled, the
   corresponding video/trace state after the screen has rendered.
3. **Structured result.** Store normalized values with explicit units and
   limitations, rather than parsing a screenshot later.
4. **Relevant source response.** Save a narrow projection of the native network
   response and the matching visible grid. Never persist the raw request when
   it contains credentials or session fields.
5. **Postcondition/readback.** Re-open or inspect the relevant native detail
   view and check the result against it. For nightly hotel availability this
   means every charged night, the departure restriction, Availability Details,
   and Room Type Information.

The quote tool applies this to each occupancy group. It records the criteria,
the selected native response, each nightly price/inventory value, screenshots
of the result and detail panels, and source text. Artifact hashes and a private
verification receipt make it possible to detect a changed or incomplete
bundle after the run.

### Privacy and failure behavior

Treat every screenshot, video, trace, request, and source projection as
private. Browser media is not visually redacted and may show account identity,
guest information, prices, or other business data. Run directories are mode
`0700`; files are mode `0600`; do not commit, upload, or publicly host them.
Keep retention short and use an approved private handoff when another operator
needs to inspect a run.

The trace sanitizer fails closed. It permits only the native trace streams,
strict single-component `resources/<name>` entries, and Playwright 1.63
viewport frames under `screencast/<name>.jpeg`. It scans dynamic values and
known storage/request secrets, removes credential-bearing headers and bodies,
and writes only the sanitized archive. The temporary `.trace-raw.zip` is
deleted on both successful and failed sanitization; a failed sanitizer makes
the audit `incomplete`, never `complete`.

Playwright 1.63's trace JSON uses resource references in `_file` fields (with
legacy `sha1`/`_sha1` variants in other trace shapes). The sanitizer must
recognize only references to resources actually present in the archive. It
must not blanket-exempt arbitrary values in fields named `sha1`, because doing
so can allow secrets through or make distinct resources collide after
redaction. The HMS `iscallerlogin` cookie is a special yes/no mode flag; only
the exact `iscallerlogin=yes` and `iscallerlogin=no` values are exempt, and
only during cookie collection. Unknown values and credential cookies such as a
JSESSIONID remain protected.

If video startup fails, retain and report the trace where possible, mark the
video failure, and make the overall audit incomplete. If a checkpoint returns
to a login screen, mark that explicitly and do not present the resulting run as
valid evidence. Errors are sanitized before they are placed in `result.json`
or `summary.txt`; credentials and private URLs must never appear in logs or
documentation.

### Quote interpretation boundaries

The audit layer proves what the tool observed; it does not widen the tool's
business guarantees. The native HMS screen supplies a daily calendar. Prices
are per room per night, not certified whole-stay or all-room totals. There is
no inventory hold, price lock, booking, or exhaustive rate comparison.
Sequential occupancy-group searches do not prove joint/additive inventory.
Policies are reported only when their exact source text is shown; a configured
policy flag must not be translated into an invented cancellation, payment, or
flexibility promise. A null calendar response is not proof of sold-out
inventory. These limitations belong in the structured result and summary so a
viewer cannot mistake a polished video for a stronger business claim.

## Why This Matters

UI automation is difficult to debug from a scalar result. A quote can look
plausible while a stale filter, wrong date, hidden row, failed session, or
misread currency has changed the meaning. A bundle creates a chain from user
request to rendered screen, native source, normalized result, and readback.
That chain is useful during incident review, acceptance testing, and future
tool development without requiring the operator to reproduce a time-sensitive
PMS state.

The private boundary also makes observability safer. Capture begins after
authentication, only the owned context is traced, secret values are supplied
to an in-memory sanitizer, and raw trace material is removed. The result is
auditable without turning credentials or recordings into ordinary repository
artifacts.

The final live verification demonstrated the intended shape: a real
Hotel Availability run retained source-matched nightly observations, a
sanitized trace, named screenshots, and an optional post-login WebM recording.
The recording decoded fully; the source projection, hashes, trace links,
privacy checks, and borrowed-owner preservation were checked separately. Exact
property, dates, prices, and the bundle itself remain private.

## When to Apply

Adopt this pattern for any Playwright tool whose output may be questioned,
acted on, or difficult to reproduce: availability and pricing reads, admin
workflows, data writes, migrations performed through a UI, and sampled
production automation. Use the full bundle for debugging or an acceptance
run; use trace plus structured events for ordinary runs; enable video only when
its additional visual context justifies the privacy and storage cost.

Before adding capture to a new tool, confirm:

- The tool has a clear ownership boundary and can create an isolated context.
- Authentication is verified before capture starts, and no shared tab is
  traced.
- Business checkpoints have stable names and correspond to meaningful
  postconditions, not arbitrary clicks.
- The source response can be projected without session credentials or raw
  request bodies.
- The result records units, uncertainty, and limitations instead of inferring
  values from pixels.
- `finish()` runs before context closure, including in failure paths.
- The sanitizer has tests for the exact Playwright trace version and media
  entries used by the tool.

Do not use a video-only bundle as a correctness certificate. Do not turn on
recording for a borrowed context after it has started, do not capture login
screens, and do not place private artifacts under tracked or publicly served
directories.

## Examples

### Minimal reusable capture lifecycle

```js
const runDirectory = privateRunDirectory();
const audit = await createAudit(runDirectory, { video: process.env.AUDIT_VIDEO === '1' });
let report;
try {
  await login(page, secret); // no capture yet
  await audit.start(page, [secret.password, secret.username, secret.loginUrl]);
  await audit.checkpoint('login-complete');
  await performWorkflow(page, input);
  await audit.checkpoint('criteria-applied');
  await verifyNativeReadback(page);
} catch (error) {
  await audit.checkpoint('failure').catch(() => undefined);
  throw error;
} finally {
  report = await audit.finish();
  await context.close();
}
await saveEvidence(runDirectory, 'result.json', { outcome, audit: report });
```

In production code, preserve the original error/result while adding the audit
report, and make finalization errors visible. A failure to capture is not an
excuse to label a result fully verified.

### Quote-specific evidence sequence

```js
await audit.checkpoint('hotel-availability');

const source = await searchCalendar(page, request, room, async () =>
  audit.checkpoint('group-1-criteria-applied'),
);
await saveEvidence(runDirectory, 'group-1-criteria.json', source.criteria);
await audit.checkpoint('group-1-availability-results');

// Select only a source-matched native row, then read every charged night.
const chosen = selectOption(request, room, source.data, source.calendar);
await saveEvidence(runDirectory, 'group-1-source.json', {
  endpoint: '/api/internalBooking/hotelAvail/inquiryForGrid',
  criteria: source.criteria,
  datesList: source.data.datesList,
  room: chosen.nativeRoom,
  rate: chosen.rate,
  visible: chosen.dom,
});
const details = await readDetails(page, chosen, 'group-1', audit.checkpoint);
```

The resulting option explicitly carries `basis: 'per_room_per_night'`, nightly
dates, amounts, currency, inventory, exact source text, and limitations. It
does not manufacture a whole-stay total or treat a missing PMS calendar as
unavailability.

### Verification checklist for a retained run

For a live bundle, inspect the following independently of the video player:

```text
result.audit.status == "complete"
trace.zip contains no supplied secret or credential-bearing value
all named screenshots and the optional video are non-empty
events.jsonl sequences are contiguous and end with run_finished
source projection matches the visible selected row and requested dates
each charged night and departure restriction have a readback
artifact hashes match the verification receipt
private directory/file permissions are 0700/0600
remote owner is still alive; only the owned context was closed
```

The implementation's focused Node tests cover capture lifecycle, hashing,
video opt-in/failure, raw-trace cleanup, checkpoint safety, and no-side-effect
imports. The Vitest privacy and browser-artifact suites cover sanitizer
redaction and archive behavior; scoped lint and diff checks complete the code
verification. A real run still needs media playback/decode and live owner
preservation checks; synthetic tests cannot establish those facts.

## Related

- `apps/server-pilot/tooling/playwright-quote/audit.mjs` — reusable event,
  checkpoint, screenshot, trace, video, hashing, permission, and cleanup layer.
- `apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs` — the first
  adopter and example of post-login capture plus source/readback evidence.
- `apps/server-pilot/tooling/playwright-quote/audit.test.mjs` — lifecycle and
  failure-path contract, including Playwright 1.63 screencast ordering.
- `apps/server-pilot/tooling/playwright-quote/fetch-quote.test.mjs` — business
  validation and no-side-effect guarantees.
- `apps/server-pilot/src/hms/trace-privacy.ts` — bounded, fail-closed trace
  sanitizer and HMS secret collection rules.
- `apps/server-pilot/src/hms/runtime.ts` and
  `apps/server-pilot/src/hms/browser-artifacts.ts` — existing HMS artifact and
  trace infrastructure whose privacy behavior the native tool reuses.
- `docs/solutions/workflow-issues/hms-wave-a-read-tool-proof-three-gates-playbook.md` —
  existing payload, packaging, and visual acceptance gates; keep those gates
  authoritative.
- `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md` —
  semantic payload checks that video and packaging cannot replace.
- `docs/solutions/workflow-issues/hms-hitl-ui-first-playwright-recorder-build.md` —
  UI-first recording guidance for tools that own browser startup.
- `docs/solutions/conventions/live-negative-result-verification-gate.md` —
  independent proof required before treating a live empty result as truth.
- The quote tool README documents operator commands, private retention,
  browser-owner/tunnel boundaries, and interpretation limits. Keep that
  operational documentation synchronized when the bundle contract changes.
