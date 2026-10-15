# Multi-Property HMS: Da Vinci + Centurion

> Phase 1 audit and dependency-ordered implementation plan. Phase 2 is limited to slice 1; no live HMS, production, deploy, or secrets touched.

## (a) Current single-property assumptions

### Config and secrets

| Location | Current assumption |
|---|---|
| `apps/server-pilot/src/env.ts:47-65,310-344` | Runtime config holds one secret ARN, tenant, property, and transport; property type is literal `HRCEN` and env parser rejects any other code. |
| `apps/server-pilot/src/hms/runtime.ts:38-49,253-258,1660-1665` | One `HmsSecret` carries one Infor URL/login, expected tenant/property/name, mailbox transport, and credential mode. Each read must match that one secret's mailbox transport. Runtime options carry one `secretArn`. |
| `apps/server-pilot/src/hms/production-runtime.ts:242-273,308-315,335-350` | Secret is loaded once; origin is checked against `CENTURION_HMS_PRODUCTION_ORIGIN`; secret tenant/property/transport must equal the one worker config; one HRCEN manifest and role-proof adapter are built. |
| `apps/server-pilot/deploy/write-ec2-env.sh:121,138-140`; `deploy/pm2.config.cjs:102-125`; `deploy/import-hms-secret.sh:18-20,35-67` | One `HMS_READ_SECRET_ARN` and one tenant/property/transport set enter the worker. Defaults are `HMS_LEGACY`, `HRCEN`, and `transport-centurion`; importer writes one `mailboxTransportId` into the secret. |

### Browser runtime

| Location | Current assumption |
|---|---|
| `apps/server-pilot/src/ai/worker.ts:830-889` | `productionHmsRuntime` is a process-wide singleton built from one worker config and cached for every HMS job. |
| `apps/server-pilot/src/hms/runtime.ts:1203-1212,1461-1478,1743-1755` | One runtime owns one lazily launched `HmsBrowser` and one session semaphore; each `openReadSession` keeps its own context state. Semaphore allows one active HMS session, at most two waiters, and serializes unrelated properties if they share this runtime. |
| `apps/server-pilot/src/hms/runtime.ts:2786-2811,2942-2950`; `runtime.ts:3416-3428` | `HMS_SINGLE_CONTEXT_LOGIN=1` is a process-wide switch for login/proof context handling inside each session. Normal browser factory calls `chromium.launch()` once, then `browser.newContext()`; contexts are fresh per session. No `launchPersistentContext` or `userDataDir` appears in this production path. |

### Lock and job queue

| Location | Current assumption |
|---|---|
| `apps/server-pilot/src/hms/property-read-lock.ts:25-29,75-79,245` | Advisory lock is already keyed by `(tenantId, propertyCode)`. Same-property reads serialize; distinct property keys can proceed independently at this layer. This is not the suspected cross-hotel bottleneck. |
| `apps/server-pilot/src/ai/run-ledger.ts:594-651` | Durable claim is shared `hms` lane; claim scope filters transport/run kind/prompt/idempotency prefix, not property. `FOR UPDATE SKIP LOCKED` claims a global eligible row. |
| `apps/server-pilot/src/ai/worker.ts:5653-5683` | `runHmsJobOnce` claims that shared lane. It does not choose a per-property queue before dispatch. |
| `apps/server-pilot/src/hms/property-queue-state.ts:38-45,54-93` | Quote status records a property lock key, but in-memory runs are local to one process and keyed by generation; lookup is mailbox transport + user, not a durable per-property scheduler. |

### Drivers, manifests, and authorization

| Location | Current assumption |
|---|---|
| `apps/server-pilot/src/hms/live-company-account-read-driver.ts:67,102`; `live-document-list-driver.ts:54`; `live-event-read-driver.ts:89`; `live-group-block-driver.ts:297` | Driver validation/evidence properties include literal `HRCEN`. |
| `apps/server-pilot/src/hms/live-folio-read-driver.ts:840,1305`; `live-quote-stay-driver.ts:406,414`; `live-sent-email-observer.ts:492,521,592` | Folio/quote defaults, sent-document evidence, and sent-mail candidate validation are HRCEN-bound; folio already has an expected-property parameter, but defaults to HRCEN. |
| `apps/server-pilot/src/hms/live-read-manifest.ts:656,927,1190-1191,1271,1648,1723`; `src/hms/request-manifests/hms_quote_stay.availability.2.0.0.json:1056`; `hms_read_folio.deposit-ledger.1.0.0.json:1082` | Reviewed request bodies, selectors, and manifest builders contain HRCEN-only fields/defaults. They are authorization artifacts, not safe string replacements. |
| `apps/server-pilot/src/hms/release-kernel.ts:47,82,162,387`; `find-reservation-facade.ts:166`; `reservation-detail-facade.ts:292`; `folio-read-facade.ts:45`; `read-handler-index.ts:86`; `read-admission-issuer.ts:555,638,668,699,729`; `reservation-candidate-session.ts:80,396`; `read-admission.ts:398` | More HRCEN literals/defaults pin release schemas, role-proof validation, candidate/read evidence, or UI result construction. These require a dedicated authorization/release migration with tests; slice 1 must not loosen them. |

### Triage and prompts

| Location | Current assumption |
|---|---|
| `apps/server-pilot/src/ai/triage.ts:898-901` | Pre-stay notification rule matches only `Property HRCEN`. Generic own-mailbox/pre-stay logic is already parked on `park/d1-prestay-20261014`; `docs/context/FACTS.md:98` records this, so reuse that work rather than redo research. |
| `apps/server-pilot/src/ai/reservationist-decision.ts:3`; `reservationist-draft-source.ts:13`; `reservationist-operational-draft-source.ts:11,19`; `thread-context.ts:28` | Prompt rules, structured draft schema/guard, and confirmation parsing encode Centurion/HRCEN assumptions. |
| `apps/server-pilot/src/ai/worker.ts:2879-2881` | Missing property in an admission path defaults to HRCEN. |

### Pane/UI and deploy environment

| Location | Current assumption |
|---|---|
| `apps/server-pilot/src/ai/pane-stay-save.ts:22-24,146-148` | Server save path pins lock/session to HRCEN and strips user-supplied `propertyCode` from the request. Preserve that trust boundary; route from authenticated mailbox/property context, never the form value. |
| `apps/server-pilot/src/ai/pane-stay-save.ts:151-163` | Current save guard also has Labtest identity/date constraints; do not confuse these with property selection or weaken them while generalizing. |
| `apps/server-pilot/deploy/write-ec2-env.sh:121,138-140`; `deploy/pm2.config.cjs:102-125`; `deploy/import-hms-secret.sh:18-20,55-67` | Deploy/runtime wiring exposes one property, one mailbox transport, and one Infor credential reference. Browser executable is shared as a binary, not as a profile; `deploy/install-hms-browser.sh:10,150-161`. |

## (b) Browser lifecycle and likely two-login failure

**Owner facts supplied 2026-10-14 (credential values omitted):** Centurion remains `HMS_LEGACY` / `HRCEN`; Da Vinci uses the same HMS origin and tenant `HMS_DAVINCI`, behind the same Infor LAN/VPN. Both properties use the same Infor username. Da Vinci password and property code remain unknown; mailbox/transport mapping also remains unknown. Coordinator owns the first read-only Da Vinci login/property-picker probe. No live login or secret read was done in this audit.

- Production composition caches one process-wide `productionHmsRuntime` per `hms-ai-worker` process (`worker.ts:794-795,924-988`). PM2 config defines one `hms-ai-worker` instance (`pm2.config.cjs:88-105`); the regular `http` pane server does not call the HMS runtime. Source call graph shows worker as the normal production runtime caller. This is source/config evidence, not a live PM2 process listing: production state was not inspected under the no-production-touch constraint.
- Proof orchestration is sequential by construction: `runCanary` refuses to run while `hms-ai-worker` exists, closes its standalone runtime, then removes the PM2 process (`hms-live-proof.ts:1243-1247,1327-1349`). `runStart` checks that no HMS PM2 worker exists before starting its single `hms-ai-worker` (`hms-live-proof.ts:1434-1436,1471-1475`). So approved proof path does not intentionally overlap its standalone browser session and worker session. Unmanaged manual/legacy processes cannot be ruled out without inspecting production process state.
- Runtime owns one lazily launched Chromium browser and one process-local one-active-session semaphore (`runtime.ts:1203-1212,1461-1478`). Each session normally gets a fresh context; no persistent `userDataDir` appears in the production path. `HMS_SINGLE_CONTEXT_LOGIN=1` keeps login/read on one context within a session; it does not create per-property runtimes or accounts.
- `createLiveGuestStayDriver.withSession` acquires the DB property advisory lock before `runtime.openReadSession` (`live-guest-stay-driver.ts:657-695`), so that lock covers login and read for Guest Stay. Its key hashes `(tenantId, propertyCode)` (`property-read-lock.ts:41-45`). Same-property Guest Stay work across processes serializes, but Centurion and Da Vinci get different lock keys. `live-group-block-driver.observeGroupBlockContext` opens a session directly (`live-group-block-driver.ts:591-599`) and does not accept/acquire the property lock. The process semaphore does not coordinate separate processes. Thus current cross-process lock coverage is incomplete, and any future per-property runtime or unmanaged second process could log in concurrently with the same username unless every browser entrypoint uses a configurable credential-aware lock.
- **Root-cause hypothesis, not confirmed:** Infor may invalidate an existing session when the same username logs in under another tenant/property. This fits the owner's concurrency theory, but repo has no Infor-specific kick/expired error or log. `runtime.ts:1690` reports internal `session authorization expired` (Nava lease expiry, not an Infor login eviction); `hms-group-event-discovery-phase5.ts:3` says a menu click “invalidated session” (UI interaction, not another login). Current approved PM2/proof path is serialized; historical/unmanaged concurrent sessions remain unverified. No evidence supports persistent-profile cookie collision in the current production path.

## (c) Target design

1. **Property registry:** typed, validated entry per hotel: `tenantId`, `propertyCode`, non-secret `username`, secret reference, trusted mailbox transport/address, and HMS base URL. Password remains only in the property-bound Secrets Manager record; never log username or password. Reject duplicate property codes, mailbox routes, and ambiguous mappings at startup. HRCEN remains the only configured entry in slice 1; Da Vinci tenant/origin are known, but property code, mailbox mapping, and password are not.
2. **Per-property runtime:** resolve mail/job to one registry entry from trusted mailbox transport; create/cache a runtime by property. Each runtime owns its property-bound credential, HMS origin, browser process, ephemeral contexts, audit/role-proof binding, and session semaphore. Do not reuse profile/context/cookies across hotels.
3. **Concurrency:** make the distributed session-lock key scope explicit and configurable: `per-property` (`tenantId + propertyCode`) or `per-credential` (stable identity shared by entries using same Infor username, never logged). Hold it from before login until context close. Until the coordinator confirms Infor permits concurrent sessions per username or provides a second Da Vinci user, use `per-credential` for shared usernames; otherwise distinct credential identities may run concurrently. Keep the DB advisory lock as the cross-process fence. Property queues may run concurrently only when credential lock permits.
4. **No leakage:** bind job transport, tenant, property, secret, manifest/release, and evidence to same registry entry before browser open; fail closed on any mismatch. A request body or guessed property code cannot choose target hotel.
5. **Pane identity:** determine property from authenticated mailbox/thread context, show hotel name/property in pane and results, and route save/read through that trusted property runtime. Keep `propertyCode` stripped from client save payload and preserve Labtest safety guard until owner-approved write workflow changes.

## (d) Dependency-ordered PR slices and tests

Effort ranges are calibrated planning estimates (agent-hours), not permission to touch live systems. Each slice is a separate reviewable PR; tests use fakes/fixtures only.

| Order | Slice | Verification test | Est. effort |
|---:|---|---|---:|
| **1 — this PR** | Add typed property identity/registry from current worker config with non-secret username and secret reference; pass explicit HRCEN property to existing live drivers where safe. Add configurable advisory-lock key mode (`per-property` or `per-credential`), default `per-credential`; wrap every browser-session entrypoint with the same lock, including group-context reads and the workstation/pane browser paths. Keep only HRCEN registered; do not alter release schemas, enable Da Vinci, or change secrets. | New tests: HRCEN registry preserves tenant, username, mailbox transport, origin, and secret reference; duplicate/empty entries reject. Lock tests prove shared usernames map to one key by default, explicit property keys remain distinct, nested entrypoints reuse the held lock, and group-context acquires it before session open. Existing HRCEN driver tests stay equivalent in evidence property and request behavior. Run targeted HMS driver tests, then full `apps/server-pilot` Vitest with `--maxWorkers=2`. | **3.5–5 h** |
| 2 | Expand config/secret loading to a registry of property entries; key secret validation and role-proof/evidence bindings by property. Keep legacy single-property env compatibility during migration; add explicit startup rejection for unknown/mismatched transport/property/origin. | Offline schema/production-runtime tests for two fake entries, wrong secret, duplicate mailbox, wrong tenant/property, and unknown transport; assert no secret value is logged. | 4–6 h |
| 3 | Replace process-wide HMS singleton with a registry of per-property runtimes; each owns its browser and one-active-session semaphore. Keep fresh context per job; preserve slice-1 distributed lock policy across runtime lifecycle, with no second-property activation until owner proof and property-bound releases exist. | Fake-browser + lock tests: same-property/shared-username sessions serialize across processes; distinct credentials can overlap; contexts/cookies never cross; close/recreate one runtime leaves other healthy. | 6–9 h |
| 4 | Partition durable HMS queue claims by registry property/transport and connect each claimed job to its property runtime. Retain the configured cross-process session lock through login/read/close; property queue parallelism cannot bypass credential-scoped serialization. | DB-backed/offline queue tests: same-property order/serialism, shared-credential cross-property serialization, distinct-credential parallel claim, paused lane, retry, and wrong transport cannot run on another property's credentials. | 5–8 h |
| 5 | Generalize driver evidence, manifests, read admission, release-kernel schemas, and role-proof/property checks from HRCEN to passed registry property. Review and reissue property-bound releases; do not broaden request rules without property-specific reviewed fixtures. | Per-property fixture tests for HRCEN and fake Da Vinci: evidence and manifest bind correct code/origin; cross-property candidate/release fails closed; mutation requests remain blocked. | 6–9 h |
| 6 | Generalize pre-stay triage/prompts and pane property identity/routing. Reuse `park/d1-prestay-20261014` generic own-mailbox rule; make pane show trusted hotel and route reads/saves server-side. | Triage tests for own mailbox, foreign mailbox, property aliases, existing stay vs new booking; pane tests for displayed hotel and tampered client property ignored. | 4–7 h |
| 7 | Add multi-property deploy config, per-property health/runtime diagnostics, rollout/rollback guards, and offline integration coverage. Keep production rollout separate and owner-authorized. | Config/PM2 shell tests with two fake property entries and mismatch cases; integration test proves two independent fake HMS endpoints run concurrently; no deploy/live HMS test in this repository lane. | 3–5 h |

**Slice 1 scope for this branch:** HRCEN-only property plumbing plus credential-aware lock coverage. Registry stores username identity and secret reference without changing credential material. Lock mode defaults to per-credential and remains explicitly configurable; group-context, worker, workstation quote, and pane browser entrypoints share the lock. Owner supplied Da Vinci tenant/origin and shared-username fact, but no Da Vinci property code, mailbox mapping, password, secret reference, or operational behavior is invented. No second property is enabled. Remaining HRCEN-bound authorization/release artifacts stay unchanged and block enabling a second property until slice 5.
