---
title: "feat: Native Codex Pomerado booking read"
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Native Codex Pomerado booking read

## Goal Capsule

- **Objective:** Use Codex on Product EC2 as the native MCP client for self-hosted Pomerado. Have Pomerado itself log in to HRCEN, open Stay 360, find one previous booking and return every visible field and value, with missing sections identified.
- **Authority:** Ask 360 requests this plan. This document does not itself start a trial. Execute after the owner authorizes the run. Prior unrelated approvals do not authorize writes or email.
- **Priority:** Native Pomerado login first. If it fails, record that outcome and use the existing deterministic login as a separate clearly labelled fallback, without claiming native login passed. An incomplete mint alone does not prove a login failure.
- **Boundary:** Read-only real bookings; no create, change, cancellation or send. Keep Guardian, the approved private-data route, both observed HRCEN property lock identities, and cleanup. Do not resurrect the assistant-added sandbox prerequisites removed in ask 304 or the unbuilt stop gate.
- **Success:** The requested screen details are returned from the exact matching booking, then a published generated tool is reviewed and freshly replayed on that same booking. Distinguish a successful initial screen read from full publication and replay.

---

## Product Contract

### Summary and problem frame

The previous screen mint used a custom Python MCP client and ended incomplete. The owner wants the vendor's normal Codex MCP flow on the actual EC2 host, with explicit model roles and a real previous booking as the example. Setup is already partly present but its current runtime, per-role routing and native login remain unproved. The goal is an honest, useful comparison, not another harness or a public-site exercise.

### Requirements

- R1. Reuse the existing EC2 Pomerado and Chromium setup where verified; register a native stdio Pomerado server in a dedicated Codex configuration.
- R2. Configure Codex through the approved Azure route for GPT-6.1 Terra xhigh and Pomerado's minting, Guardian and applicable review roles for GPT-6 Luna max. Verify effective settings where observable; report unsupported or unverified roles rather than using an unauthorized model.
- R3. Let Pomerado manage HRCEN sign-in from scratch before using Nava's known login helper as a labelled fallback.
- R4. Use the actual HRCEN tenant URL and a specific independently matched prior booking, with date hints if needed. Keep identifiers and credentials out of the integration intent and public artifacts.
- R5. Open Stay 360 and the exact booking; read all accessible visible sections and fields, including blank fields, repeated rows and control values. Report unreadable or unavailable sections instead of inventing values.
- R6. Keep the job on its original MCP connection, respond to native requests, capture the terminal build outcome and relevant private evidence, and distinguish incomplete from published.
- R7. If published, inspect the generated source for side effects and correct tenant navigation, then run the generated read tool in a fresh context and compare its output with the independently captured reference for the same booking.
- R8. Keep the read-only, privacy, Guardian, shared-property exclusion and cleanup boundaries. Native login responses may be visible to the MCP client and its model provider; never reveal credentials in chat or checked-in files.

### Scope boundaries

This proof does not authorize a booking, an add-on, a cancellation, a CMS send, a production deployment, a flag flip, or an unrelated public-site mint. One booking is the present checkpoint, not a replacement for the previously requested three-case comparison. Preserve the original selected screenshot case and all three cases for later. No work on the previously hook-denied combined stop-gate typecheck, and no bypass of that denial.

---

## Planning Contract

### Key technical decisions

- KTD1. **Codex is the MCP client.** Start a fresh Codex session on EC2 and use its registered native tools. A config listing alone does not establish the server connected; verify the four actual tools in-session. Keep the same server process alive for the job.
- KTD2. **Isolated configuration, no shared overwrite.** Use a dedicated private `CODEX_HOME`, integration root, temporary directory and Pomerado-only browser cache. Reference existing secrets through the executing process environment. Configure Codex's Azure provider separately from the MCP server and explicitly forward the selected server's `OPENAI_API_KEY`, `OPENAI_BASE_URL` and browser-cache environment. Verify values are present without printing them. Do not alter other users' Codex defaults, print keys, modify the production Playwright cache or use a Python MCP client.
- KTD3. **Model roles are not inherited from Codex.** The pinned upstream source names Sol for its minter and defaults key roles to medium effort. Do not launch those defaults. Inspect the actual chosen EC2 executable and all model-role settings; reuse the already isolated Luna-max overrides only if they support native Pomerado login and are verified. Otherwise use the smallest isolated model-only configuration or source/build adjustment necessary, with the available authorized verification route. Keep the login hook disabled for the first attempt. Do not infer success from config alone.
- KTD4. **One native read mint, not a pretend direct browser call.** Supply tenant URL, read authority, a short intent and one confirmation as example input. Follow `get_job`; supply complete matching native answers to `provide_input`. Do not remint the same job to poll it. Decline write switches. Read-only navigation, clicks, tabs and scrolling are allowed.
- KTD5. **Observable and resumable evidence.** Preserve private native status, available errors and generated source before native workspace cleanup. Native job output does not guarantee a screen transcript; the primary native route to booking output is the published tool's fresh replay. If a mint is incomplete, treat screen and login status as unknown unless independently observed. The default mint active deadline is twenty minutes; it pauses for user input and is not a proven success estimate. Terminal `completed` can mean `build: incomplete`.
- KTD6. **Avoid duplicate work.** The prior independent reference captured exact matches for three bookings, but complete tab and field coverage was not proven. Choose one of these exact matching references, preferably the owner's selected screenshot case only if its identifier is independently verified. Fill missing reference coverage as needed without concurrent HRCEN browser actors.
- KTD7. **No silent fallback.** A failed native sign-in is a failure of the first approach even if the existing login helper later succeeds. Start the fallback as a distinct mint only after the first job ends, using a separately verified login-hook-enabled build and a compatible fresh-run login path. The host-only login reset mismatch is a known source risk, not a proven failure. Report both outcomes and do not claim the fallback proves stock Pomerado sign-in.

### Execution-time unknowns

- Which installed Codex, Node, vendor build and Luna-max role overrides remain available on EC2; these are historical observations until checked.
- Whether the Azure deployment supports both requested models and efforts for both Codex and all Pomerado roles. Observe provider receipts or usage when available; if the provider does not expose effort, report the configured value separately from the observed model.
- Whether native HMS sign-in, existing credential handoff, tenant-origin replay, screen visibility and all tabs work. Pomerado's native `provide_input` exposes secret answers to the MCP client and may expose them to its model provider, as the vendor warns. The owner requested that login details be supplied; disclose this specific route before launch and obtain the vendor-required confirmation before sending secrets. Keep Codex session records and outputs in the private workspace, exclude credentials from chat, and retain or remove records according to the approved private-evidence policy.
- Whether the independently captured reference has enough section coverage for a meaningful comparison. Report partial coverage without claiming every screen field is validated.

---

## Implementation Units

### U1. Prepare the native EC2 client

- **Goal:** Make Codex on Product EC2 see the self-hosted native MCP server without disturbing shared configuration.
- **Requirements:** R1, R2, R8.
- **Dependencies:** None.
- **Files:** Dedicated private Codex configuration and integration root under `.private/pomerado-readstay/`; existing vendor setup instructions in the separate Pomerado checkout `docs/agent-setup.md` and `docs/getting-started.md`.
- **Approach:** Inspect existing binary versions, built entrypoint, isolated Chromium cache, and existing Azure configuration without printing secrets. Reuse them when valid. Register the pinned native stdio server with the private integration root, explicit `env_vars` forwarding for `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `PLAYWRIGHT_BROWSERS_PATH`, and the vendor's startup settings. Verify the chosen build actually reads those names. Configure Codex's Azure provider separately with its own key environment reference. A dedicated `CODEX_HOME` is user-scoped configuration isolated to this trial; no global Codex change is required.
- **Test scenarios:** The new Codex session exposes `mint`, `get_job`, `provide_input` and `cancel_job`; a merely configured but disconnected server is reported as failed. Missing Node, key, browser dependency or server startup gets a specific private diagnostic. Listing tools launches no browser or model.
- **Verification:** A real Codex session can list the four native tools. No live HMS access occurs in this unit.

### U2. Verify both Azure model routes

- **Goal:** Ensure the outer controller uses Terra xhigh and the internal Pomerado roles use Luna max, with Guardian enabled.
- **Requirements:** R2, R8.
- **Dependencies:** U1.
- **Files:** Dedicated private Codex configuration under `.private/pomerado-readstay/`; selected Pomerado build's role configuration. If source changes are necessary, the separate Pomerado checkout's `typescript/src/models/models.ts`, `typescript/src/mint/openai.ts`, `typescript/src/guardian/model.ts`, applicable host/reviewer settings, and `typescript/tests/unit/model-ids.test.ts` are starting points, not assumed to be the complete change list.
- **Approach:** Check the selected executable, its model constants, default and specialized review efforts, and the environment actually passed to the server. Prefer a previously built, isolated model-only override with native login over modifying shared installation. Where unavailable, make the smallest isolated adjustment and verify the actual executable without bypassing any denied check. Use an innocuous minimal provider request only if prior evidence cannot establish current availability. No guest data in a model canary.
- **Test scenarios:** Codex requests Terra xhigh through Azure; each applicable Pomerado role requests Luna max. A role override that silently falls back to upstream Sol or medium fails this unit. Missing deployment, rejected effort, incompatible endpoint or unavailable verification is reported as a blocker, not an excuse to change model. Config evidence and per-call evidence are labelled separately.
- **Verification:** Model and effort are established to the degree the provider exposes, with residual gaps stated. No native mint starts on an unauthorized model.

### U3. Run native login and the booking read

- **Goal:** Have Pomerado complete its own HRCEN login and return the requested prior booking's visible details.
- **Requirements:** R3, R4, R5, R6, R8.
- **Dependencies:** U1, U2.
- **Files:** Existing private request/reference inputs and run-scoped private evidence under `.private/pomerado-readstay/`; existing guard patterns in `docs/research/2026-10-27-hrcen-two-locks.md` and `docs/research/2026-10-28-pomerado-live-mint-debug.md`.
- **Approach:** Acquire both observed HRCEN lock identities for the entire browser interval. Use the existing credential source, normal native sign-in questions, read-only mint and a concise booking lookup intent. The native secret-answer route is visible to Codex and may be visible to its model provider; disclose this and obtain the vendor-required confirmation before submitting credentials. Keep secrets out of chat and integration intent; protect private Codex session records. Give the model known field/date hints only when useful; do not embed a brittle full navigation script. Record native input requests, observed outcomes, private errors and output before cleanup.
- **Test scenarios:** A correct match yields booking identity and all accessible sections; an ambiguous match or not-found result is not substituted with another guest. Native sign-in denial, model failure, input timeout, property lock conflict and incomplete build produce distinct honest results. Never approve a write or send. If native login actually fails, preserve that failure and continue only with a separately verified login-bridge build and a new mint after the first ends, under the same read/privacy/lock boundaries. An incomplete mint does not by itself prove login failed.
- **Verification:** Record the requested visible information if actually observed, otherwise report exact failure or unknown status. Distinguish native login, fallback login, Stay 360 and exact booking; do not claim any succeeded without evidence. Do not represent `completed` as publication without inspecting the build result.

### U4. Replay, compare and clean up

- **Goal:** Establish whether Pomerado produced a reusable read tool and whether it reproduces the booking facts.
- **Requirements:** R5, R6, R7, R8.
- **Dependencies:** U3 publication.
- **Files:** Generated private integration and retained evidence under `.private/pomerado-readstay/`; `docs/context/ACTIVE.md`; `docs/context/OWNER-ASKS.md`; dated research notes.
- **Approach:** Review the generated source once before replay, especially authority, side effects and navigation from the vendor's root reset to the HRCEN tenant URL. Register the published integration as its own MCP server in the private Codex configuration, reload the client, call its actual tool in a fresh context, and follow its job and sign-in input requests. For the fallback path, use its separately verified fresh-run authentication. Compare every captured reference field and report any visible fields without independent reference coverage. Hold the property lock for browser work; release it after browser cleanup and verify owned process and credential cleanup. Record model receipts and costs only where available.
- **Test scenarios:** Exact matching output passes; differing value, missing section, wrong identifier, root navigation failure or fresh sign-in failure is reported explicitly. No publication means no replay; report the useful earlier screen read separately. Cleanup runs after success, failure and cancellation without killing unrelated processes.
- **Verification:** Same-booking fresh replay and reference comparison, or an exact partial outcome with cleanup evidence. Three-case comparison remains outstanding unless separately completed.

---

## Verification Contract

| Check | Pass evidence | Limit |
|---|---|---|
| Native MCP | Fresh Codex session exposes all four Pomerado tools. | Config listing alone is insufficient. |
| Model routing | Codex Terra xhigh and each applicable Pomerado Luna max request verified as far as provider records allow. | Configured values are not per-call receipts. |
| Native login | Pomerado confirms authenticated HRCEN in its own browser. | Earlier Nava helper success is not this proof. |
| Booking read | Exact booking match and complete accessible visible screen output. | Explicitly list unreadable sections. |
| Generated tool | Published source reviewed and fresh tool replay matches the same reference. | A mint screen read alone is partial. |
| Cleanup | Owned browser/client/credentials gone; held property locks released; any interrupted slot restored. | Report only checks actually observed. |

## Definition of Done

The owner receives the matching booking's accessible visible fields, a native-versus-fallback login result, publication and fresh-replay results, comparison gaps, model-routing evidence, and cleanup status. If any part fails, the result is partial with the actual failure and retained private evidence, not a claim of success. The original multi-case comparison and any later Labtest booking remain outside this checkpoint.

## Sources and Research

- Owner request: `docs/context/OWNER-ASKS.md`, ask 360.
- Prior outcomes: `docs/context/ledger/2026-10-27-pomerado-login-first-retro.md`; `docs/research/2026-10-28-pomerado-live-mint-debug.md`; `docs/research/2026-10-27-pomerado-readstay-test.md`.
- Source and lifecycle: [Pomerado agent setup at pinned revision](https://github.com/Pomerado/pomerado/blob/7349a1c2/docs/agent-setup.md), [native MCP README](https://github.com/Pomerado/pomerado/blob/7349a1c2/README.md), [model constants](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/models/models.ts), [Guardian defaults](https://github.com/Pomerado/pomerado/blob/7349a1c2/typescript/src/guardian/model.ts).
- Codex provider details: [Microsoft Foundry Codex guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex) and [Codex advanced configuration](https://developers.openai.com/codex/config-advanced/). The runtime version and deployment still need verification.
