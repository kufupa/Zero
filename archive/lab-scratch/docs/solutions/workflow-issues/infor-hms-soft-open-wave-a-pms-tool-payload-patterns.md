---
title: Infor HMS soft-open and Wave A PMS tool payload completion patterns
date: 2026-09-13
last_updated: 2026-09-17
category: workflow-issues
module: server-pilot-hms / centurion-dashboard-tools
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Proving Infor HMS read tools via soft overlays, live dumps, and compare.v1 DoD sections"
  - "813/400/203 responses during HMS function-code probes"
  - "Packaging (video/mailProof) exists but payload sections still fail"
  - "Reservation child tabs require harvested function codes and stay/org keys in POST"
  - "Deciding invent-forbid vs EXTERNAL_ROLE_GATE after dump absence or security-rights responses"
  - "A required PMS fact is sourced from a mixed read/write screen or report"
  - "Converting Stagehand/model-assisted browser discovery into deterministic normal execution"
tags:
  - hms
  - soft-open
  - wave-a
  - centurion-dashboard
  - pms-tools
  - external-role-gate
  - payload-vs-packaging
  - invent-forbid
  - infor-hms
  - contract-evidence
  - stagehand
  - deposit
  - deterministic-adapter
---

# Infor HMS soft-open and Wave A PMS tool payload completion patterns

## Context

Centurion PMS Wave A aimed to **prove read payloads** for HMS-backed tools (reservation, folio, quote, group block, company profile, notes/traces, documents, mail channels)—not merely retain packaging artifacts. Infor HMS exposes behavior through **function codes** reached via session warm-up, early soft-open, and UI click-harvest. False negatives were common: **813-byte stubs** and **400** on guessed codes often reflected **probe order or polluted session state**, not role ceilings. Conversely, **203 security-rights** responses after a clean soft-open signal **entitlement or packaging class** problems. Some surfaces never appear in menu chrome (Events) or lack a bound knowledge corpus—those are **external gates**, not fixable by reordering probes alone.

This learning complements packaging-vs-payload completeness for find/`claimKeys` ([hms-live-proof-packaging-vs-payload-completeness.md](./hms-live-proof-packaging-vs-payload-completeness.md)): here the focus is the **operator playbook** that unblocked most Wave A tools and classified the rest.

The same trial exposed a planning failure: the business contract required deposit facts (due, paid, refunded, forfeited, transferred, and untransferred), while the read firewall blanket-denied the likely Advance Deposit/report surfaces. That guard correctly protected against posting, refunding, forfeiting, transferring, credential exposure, and export actions, but it was not evidence of role denial or evidence that no read-only route existed. Infor's Advance Deposit surface mixes reads and writes, and Property Ledger Deposit Ledger Detail is date-scoped; a captured 200 response still needs exact parent/date/row binding before it can support a target stay. Treat the required fact, allowed operation policy, and verification proof as separate decisions.

Because the guard stopped exploration before a clean Advance Deposit navigation, no role-denial video or authorization response was captured. The honest state is therefore **unproven source/role access**, not `EXTERNAL_ROLE_GATE` and not a deposit-positive result.

## Guidance

### Session and soft-open order

1. **Warm with `BSSTRT`** before targeting any feature shell.
2. **Open the TARGET function early** on a clean session—before navigating menus that load unrelated overlays. Menu pollution causes entitled surfaces to return **813 stubs** on later probes.
3. Treat **813 ≠ role denial** by default; retry on a clean warm → early-open path before escalating credentials.

*Example surfaces:* quote availability (`OSRRAV`), group blocks (`GSGRPB`), organization profiles (`FSOGPF`), tax invoices (`OSTXIV`).

### Harvest function codes from live UI, then soft-open

1. Drive the **documented menu path** (Exa/Infor playbook when needed).
2. Capture **XHR** from real clicks; record `.HDR`, `.LST`, tab suffixes (`.BPF`, `.TRC`, `.NOT`, `.FOL`).
3. **Soft-open harvested names**—do not invent codes from naming guesses alone.

### Guest Stay children need stay keys after search

- Bare `OSRESS.LST` without search context yields empty/minimal payloads—wrong path.
- Run **`OSRESS.search`** with the property dataspy (e.g. **1941** for stay grid), then POST child calls with **stay/reservation keys** from the search result.
- Prefer harvested tab codes (`OSRESV.FOL` / `OSRESV.TRC` / `OSRESV.NOT`) over stale guesses.

### Contract, policy, and proof are separate gates

For every required field, record three independent decisions before implementation:

1. **Business contract:** what fact is needed, and what corpus evidence makes it useful?
2. **Allowed surface policy:** which inspection actions are permitted, and which save/post/refund/transfer/credential/email/print/export actions remain denied?
3. **Verification proof:** what navigation, request/response, role result, parent identifier, date scope, and row-level checks establish that the source is valid?

Do not use a conservative policy denial as evidence that the role cannot reach a screen. If access is suspected to be denied, navigate or capture the authorization response on a clean session and preserve the role-proof evidence. If a returned aggregate row cannot bind to the requested reservation/stay and scope, return the evidence as unavailable rather than treating a 200 response as a positive.

For deposit facts specifically, a safe read contract may inspect an approved Deposit Ledger Detail route while continuing to deny Deposit, Refund, Forfeit, To Guest Ledger, save/post, transfer, credential, email, print, and export actions. This is a route-and-row proof to pursue, not permission to execute mixed-screen mutations.

### Stagehand is discovery by default; standalone quote is an explicit exception

Stagehand/model-assisted browser actions are useful for locating menus, tabs, popups, owner surfaces, and request shapes. They do not by themselves prove reservation identity, stateful session semantics, accounting meaning, role denial, or row binding. After discovery, promote only a deterministic adapter with explicit session serialization, native payload preservation, opaque-ID binding, bounded continuation, and fail-closed unknowns. Keep the model out of normal read calls so behavior is repeatable, reviewable, and cheap.

The 2026-09-17 standalone fetch-quote plan is a bounded live-first exception for one quote tool: Stagehand v4 code mode with the approved Azure GPT-6 Astra runtime may navigate and extract the client-required **Hotel Availability** screen after deterministic login and CDP handoff. That path deliberately does not inherit the legacy request allowlist, unknown-request teardown, OSRRAV quote search, or promotion ceremony. It still must inspect the painted screen, applied adult/child/age criteria, prices and displayed terms, and must never Reserve or mutate PMS state. This exception does not change the default for other tools.

### Packaging ≠ payload (DONE definition)

- **DONE** requires **`allRequiredPass` per DoD section** in compare artifacts—section by section—plus packaging video or mailProof where required.
- Retained videos, synthetic mailProof, or partial compares do **not** close a tool if any required section is red.
- Refresh packaging compares when payload scope expands.

### Invent-forbid fields (honest unavailable)

- Mark a DoD field **invent-forbidden** only when **dumps prove absence** across relevant shells/tabs—and **cite** the evidence.
- **Amend DoD contracts** when invent-forbid is justified; do not synthesize enum values to green a compare.

### Live mail digest beats synthetic packaging (documents)

- For existing-attachment read proof, prefer **live mailbox path**: DB grant + S3 GetObject producing a real digest.
- Synthetic mailProof is fine for parser fixtures; it does not supersede live digest when DoD demands live proof.

### Channel parsers (mail)

- Expand channel coverage with **fixtures that match patterns already implemented** in the parser; extend tests/compare, not one-off hacks.
- Run Vitest with **`unset DATABASE_URL`** (and no pilot-RDS escape hatches).

### Request policy and DETAIL_DUMP chrome

- Detail dumps may issue **unallowlisted chrome image GETs**. Blocked requests surface as **`POLICY_BLOCK`**, masking real reservation payload work.
- **Extend the chrome allowlist** from **observed paths**, then re-run.
- Distinguish **policy block** (fix allowlist) from **security rights 203** (entitlement).

### Escalation ladder before EXTERNAL_ROLE_GATE

1. **Exa / Infor playbook** — official menu paths.
2. **UI click-harvest** — authoritative function codes.
3. **Soft-open on clean session** — disprove 813-as-role.
4. **Role-proof** — structured evidence of operator class.
5. **Vault alternate users** — when discovery is permitted.

**EXTERNAL_ROLE_GATE** is terminal when: menu surface **absent**, corpus **unowned**, POPU child blocked by **security rights** after clean open, or alternates **exhausted**.

### Absence-proof and 203 as RCA input

- Absence in dump and 203 messages inform root cause; they are **not** success criteria.
- Use them to choose invent-forbid + DoD amend, EXTERNAL_ROLE_GATE, or infra fix—not to mark payload green.

### Deposit-source example

- Corpus demand can justify returning deposit due/paid/refund status, but it does not prove a particular screen is safe or role-authorized.
- Infor documentation makes Advance Deposit a mixed read/write surface and Property Ledger Deposit Ledger Detail a date-scoped ledger; the current read guard may therefore deny mutation actions without denying every inspection route.
- A live ledger response that contains transfers or lacks the target confirmation is a source-viability lead, not a deposit-positive result. Require exact stay/parent, property/date, and row binding before promotion.

## Why This Matters

Without this ordering, teams burn cycles on **credential escalation** when the session was **polluted**, or on **invented function codes** when **harvest + soft-open** would succeed. Marking tools DONE from **packaging alone** creates false HITL sign-off. Misclassifying **true entitlement gaps** as probe bugs delays legitimate EXTERNAL_ROLE_GATE decisions. Policy blocks on chrome requests hide real DETAIL_DUMP progress until allowlists match reality.

## When to Apply

- Implementing or verifying HMS live-read tools in `server-pilot` / Centurion dashboard payloads.
- Interpreting **813, 400, 203, POLICY_BLOCK** during overlay probes.
- Writing or reviewing Wave-style DoD compares.
- Deciding between payload work, DoD amend (invent-forbid), and EXTERNAL_ROLE_GATE.
- Extending mail channel parsers or live document digest proof paths.
- A required field is sourced from a screen that mixes inspection with mutation actions.
- A model-assisted browser prototype is being converted into deterministic normal execution.

## Examples

### Soft-open order

| Before | After |
|--------|--------|
| Open menus first; probe target → 813 stub | `BSSTRT` warm → early target soft-open → real shell |
| Assume 813 = insufficient role | Retry clean early-open; escalate only after harvest + soft-open + proof |

### Harvest then open

| Before | After |
|--------|--------|
| Guess org/group/quote codes | Harvest from Profiles / Group Booking / Availability paths; soft-open those codes |
| Quote search without room types | Hotel Availability screen with applied adult/child/age criteria → displayed rates and terms; OSRRAV remains legacy |

### Guest Stay children

| Before | After |
|--------|--------|
| List-only Guest Stay → tiny payload | `OSRESS.search` → keys → folio / traces / notes children |
| Wrong tab code guesses → 400 | Harvested tab function names |

### Packaging vs payload

| Before | After |
|--------|--------|
| Video PASS + missing required section | Dump that section → `allRequiredPass` |
| Synthetic mailProof only (when live required) | Live digest compare |

### Invent-forbid vs gate

| Before | After |
|--------|--------|
| Map catalogue field names with no dump keys | Dump cite → invent-forbid + DoD amend |
| Rate Details / Events / corpus still unreachable after escalation | EXTERNAL_ROLE_GATE packet |

### Contract mismatch

| Before | After |
|--------|-------|
| Require deposit facts, blanket-deny Advance Deposit, conclude the PMS cannot provide them | Keep mutation/credential/export bans; investigate an observed read-only ledger route with role, date, parent, and row proof |
| `response.status == 200` → accept deposit total | Reject unbound, out-of-scope, or transfer-only rows; expose only bound evidence or an honest unavailable state |

### Discovery-to-execution boundary

| Before | After |
|--------|-------|
| Stagehand click success is treated as a complete tool | Stagehand finds the route; deterministic Playwright/PMS code owns normal calls and evidence checks |
| Model retries until a plausible row appears | Bind opaque IDs, serialize stateful calls, bound continuation, and fail closed on ambiguity |

### DETAIL_DUMP policy

| Before | After |
|--------|--------|
| DETAIL_DUMP fails POLICY_BLOCK on chrome GET | Allowlist observed chrome paths → dump greens |
| POPU still security-rights after clean HDR | EXTERNAL_ROLE_GATE (entitlement), not more allowlist |

## Related

- Packaging vs payload (find/`claimKeys`): [hms-live-proof-packaging-vs-payload-completeness.md](./hms-live-proof-packaging-vs-payload-completeness.md)
- Full Wave A three-gates playbook (incl. UI-first HITL video): [hms-wave-a-read-tool-proof-three-gates-playbook.md](./hms-wave-a-read-tool-proof-three-gates-playbook.md)
- UI-first Playwright recorder build (vs soft-XHR camera): [hms-hitl-ui-first-playwright-recorder-build.md](./hms-hitl-ui-first-playwright-recorder-build.md)
- Live OSRESS GRIDRESULT parse: [live-osress-gridresult-parse-canary-row-ok.md](../integration-issues/live-osress-gridresult-parse-canary-row-ok.md)
- Live-negative six-proof gate: [live-negative-result-verification-gate.md](../conventions/live-negative-result-verification-gate.md)
- Wave A HITL board: `docs/superpowers/plans/handoff-reports/2026-09-12-wave-a-batch-hitl.md`
- DoD contracts: `docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md`
- Private ledger (ops): `.private/wave-a-20260912/PROGRESS.md`
- Pilot RDS safety: unset `DATABASE_URL` / never Vitest against pilot production DB
- Read-tool evidence contract: required facts, allowed actions, binding, scope, and proof must agree before promotion.
- Stagehand/model-assisted browser discovery is reconnaissance; deterministic adapters own normal execution.
- Infor HMS documentation: [Advance Deposit](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571674.html), [Guest Stay deposit fields](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573093.html), [Property Ledger Deposit Ledger Detail](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579271.html), and [Folio deposit transfer warning](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861-2.html)

## Gold-fact pack: OSRESS.search session budget (2026-09-14)

**Symptom:** Standalone `OSRESS.search` returns `pageData`, but a long pack loop returns **813B `loadLocalizedPage`** after a handful of searches (often ~3–4). Mid-session `BSSTRT` rewarm can destroy the Playwright execution context.

**Fix:** Recycle **full browser context + login + BSSTRT** every N searches (default 3). Cap find tries per case. Do **not** clear reusable group LST dumps on recycle. Soft-open folio/OSRESV children on a **fresh login** after find (same 813 poison otherwise).

**Evidence:** gold-fact-backtest-29 live run — 23/23 find `pagedata`, folio `ok` after before_folio recycle; wall ~10 min with ~15 login cycles vs ~44 when groupCache was cleared each recycle.

## Gold-fact: fresh browser per tool + parallel cases (2026-09-14)

**Model:** Each HMS tool call = new Chromium → login → BSSTRT → one tool → close. Never reuse browser/context across tools (matches production tool seam). Cases fan out with a pool (`HMS_GOLD_FACT_PARALLEL`, default 8).

**Timing (n=29, parallel=8):** wall **~5.9 min**; **54** fresh browser logins (sum login CPU ~39 min). Serial recycle-session run was ~10–15 min wall with fewer logins but wrong reuse model.

**Tradeoff:** Concurrent logins can lower find `pageData` / group hit rate vs serial fresh browsers. Prefer parallel for wall clock; dial concurrency down if envelope rate drops.

### Parallel cases + single HMS credential

Eight concurrent Chromium logins as the **same** Infor read user produce sibling-session stomps: fresh browser still gets **813 `loadLocalized`** (~70ms). Fix: keep fresh-browser-per-tool, but **serialize** `withFreshHmsTool` on one process mutex; classify 813 as `loadLocalized` (never `not_found`); optional one retry. Case pool may stay >1 for offline mail overlap; HMS wall ≈ serial login sum.

## Gold-fact: parallel without mutex? (2026-09-14)

**Question:** Is `PARALLEL=8` useful under mutex? Can multi-tab / one-session parallel beat login tax?

**Verdict:**

| Approach | Wall | Correct? | Notes |
|---|---|---|---|
| Fresh/tool + PARALLEL=8 **no mutex** | ~6 min | **No** | Same-user login stampede → 813 |
| Fresh/tool + mutex | ~serial login sum | Yes | PARALLEL ≈ useless for HMS wall |
| Multi-tab concurrent same context | (unproven / high risk) | Likely no | Tabs **share cookies** = one SSO session; concurrent soft-open races server state |
| **Staff reuse: one login, serial tools, recycle every ~3 searches** | ~10–15 min / 29 | Yes | Matches how humans work; kills ~40s×N login tax |

**Why tabs ≠ free parallel:** Playwright pages in one context share cookies ([auth docs](https://playwright.dev/docs/auth)). Infor/Lawson SSO binds a unique session id to the browser ([session management](https://docs.infor.com/lsf/10.0/en-us/lsfibmiolh/lsftaarg/ito1546285704330.html)). Portal “tabbed browsing” is UI forms in **one** session, not N independent soft-opens. Production runtime already uses `createBoundedSessionLock` (one session). Live Infor also rejects dual-context `storageState` handoff (`AUTH_STATE_NOT_PORTABLE` / AUTH_FAILED) — cookie clone ≠ portable authenticated shell.

**True parallel without mutex:** only with **N distinct HMS read accounts** (Playwright: one account per worker when server-side session conflicts).

**Pack default:** `HMS_GOLD_FACT_SESSION_MODE=reuse` (staff model). `fresh` kept for tool-seam parity experiments. Reuse forces `PARALLEL=1`.

**Evidence already in hand:** recycle-session 29 ~10 min / ~15 logins / pageData OK; unlocked parallel 5.9 min / 54 logins / 14×813; locked parallel n=8 ~9 min / correct. Net: drop concurrent browsers; reuse session.

## Gold-fact: concurrent context.request (not tabs) (2026-09-14)

Live probe `hms-tab-parallel-probe.mjs` on pilot EC2 (one login, digests only):

| Arm | Result |
|---|---|
| Serial `page.evaluate` OSRESS.search | OK until ~5–6 then 813 (search budget) |
| **Concurrent `context.request` N=4** | **4/4 pageData**, wall ~2.1s |
| **Concurrent `context.request` N=8** | **8/8 pageData**, wall **~0.9s**, session still healthy after |
| Concurrent **N tabs** `page.evaluate` (goto COMMON) | **0/4 pageData**, all 813, **poisons** shared session |

**Scale path:** one Chromium + login once → fan OSRESS.find with Playwright `browserContext.request` (shared cookies) → keep folio/notes soft-opens serial on the page. Multi-tab UI fan-out rejected. Runner: reuse mode uses `liveFindRequest`; case `PARALLEL` may exceed 1.

**Smoke (CASE_LIMIT=8, PARALLEL=8, reuse+request):** wall **~86s**, login_cycles **2**, find pageData **6/6** attempted (hits depend on candidate quality). Vs prior fresh+mutex n=8 ~**539s**.

**Full live pack (n=29, PARALLEL=8, reuse+context.request, 2026-09-14T17:26Z):**
- wall **508.6s (~8.5 min)** — `TIME_WALL_SEC=509`
- login_cycles **11**, login_ms sum ~430s (recycles still dominate wall)
- find: **20/23 pageData** via `context.request`, **0×813**; hits 6 (candidate quality)
- vs serial ~10–15 min baseline → modest win
- vs fresh+mutex correct path for 29 (projected ~30–40 min from n=8@539s) → **~4× faster**
- vs unlocked parallel 5.9 min → slower but **correct** (no stampede)

### Multi-x breakthrough (2026-09-14T17:42Z)

**RCA:** all 11 poison recycles came from `hms_group_block_read` page.evaluate stubs (813) treated as session death — not from finds.

**Fix (industry pattern = login once, HTTP fan-out with cookies):**
1. Soft-open 813 → mismatch only (**no SSO recycle**)
2. Group/folio/notes via `context.request`; **one pack-cached GSGRPB**
3. Finds stay concurrent `context.request`

**Measured live n=29 PARALLEL=8:** wall **85.4s (~1.4 min)**, login_cycles **2**, find pageData **16**, recycles **1**.
- vs ~10 min serial → **~7×**
- vs prior reuse run 509s → **~6×**

External pattern refs: Playwright auth reuse + `APIRequestContext` cookie jar (https://playwright.dev/docs/auth , https://playwright.dev/docs/api/class-apirequestcontext); hybrid browser-login + concurrent HTTP (common scraping pattern).
