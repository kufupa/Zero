# Centurion PMS tools — robust catalogue + Wave 0 find completion

Date: 2026-09-11.
Type: feat / programme plan.
**Supersedes execution of** `2026-09-11-fast-live-find-reservation-video.md` for anything beyond packaging video (that plan's packaging gate landed; payload gate did not). Keep that file historical.
**Inventory source (do not redesign schemas):** `2026-09-11-write-tools-kickoff-from-3949-gold.md`, Astra 12-read catalogue, 3949 pending-write rank.
**Process learning:** `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md`.

**Execution posture:** `/autonomous-plan` + Zero overlay. Find HITL (Wave 0 + 0b) **human-passed 2026-09-12**. **Wave A Wave-0 repair complete 2026-09-12** — batch HITL rewritten at Wave-0 grade (ready for human sign-off). Prior skip-packet “HITL” remains non-material. Do **not** start Wave B until the rewritten HITL is signed.

**HITL policy (binding):** human review only at **wave boundaries**, not between tools inside a wave. Inside a wave: agent runs full autonomous chain (contract → fixture → packaging + payload gates → video per tool) with **no pause**. After the wave finishes, human reviews **all** that wave’s videos + result JSON in one batch. Exception: write **execute** still needs proposal approve (mutation safety) — that is not Tool promotion HITL.

**PMS exploration (binding):** agent **always** iterates on live Centurion HMS (EC2 + overlays + SSM + soft capture scripts + MCP/docs as needed). Soft overlay proofs that worked for find/A1 are **first-class**. Do not wait for human “permission to click HMS.”

---

## Goal Capsule

1. **Catalogue now:** freeze the full reservationist tool set (existing reads + 2 new reads + ranked writes) with IDs, order, effect (read/write), and **binding evidence-cited DoD** per tool in `2026-09-11-centurion-pms-tools-dod-contracts.md` — so Wave A/B can run zero-shot after wave HITL without re-planning schemas.
2. **Wave 0:** `hms_find_reservation` **exact** confirm/ext path — Sep-07 `ReservationMatch` field-complete (no `label` sentinel poison; no invented GRID keys). Live dump → compare → video.
3. **Wave 0b (same tool, before Wave A):** live **surname+dates** search axis + honest `matchCount`/`ambiguous` — only filter aliases proved on OSRESS dataspy dump (today: lastname family). Firstname search only if dump proves a firstname filter.
4. **After find HITL (0+0b):** **Wave A** (all remaining reads) full auton → batch HITL. Then **Wave B** (writes) + per-write execute approve.

Non-goals for Wave 0/0b: Nava deploy/restart; promoting `productionActiveReadToolIds`; building folio/quote/docs/writes; firstname-only lookup; redesigning existing read IDs.

---

## Planning method (research verdict — follow this)

**Question asked:** plan everything now, then build; or build find to 100% then invent the rest?

**Verdict: catalogue + contracts now; elaborate implementation one tool at a time (rolling wave). Do not wait until find is perfect to name the rest. Do not fake task-level precision for Wave C.**

| Layer | Plan depth now | Elaborate when |
|---|---|---|
| Tool ID, effect, build order, HITL rules, out-of-scope | **Full now** | Only if gold evidence contradicts |
| Payload contract stub (required / allowed-null / forbidden sentinel / owner surface) | **Evidence-cited DoD now** in `…-dod-contracts.md`; amend only when live dump contradicts | At tool start if dump ≠ contract; never invent keys |
| Implementation tasks, selectors, EC2 recipes | **Wave 0 only** in detail | Next wave after wave-boundary HITL |

Why (evidence):

- Local failure mode: packaging-complete plan + optimistic fixtures → false green (`guestName="-1"`). Catalogue absence was not the bug; **missing payload gate** was. Scoping later tools does not fix find — but **not** scoping them forces another planning session and invites order mistakes (420 cancel-first).
- Rolling wave / progressive elaboration: near-term detailed, future summary — [PMBOK-style rolling wave](https://projectmanagementformula.com/rolling-wave-planning-in-project-management/). Later phases depend on live discoveries (dataspy keys, role menus).
- Contract-first: freeze IDs and observation shapes before code; amend contract when live dump contradicts aspirational catalogue — [API-first / contract-first](https://www.digitalapplied.com/blog/api-first-development-microservices-architecture-guide).
- Smoke ≠ acceptance: packaging (auth/video/exit) is smoke; field contract + human review is acceptance — [smoke vs acceptance](https://betterqa.co/smoke-testing-sanity-acceptance-testing-qa-guide/).

**Counter-position rejected:** “only plan the next tool.” Rejected because 3949 already ranked the set; kickoff already exists; waiting re-opens cancel-first / invent-schema risk. Keep inventory frozen; keep task detail rolling.

---

## Global Constraints

- PMS **reads** are `view_only`. Writes use inert proposal → human approve → execute → reread. Timeout ≠ retry charge/book/send/upload.
- **No redesign** of existing TS read IDs / sealed registry shapes unless a Payload gate proves the contract wrong — then amend contract + tests, do not silently invent fields.
- No Vitest against `nava-zero-mail-pilot`. Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never `VITEST_ALLOW_PILOT_RDS=1`.
- Secrets, cookies, DB URLs out of Git / SSM / CI. Client PII in `.private/` mode 0600 only.
- One live PMS browser per property lock. Prefer overlay/S3 proof path; no isolated EC2 checksum theater; no Luna-as-done-gate.
- **Packaging gate ≠ Payload gate ≠ wave-boundary Tool promotion HITL.** Per tool inside a wave: packaging + payload required before that tool counts done. Human HITL only when the **wave** is complete (or Wave 0’s single tool).
- Do not start Wave A while **find HITL (Wave 0 + 0b)** is unsigned. Do not start Wave B while Wave A batch HITL is unsigned.
- **Live surface / dataspy dump before required fields (binding — every tool, every wave):** see next section. Never invent GRID keys, filter aliases, or detail fields from catalogue marketing alone.

---

## Live surface / dataspy dump (binding — all tools, all waves)

**OSRESS** = Infor Guest Stay **list/search** system function. Live POST path is `/web/base/OSRESS.search` with `GRID_NAME: OSRESS` (dataspy **1941** on this tenant). Search-grid JSON keys and MADDON filter aliases come from that surface — not from Guest Stay **detail**, Folio, Documents, etc. Each tool has its **own** owner surface; dump **that** surface.

### Rule (always, not only Wave 0)

Before a field or search axis is **required** in a tool DoD / compare oracle:

1. Capture a **same-run live dump** of the owner surface (GRID `DATA[0]` / filter scaffold / detail network body / list API / mail bytes — whatever that tool owns).
2. Required fields ⊆ keys/filters **actually present** on that dump.
3. Catalogue / Infor docs / demand ranks may **suggest** fields; they do **not** force required.
4. If dump omits a hoped-for key: **amend DoD** (allowed-null, move to owner tool, or `SURFACE_UNPROVEN` / `BLOCKED_*`) — **stop hunting**. ≤5 RCA then escalate.
5. Unit fixtures must be cut from live dump shapes — never invent `roomtype`/`rateplan`/firstname-filter/etc. because a test wanted them.
6. Search axes (confirm / external / surname+dates / …): only fill filter aliases proved on **this** dataspy/scaffold; do not assume UI labels ≡ posted alias names.

### Capture Infor intel for later (binding — every tool build)

While building **each** tool, treat the live session as a research pass, not only a pass/fail proof. Persist durable notes (private dump + short plan/companion addendum or `docs/solutions/` when non-obvious) so the **next** tool does not re-discover from scratch.

**Always note when observed** (sanitize PII before Git):

| Capture | Why later tools need it |
|---|---|
| Owner surface id/path (e.g. OSRESS.search, Folio tab, Documents, Rate Details) | Correct oracle; no cross-surface reuse |
| Dataspy / GRID name / function codes | Same tenant search/list shape |
| Posted filter aliases + operators (MADDON / form fields) | Search axes without inventing keys |
| Response / GRID / detail **key inventory** (present vs absent) | Required vs allowed-null DoD |
| Sentinel / empty / masked patterns (`"-1"`, blank, VVIP mask) | Forbidden display values |
| Denied / mutate controls visible on screen | Keep `view_only`; write proposal scope |
| Role / menu missing → blocker code | Honest `BLOCKED_*` / `ROLE_UNAVAILABLE` |
| Version hints (Infor help URL path vs tenant build) | Docs ≠ installed hotel |
| Selectors / network URLs that worked (private) | Next proof run / sibling tools |
| Cross-links (“rate lives on Rate Details, not GRID”) | Find vs read ownership |

Dataspy is **one** instance of this rule (find/search). Folio, Documents, Group Block, Rate Details, etc. get the **same** capture discipline on their own surfaces.

Worked examples:

| Hope | Live dump | Action |
|---|---|---|
| Find claims `ratePlan` | OSRESS GRID has no `rateplan` | Out of find; Wave A `hms_read_reservation` |
| Find `label` from `primaryguest` | dataspy 1941 often `"-1"`; name in `lastname`/`firstname` | Compose; never require truthy sentinel |
| Surname search | Body has `lastname_filter` (+ lastname aliases), not `firstname` filter | Wave 0b = surname+dates; firstname filter only after dump proves it |

Private dumps stay under `.private/`; sanitized fixtures may land in tests. Learning: [`docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md`](../solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md).

---

## Overnight Autonomous Execution Mandate

**User granted full autonomy for Wave A** (2026-09-12; find HITL 0+0b signed). **Reopened same day:** human refused Wave A sign-off — skip packets ≠ working PMS tools. Agent must finish A1–A11 at **Wave 0 quality** with no mid-wave human pause. Stop only for a **Wave-0-grade** Wave A batch HITL packet **or** a true blocker after live RCA. Do **not** start Wave B.

Wave 0 + 0b find work is **done** (live compare green + human video pass). Do not redo unless a Wave A tool regresses find. **A1 detail dump PASS_CORE_STAY is scaffolding only** until production `readContext` uses detail dump (not grid-row fake-available).

### Wave-0 quality bar (binding — supersedes skip-as-done)

For **each** A1–A11 tool, same loop as find:

```text
implement/wire → unit (live-faithful) → live HMS dump on EC2 → sanitize fixture
→ oracle + result + compare.v1 (required fields) → packaging video → RCA ≤5 → green
```

**Forbidden as “done”:**

- Writing `BLOCKED_*` / `SURFACE_UNPROVEN` skip JSON **without** a fresh live attempt + dump/RCA on Centurion this wave
- Treating expired `/etc/nava/hms-read-role-proof.v1.json` as a stop (A1 soft overlays already proved live work without it)
- Claiming unit-green drivers = Wave A complete
- Offering HITL for tools that never got compare green

**Allowed honest terminal (rare):** after **live** menu/dump proves surface absent or invent-forbidden (e.g. CON/BLK math), ship `BLOCKED_*` with that dump cited — still listed in HITL. Mail-only tools (A10/A11) use mail/knowledge oracle instead of PMS video, but still need fixture + compare.

### Role-proof — what it is (agent owns this)

**Not** “ask hotel admin for a new password.” HMS login already on EC2.

| Artifact | Meaning | Who |
|---|---|---|
| Role-proof **v1** | JSON at `/etc/nava/hms-read-role-proof.v1.json`: property + `allowedSurfaces` + denied mutations + TTL | Agent can **restage/extend** via SSM (root-owned `0444`); currently Guest Stay–only and **expired** — agent must renew or bypass via soft overlay like A1 |
| Role-proof **v2** | Per-tool attestation (`operator_observed_runtime`) under release `role-proofs/<toolId>.v2.json`: binds tool + surfaces (`folio`, `room_type_rate_availability`, …) + HMAC digests from live observation | Agent **mints after observing** menus/surfaces on live HMS (see Phase B handoff Aug-06). Uses evidence HMAC on box — **not** a human click in Cursor |
| Soft overlay proof | Wave 0 / A1 path: overlay dist + `HMS_PROOF_*` env; may run with `allowUnstarted` / soft finalize | **Preferred** for Wave A packaging until v2 release materialize; **do not** refuse live work waiting for v2 |

**Rule:** missing/expired role-proof ⇒ **agent fixes attestation or uses soft path**, then continues live dump. Never park tool as “human must refresh role proof” without trying soft path + mint.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Decision authority

- Choose best safe reversible option without asking.
- Better route to Wave 0 payload+video may be taken; log what changed and why.
- Preserve requirements. Do not silently cut Payload gate or wave-boundary HITL.
- Use standard non-fast subagents only; otherwise work inline.
- If live GRID proves `roomType` absent on dataspy 1941: find `roomType` allowed-null + honest unresolved. **`ratePlan` is never a find claim** (Sep-07: rates section of `hms_read_reservation`). Do not invent GRID keys. Map adapter `guestName` → public find `label`; never require flat `guestName` on the public find contract.

### RCA loop

FAIL → reproduce minimally → root cause at file:line → research unfamiliar behavior when useful → smallest correct fix → test → resume. Symptom patches and “user can finish later” are not completion.

### Safety

Follow repository rules and Zero overlay. Never force-push protected branches, bypass hooks, use destructive git, expose secrets/PII, or weaken safety guards.

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

Tests requiring databases use disposable non-production databases only. Pilot verification: read-only SQL/API, health, or purpose-built non-test scripts.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) — **not** for Vitest |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Live proof | Overlay / SSM / private `.private/` — prefer **no** ops-deploy/restart; **always** use live HMS for dumps |

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds in Git, Vitest pointed at pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into a test process.

### Cursor execution-backend flake

Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.` Playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`. Backoff-retry; do not invent app RCA.

### Verification loop

Implement → focused tests (live-faithful fixture) → live run → **oracle capture → compare.v1.json (required fields)** → packaging video → RCA until compare green → stop for wave-boundary HITL.

### Done criteria (autonomous Wave 0) — COMPLETE 2026-09-11/12

- [x] `hms_find_reservation` payload contract written and checked into this plan §Wave 0
- [x] Failing-then-passing unit tests for `primaryguest: "-1"` → composed guest name
- [x] Sanitized live GRIDRESULT fixture committed (keys + sentinel patterns; PII redacted)
- [x] `claimKeys` / `unresolvedFields` honest (no claim of sentinel/null junk)
- [x] Live run: Packaging gate green (`view_only`, video, digests)
- [x] Live run: `oracle.v1.json` + `result.v1.json` + **`compare.v1.json` all-required-pass** (expected-vs-actual loop)
- [x] Private evidence under `.private/hms-find-reservation-live-YYYYMMDD/` + git-safe handoff
- [x] Find HITL (0+0b) packet ready + **human video pass 2026-09-12**
- [x] No unresolved blocker affecting Wave 0 goal

### Done criteria (autonomous Wave A) — REOPENED 2026-09-12

Prior skip-packet completion **revoked**. 2026-09-12 handoff rewritten to Wave-0-grade evidence (`docs/superpowers/plans/handoff-reports/2026-09-12-wave-a-batch-hitl.md` — **READY FOR HUMAN SIGN-OFF**).

Repair order (Wave-0 depth each; soft overlay OK):

1. **A1** — wire `detailDumpFor` / live detail into production `readContext`; core/stay compare from detail not grid; rates/policies/ops stay unavailable until Rate Details dump
2. **A9** — replace Notes/Traces stub; open tabs from Guest Stay detail; dump → compare
3. **A2** — live folio **balance** soft proof (OSRESS/`foliobalance`); deposits stay blocked only after live deposit-scope RCA
4. **A5** — live OSRRAV soft capture (deny CRS); nightly compare
5. **A3/A4** — mail compare packets + HMS docs dump if menu exists
6. **A10** — bind available property corpus or prove none after search (agent searches; human only if no docs exist anywhere)
7. **A11** — implement `mail_parse_channel_payload` + channel_fw fixture compare (greenfield OK)
8. **A6/A7/A8** — live menu probe first; BLOCKED only with **this-wave** dump citing missing surface

Checklist:

- [x] Each A1–A11 tool: Wave-0 loop green (`compare.v1` + packaging/mail proof) **or** this-wave live-cited `BLOCKED_*` after ≤5 RCA
- [x] A1 production path uses detail dump for core/stay (not grid-row false available)
- [x] Role-proof v1 renewed and/or soft path used; v2 minted per tool when promoting release — **agent-owned**, not a human gate
- [x] Per-tool private evidence under `.private/wave-a-*/` (video/mail + result/oracle/compare) — skip JSON alone insufficient
- [x] Wave A batch HITL packet rewritten listing **only** Wave-0-grade evidence (replace DRAFT)
- [x] Wave B **not** started
- [x] No unresolved agent-fixable gap parked as “needs human”

### True blockers

Stop only for missing credentials/access that cannot be obtained safely (e.g. HMS password vault empty), required human-only interaction (**wave-boundary HITL after green tools**, write execute approve), destructive ambiguity, safety-policy conflict, or external outage that prevents required proof.

**Not true blockers:** expired role-proof file, missing v2 attestation, “scared of live PMS,” stub driver, unit tests green, prior skip packets.

## Execution Mode

Autonomous for **Wave A repair (Wave-0 quality)**. Resume A1 production wiring then A9→A2→A5→…. After Wave-0-grade HITL packet ready, **end autonomous run** and wait for human sign-off before Wave B. REQUIRED SUB-SKILL: superpowers:subagent-driven-development + TDD for parser/claim fixes.

`/goal` text for operators:

> Repair Wave A of `docs/superpowers/plans/2026-09-11-centurion-pms-tools-robust-catalogue.md` under Overnight Autonomous Execution Mandate at Wave-0 quality (live PMS iterate per tool). Do not treat 2026-09-12 skip packets as done. Do not start Wave B.

---

## Universal checklist

### Per tool (automated; no human pause inside wave)

**All boxes required before that tool counts done.**

1. **Contract** — ID, effect, owner surface, required / allowed-null / forbidden sentinels, non-goals
2. **Fixtures + unit** — recorded live (or mail) fixture; happy + sentinel/missing-key; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`
3. **Packaging gate** — auth/lock; `view_only` or audited write; private video (or mail proof); digests; fail closed on mutation
4. **Payload gate** — assert `result.v1.json` vs contract; honest `claimKeys` / `unresolvedFields`
5. **Expected-vs-actual loop** (§ below) — **mandatory**. Packaging alone is never done.

### Wave-boundary Tool promotion HITL (human; only here)

After **entire wave** completes (Wave 0 = one tool; Wave A = all remaining reads; Wave B = all writes’ proof packets):

- [ ] Batch-watch every tool video (or mail proof) in the wave
- [ ] Spot-check result JSON (agent already passed expected-vs-actual; human catches judgment / UX / “looks wrong”)
- [ ] Explicit sign-off before next wave starts

**Not** Tool promotion HITL: write **proposal → execute** approve (still required per write for mutation safety).

---

## Autonomous expected-vs-actual loop (binding — all waves)

This is what human does in the video, done **programmatically** before the wave HITL packet. Same loop Codex→Cursor used for packaging, extended to **payload truth**. Without this step, tool is not done — even if `PROOF_EXIT=0` and video exists.

### Loop (per tool, max 5 RCA cycles then escalate)

```
1. CONTRACT   — freeze expected fields + forbidden sentinels + allowed nulls for THIS tool
2. ORACLE     — capture independent live ground truth for the same probe
              Reads: OSRESS/GRID JSON and/or detail network body and/or visible row text
              Mail: raw artifact bytes / parsed headers
              Writes: HMS state AFTER execute via authoritative reread tool
3. RUN        — invoke tool with real candidate (confirmation/external/ref) on live property
4. COMPARE    — result.v1.json vs ORACLE vs CONTRACT
              Pass only if: required fields match oracle, no forbidden sentinels,
              claimKeys honest, status/draftReady consistent
5. FAIL?     — RCA at file:line → smallest fix → unit test from failing oracle fixture → re-RUN
6. PASS       — keep private video + result + oracle dump + compare table; next tool in wave
```

### Oracle rules (do not cheat)

| Do | Do not |
|---|---|
| Prefer **network/GRID JSON** captured on the same run as tool output | Assert only that UI “loaded” |
| Prefer **exact candidate** already known on property | Invent GRID keys absent from oracle |
| **Dump owner surface first** (OSRESS vs detail vs folio vs …) — required ⊆ dump | Reuse find GRID dump as oracle for a different tool |
| Normalize dates/status enums before compare | Treat packaging digests as payload proof |
| Redact PII in committed fixtures; keep full oracle under `.private/` | Auto-update golden on CI fail without RCA |
| On write: reread with Wave A read tool as oracle | Trust write acknowledgment alone |

### Video role

- **Agent:** video = packaging evidence + human batch review artifact. Agent’s pass/fail is **COMPARE**, not “I watched the video.”
- **Human (wave boundary):** watch video to confirm right screen, no mutation, and that oracle↔result story matches what eyes see.
- Pattern matches Playwright guidance: UI/video evidence separate from API/contract assertions ([Playwright API testing](https://playwright.dev/docs/api-testing), [Playwright videos](https://playwright.dev/docs/videos)); hybrid schema+invariants+selective golden ([schema vs snapshot](https://dev.tools/blog/schema-vs-snapshot-testing-for-apis-what-actually-works-in-ci/)).

### Proof script requirement

Every live tool proof must emit machine-checkable artifacts:

- `oracle.v1.json` — sanitized/private ground truth
- `result.v1.json` — tool output
- `compare.v1.json` — `{field, expected, actual, pass}` rows; **exit non-zero if any required row fails**
- `video.webm` — human evidence

`PHASE_A_PROOF_READY` / wave-tool-done **requires** `compare.v1.json` all-required-pass. Soft packaging without compare = incomplete.

### Escalation

After 5 RCA cycles on same tool without COMPARE green → true blocker in handoff (oracle ambiguity, PMS outage, role menu missing). Do not skip to next tool pretending done.

---

## Full catalogue (scoped now)

### Keep as-is (already in TS — do not redesign IDs)

From `READ_TOOL_IDS` + siblings: `mail_read_artifact`, `hms_find_reservation`, `hms_quote_stay`, `hms_list_documents`, `hms_sent_email_audit`, `hms_read_folio`, `hms_company_account_read`, `hms_group_block_read`, `hms_event_read`, `documents_list_existing`, `documents_read_existing`, `hms_read_reservation`, `hms_read_notes_traces`.

`productionActiveReadToolIds()` stays empty until live_verified evidence exists per tool.

### Wave 0 — **ONLY autonomous build now** (then HITL)

| ID | Effect | Why now | Payload contract stub (fill from live) |
|---|---|---|---|
| `hms_find_reservation` | read | Spine; packaging video exists but **payload broken** vs Sep-07 `ReservationMatch` | Canonical find = **grid match only** (`reservationMatchSchema`): opaque `reservationRef`, safe `label` (never sentinel `"-1"`), `referenceKind`, `status`, `arrival`/`departure`, `roomType` if GRID has it else null+honest unresolved, `matchEvidenceRefs`, `matchCount`/`capped`. **Denied:** `open_guest_stay_detail`. **Not find:** ratePlan, occupancy, policies, guestRefs, nightly rates → `hms_read_reservation`. Adapter `ReservationRow.guestName` must map into public `label`, not invent a second schema. |

### Wave A — **all remaining reads** (after Wave 0 HITL; run fully, one batch HITL at end)

Former “Wave A existing HMS reads” + former “Wave B new reads” **merged**. Same effect class (`view_only` / mail parse). No mid-wave human pause.

| Order | ID | Payload stub | Live video? |
|---|---|---|---|
| A1 | `hms_read_reservation` | Detail stay facts; owns room type / rate if find grid lacks them | Yes |
| A2 | `hms_read_folio` | Folio balances/lines per existing folio contract | Yes |
| A3 | `hms_list_documents` / `documents_list_existing` | List metadata only | Yes |
| A4 | `documents_read_existing` | Authorized bytes | Yes (or byte digest proof) |
| A5 | `hms_quote_stay` | Nightly/rate observations; **never** CRS Check Availability | Yes |
| A6 | `hms_group_block_read` | Keep; defer live if role blocked | If unblocked |
| A7 | `hms_event_read` | Keep; defer if blocked | If unblocked |
| A8 | `hms_company_account_read` | Keep; defer live | If unblocked |
| A9 | `hms_read_notes_traces` | Text only | Yes |
| A10 | `property_read_knowledge` | 141/3949; Astra U16 never in TS; structured policy; no invented rates | Yes (or knowledge-source proof) |
| A11 | `mail_parse_channel_payload` | 173; WebBeds/RateTiger “see below”; parsed OTA → feed find; not HMS screen | Mail proof (no PMS video) |
| — | `hms_sent_email_audit` | Keep registered; **do not promote** (3949 n=2) | No |
| — | `mail_read_artifact` | Nava mail bytes; not HMS screen | No PMS video |

### Wave B — writes (after Wave A batch HITL; run fully; batch review + per-write execute approve)

Shared envelope: §6 of kickoff. Order = email automation, not biggest PMS verb.

| Order | ID | Pending (3949) | Notes |
|---|---|---:|---|
| B1 | `mail.send_with_attachments` | — | Outbound; wrap existing PDF; execute approve required |
| B2 | `hms_attach_guest_stay_document` | — | Guest Stay Documents Create/Upload; not IDM; not folio email |
| B3 | generate/send quote, invoice/folio, confirmation | 74 / 67 / 6 | Replace autos where applicable |
| B4 | `hms_post_payment` | **165** | Largest unfinished money write |
| B5 | `hms_refund` | **40** | Supervisor stays |
| B6 | `hms_create_reservation` | 31 | Never Check Availability as read |
| B7 | `hms_cancel_reservation` then `hms_amend_reservation` | 12 / dates+rate | Cancel not #1 |

Then **stop** for guest reservationist email. Ops, group writes, IDM, Room Plan, CRS Check Availability-as-read — out (kickoff §5).

---

## Wave 0 — detailed (`hms_find_reservation` only)

### Why find ≠ read (canonical)

| | `hms_find_reservation` | `hms_read_reservation` |
|---|---|---|
| Job | **Identify** which stay matches an exact candidate | **Disclose** entitled sections of one stay |
| Input | `{candidateId}` | `{reservationRef, sections?, detail?}` |
| Surface | Guest Stay **search grid** (OSRESS) | Guest Stay **detail** (inert) |
| Denied | `open_guest_stay_detail`, stay_wizard, new_record | save/mutation (read-only detail) |
| 3949 named | **2115** | **223** |
| Catalog | Sep-07 L145; `ReservationMatch` | Sep-07 L146; `ReservationData` sections |

**Confusion we had:** live adapter `ReservationRow` + session `claimKeys` (`guestName`, `ratePlan`) are **not** the Sep-07 public find schema. Wave 0 DoD follows **`reservationMatchSchema` / catalogue**, not the fat adapter row. Fixing `primaryguest:"-1"` still matters because it poisons **`label`**.

### Schema (public — source of truth)

| Layer | Location | Shape |
|---|---|---|
| Request | `reservationFindRequestSchema` | `{toolId:'hms_find_reservation', candidateId, admission?}` |
| Match | `reservationMatchSchema` | `reservationRef`, `label`, `referenceKind`, `status`, `arrival`, `departure`, `roomType`, `matchEvidenceRefs` |
| Data | `reservationFindDataSchema` | `matches[]`, `matchCount`, `capped` |
| Result | `reservationFindResultSchema` | `schemaVersion:'reservation-find/1'` + ReadResult envelope |
| Registry | `READ_TOOLS.hms_find_reservation` | denies `open_guest_stay_detail`; claimKinds `reservation_summary` |
| Adapter (internal) | `ReservationRow` | may carry guestName/ratePlan for mapping — **must project into Match**, not redefine contract |

### W0.1 Payload contract (find — public)

| Field | Rule |
|---|---|
| `matches[].reservationRef` | Opaque minted ref when unique match; null when ambiguous (no selectable id) |
| `matches[].label` | Required non-empty safe display; **≠ `"-1"`** / numeric sentinel; composed from last/first when GRID `primaryguest` sentinel; ambiguous matches may use generic label without PII |
| `matches[].referenceKind` | `confirmation` \| `external` matching search key |
| `matches[].status` | Required; equals GRID status mapping |
| `matches[].arrival` / `departure` | Required when GRID provides; normalized LocalDate |
| `matches[].roomType` | Equal GRID when key present; else null + unresolved — **not** invented |
| `matches[].matchEvidenceRefs` | Present |
| `matchCount` / `capped` | Honest |
| **Out of find contract** | `ratePlan`, nightly rates, occupancy, guestRefs, org/agency/group, policies, operations → Wave A `hms_read_reservation` |

### W0.2 TDD

1. GRID `primaryguest:"-1"` + last/first → public **`label`** is composed name (not `"-1"`).
2. GRID without `roomtype` → find `roomType` null + no false claim; **no** `ratePlan` claim on find.
3. Projection test: adapter `ReservationRow` → `reservationMatchSchema` parse success.
4. Commit sanitized GRID fixture.

### W0.3 Live expected-vs-actual

1. Oracle = OSRESS GRID DATA[0] (same run).
2. Run find → result must parse `reservationFindResultSchema`.
3. `compare.v1.json` vs Match fields only (not read sections).
4. RCA until green; video of **search grid only** (no detail open).

### W0.4 Video (human)

| Expect | Fail if |
|---|---|
| Live Guest Stay **search** | Detail stay opened (`open_guest_stay_detail`) |
| Exact conf/external search | Wrong property |
| Row visible; label non-sentinel in result | Empty grid + claimed match |
| view_only | Mutation |

### W0.5 HITL packet

`video.webm`, `result.v1.json`, `oracle.v1.json`, `compare.v1.json` (Match fields only). Wave A blocked.

---

## Wave A1 detailed DoD (`hms_read_reservation`) — same depth as Wave 0

*Not built in Wave 0. Included so find/read boundary stays sharp when Wave A runs.*

### Schema (public)

| Layer | Location | Shape |
|---|---|---|
| Request | `reservationContextRequestSchema` | `{toolId:'hms_read_reservation', reservationRef, sections? default [core,stay], detail? summary\|detail}` |
| Data | `reservationContextDataSchema` | sections: `core`, `stay`, `rates`, `policies`, `operations` (each available\|unavailable) |
| Result | `reservationContextReadResultSchema` | `schemaVersion:'reservation-context/1'` |
| Registry | **Outside** Phase-B `READ_TOOL_IDS` (`RESERVATION_CONTEXT_TOOL_IDS`) | U8 context read service |
| Surface | Guest Stay **detail** after find minted ref | `open_guest_stay_detail` allowed here; save denied |

### Payload contract (read — by section)

| Section | Required when requested | Fields (catalogue) |
|---|---|---|
| `core` | default | confirmation, externalReference, status, guestRefs, organizationRef, agencyRef, groupRef |
| `stay` | default | arrival, departure, roomType, roomQuantity, adults, childAges, additionalGuests |
| `rates` | if requested | nightly ratePlan, price, inventory, restrictions, inclusions, taxes, fees |
| `policies` | if requested | guarantee, deposit, cancellation, policyVersion |
| `operations` | if requested | special requests / deadlines / action state (bounded) |

### Auton DoD (when Wave A runs A1)

1. Input = `reservationRef` from prior find (not raw conf typed into detail).
2. Oracle = Guest Stay detail network/DOM for requested sections.
3. `compare.v1.json` per requested section; unavailable sections honest.
4. **Owns** roomType/ratePlan depth when find grid lacked them.
5. Video: detail open + sections visible; **no save**.
6. RCA loop same as Wave 0.

### Why both tools (3949)

Find named **2115**; read named **223**. Most mail only needs “is this the stay?” (find). Amend/cancel/confirm paths need section snapshot (read). Same 111/253 reservation family in Sep-07 — not double-counted demand.

---

## After Wave 0 (human-gated → Wave A full auton)

1. `/continue-autonomously` or `/goal` with **Wave A** authority (Wave-0 quality; live PMS always).
2. Each A tool: Autonomous expected-vs-actual loop + packaging video; **no human pause**. Soft overlays + role-proof mint = **agent work**.
3. Surface truly absent **after this-wave live dump/probe** → honest `BLOCKED_*` (cite dump). **Not** after reading old RCA / expired role-proof file.
4. Wave A done = every non-deferred tool has compare green + video/mail proof (skip JSON alone ≠ done).
5. Batch HITL packet → stop. Wave B blocked until sign-off. Prior 2026-09-12 skip HITL = DRAFT only.
6. Wave B: same loop; oracle = post-write reread; execute approve still required for mutations.

---

## Master DoD (every tool) — binding contracts

**Prior gap (audited 2026-09-11):** this section used to be summary-only. Wave-0-depth input/output/oracle/denied/evidence lived only for `hms_find_reservation` (+ short A1). That was not enough for zero-shot Wave A/B.

**Second gap (same day, clarified):** first DoD pass cited mostly **demand ranks** (why build). User bar is **surface availability** (why field should be grabable on chosen Infor surface) + escape when live dump proves absence — so we never chase impossible schemas forever.

**Binding companion:**  
`docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md`

Companion contains: A/B/C evidence classes, **Surface availability matrix**, impossible-schema guard, per-tool DoD. Auton Wave A/B treats companion as Payload gate. Thin tables below = index only; **companion wins** until amended with live dump + tests.

### Evidence spine (pre-Astra → Astra → Sep-07 → live)

| Era | Doc | Locks |
|---|---|---|
| Pre-Astra | `docs/infor-hms/capability-matrix.md` | Official Infor URLs; docs≠tenant entitlement |
| Pre-Astra | `docs/infor-hms/centurion-pms-tool-demand-2026-08-01.md` (+08-03/08-04) | Field groups → Infor surfaces (OSRESS, Room Availability, Folios…) |
| Pre-Astra | `docs/infor-hms/centurion-reservationist-roadmap-2026-08-21.md` | Browser gates; no avail-as-hold |
| Pre-Astra Cursor | `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md` | Claim/deny envelopes (find denies invent rate/folio) |
| Astra | `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` | Points at Sep-07 + 53-source Infor; docs≠role proof |
| Sep-07 | `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` | Closed schemas; `SURFACE_UNPROVEN`; §5 Infor decisions; §6 write URLs |
| Gold | `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` | 3949 **demand** ranks |
| Kickoff | `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md` | Write order; attach upload Infor URL |
| Live | `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md` | dataspy 1941: GRID keys that **do not** exist |

### Impossible-schema stop (binding)

Demand cite alone **never** forces a required field. Grabability = class B (Infor surface + matrix) then **live dump**. If dump omits: amend DoD (allowed-null / move to owner tool) or ship `SURFACE_UNPROVEN`/`BLOCKED_*` after ≤5 RCA — **stop hunting**. Worked example: catalogue “room type/rate” on find → live GRID lacked `rateplan` → ratePlan **out of find**, owned by `hms_read_reservation`.

Sources re-checked into companion:

| Source | What it locked |
|---|---|
| Sep-07 L100–156 + §5 + §6 | Closed payloads + Infor product decisions + write URLs |
| capability-matrix + Aug demand surface table | Official surface ownership |
| 3949 / Sep-04 / kickoff | Demand order + claim/deny |
| attach plan + Deposit/Upload Infor URLs | Write surfaces |
| live-proof solution | Find GRID ground truth |
| TS contracts / `read-tools.ts` | Runtime schemas / denied |

**Auton** = how agent finishes without you mid-wave. **Video** = what you check at wave boundary. Every tool also needs `oracle.v1.json` + `result.v1.json` + `compare.v1.json` (writes: post-reread oracle).

### Wave 0 (index)

| Tool | Schema | DoD (auton) | Oracle | Video expect |
|---|---|---|---|---|
| `hms_find_reservation` | `reservationFindRequestSchema` → `reservationFindResultSchema` / **`reservationMatchSchema`** (not fat `ReservationRow`) | compare Match fields: label≠sentinel, referenceKind, status, dates, roomType-if-present; no ratePlan claim; no detail open; packaging OK | OSRESS GRID DATA[0] | **Search grid only**; row visible; no detail |

### Wave A — remaining reads (index → full DoD in companion A1–A13)

| Tool | Schema | DoD (auton) | Oracle | Video / proof |
|---|---|---|---|---|
| `hms_read_reservation` | TS `reservationContextDataSchema` | core+stay match detail; roomType/rate if find lacked | Guest Stay detail body | Open detail; no save |
| `hms_read_folio` | TS `folioReadDataSchema` | balance/deposits/txns match | Folio/ledger response | Folio; view_only |
| `hms_list_documents` | TS `documentListReadDataSchema` | rows match Documents list | Documents list/API | Documents tab |
| `documents_list_existing` | TS existing-doc list | docs[] + page vs sources | mail/HMS list | Mail proof OK |
| `documents_read_existing` | TS existing-doc read | bytes/hash match artifact | artifact bytes | Digest proof |
| `hms_quote_stay` | TS `quoteStayReadDataSchema` | nightlyObservations match; held:false; never CRS Check Availability | rate/avail surface | Quote UI; no create |
| `hms_group_block_read` | TS group-block | facts or `BLOCKED_*` | group surface | if role OK |
| `hms_event_read` | TS event | facts or `BLOCKED_*` | event surface | if role OK |
| `hms_company_account_read` | TS company | billing facts or `BLOCKED_*` | company surface | if role OK |
| `hms_read_notes_traces` | TS notes-traces | bounded text; no binary | notes list | Notes UI |
| `property_read_knowledge` | TS exists; register into `READ_TOOL_IDS` when building | entries match knowledge source; no invented rates | knowledge corpus | non-PMS proof OK |
| `mail_parse_channel_payload` | **stub needed** | channel/ref/dates vs FW body | raw FW artifact | Mail proof → find |
| `hms_sent_email_audit` | TS | **do not promote** | — | — |
| `mail_read_artifact` | registry | **no PMS video** | — | — |

### Wave B — writes (index → full DoD in companion B1–B7)

Shared: proposal → execute approve → outcome → **reread oracle** → compare.

| Tool | Schema | DoD (auton) | Oracle (post) | Video / proof |
|---|---|---|---|---|
| `mail.send_with_attachments` | kickoff sketch | queued\|rejected; idempotent | queue/sent receipt | SMTP proof + execute HITL |
| `hms_attach_guest_stay_document` | kickoff + attach plan | applied\|dup; doc on stay | `documents_list_existing` | Documents upload |
| `hms_generate_quote_document` | kickoff | documentRef; held:false | docs list | generate quote |
| `hms_generate_invoice` / `hms_email_folio` | kickoff | doc/email outcome | folio/docs reread | Email Folio |
| `hms_generate_confirmation_proforma` | kickoff | documentRef filed | Documents tab | proforma generate |
| `hms_send_reservation_confirmation` | kickoff | send outcome | sent/mailbox proof | Confirm to Email |
| `hms_post_payment` | kickoff | deposit posted; amount match | ledger reread | Advance Deposit |
| `hms_refund` | kickoff | refund OK; supervisor gate | ledger reread | Refund UI |
| `hms_create_reservation` | kickoff | stay exists; never Check Availability-as-read | find/detail | Guest Stay Save |
| `hms_cancel_reservation` | kickoff | canceled; fee explicit | find/detail | Cancel |
| `hms_amend_reservation` | kickoff | dates/room/rate applied | detail reread | Stay Wizard |

---

## Cuts (keep speed; keep honesty)

| Keep | Cut |
|---|---|
| Existing live driver + soft packaging path | Isolated EC2 checksum copy as proof prerequisite |
| **Expected-vs-actual `compare.v1.json`** | Packaging-only done |
| **Live owner-surface dump + Infor intel capture (every tool)** | Inventing keys; throwing away filter/sentinel/role notes after proof |
| Payload gate + live fixture per tool | Luna-as-done-gate |
| Wave-boundary HITL only | Per-tool human pause inside Wave A/B |
| One wave at a time after HITL | Starting Wave A in same autonomous run as Wave 0 |
| Contract amend when live dump contradicts | Inventing GRID keys to match catalogue marketing |
| Kickoff write order | Cancel-first from 420 |
| Merged read wave (existing + new reads) | Separate HITL between old A and old B |

---

## Pointers

| Doc | Use |
|---|---|
| `docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md` | **BINDING** per-tool DoD + A/B/C evidence + surface availability matrix |
| `docs/infor-hms/capability-matrix.md` | Pre-Astra officialDocs URLs; grabability spine |
| `docs/infor-hms/centurion-pms-tool-demand-2026-08-01.md` | Pre-Astra Field groups → Infor surfaces |
| `docs/infor-hms/centurion-reservationist-roadmap-2026-08-21.md` | Pre-Astra HMS browser gates |
| `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md` | Pre-Astra Cursor claim/deny envelopes |
| `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` | Astra → Sep-07 / 53-source Infor |
| `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md` | Why packaging ≠ done; dataspy 1941 |
| `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` | Closed Sep-07 payloads + §5 Infor limits |
| `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` | 3949 rank *why* (demand) |
| `docs/superpowers/plans/2026-09-11-write-tools-kickoff-from-3949-gold.md` | Write schemas + attach Infor URL |
| `docs/superpowers/plans/2026-09-11-fast-live-find-reservation-video.md` | Historical packaging run |
| `docs/superpowers/plans/2026-09-11-hms-attach-inbound-document.md` | Attach detail |
| `docs/solutions/conventions/live-negative-result-verification-gate.md` | Six-proof negatives |
| `.private/hms-find-reservation-live-20260911/` | Prior packaging evidence (private) |
| `.private/pms-tools-replan-2026-09-07/` | 53-source Infor manifest (private) |

---

## Status

| Wave | State |
|---|---|
| Catalogue (this file) | Written 2026-09-11 |
| **Per-tool DoD audit (A+B)** | **Done** → companion (schemas + oracles) |
| **Surface-availability audit (grabability)** | **Done** → companion A/B/C + matrix; **Exa web re-fetch 2026-09-11** confirmed key Infor URLs (CRS creates; Rate Details; Folio; Tax list; Documents upload; CON/BLK) |
| Wave 0 find packaging video | Done earlier (incomplete payload) |
| Wave 0 find exact payload | **Next** — Match/`label` + compare; OSRESS dump gates fields |
| Wave 0b surname+dates on find | After Wave 0 exact green; before Wave A; dump-proved lastname filters only |
| Find HITL (0+0b) | Batch review both axes; blocks Wave A |
| Wave A (all remaining reads) | Contracts + **per-tool live surface dump**; blocked on find HITL |
| Wave B (writes) | Same dump rule + Infor write URLs; blocked on Wave A HITL |
