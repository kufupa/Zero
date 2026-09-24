# Centurion Thread Matching + Conversation Signals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship **conversation-linked inbox UX** + accurate responded counting for Centurion: ingest header threading (Layer A), conversation-signal overlay (Layer B), **deterministic cross-thread links + UI grouping** (Layer C v1), optional LLM linker for residual only (Layer D gated). Close 68% KPI gap **and** merge split threads like spaced-subject RE chains (e.g. Breakfast Pack) in the mail UI without rewriting historical `thread_id`.

**Architecture:** Five separable layers (see product SoT `docs/plans/2026-09-02-001-feat-centurion-thread-matching-plan.md`):

1. **Layer A — Ingest threading:** RFC 5256 ordered References walk + `canonicalMessageId()` + `(transport_id, message_id_header)` index. Conservative: no subject merge at ingest.
2. **Layer B — Conversation signals:** Pure TypeScript port of `defensible-daily-chart-2026-09-01.py` detector — cross-thread conf#, orphan outbound by guest email, quoted hotel body, in-thread staff outbound. Powers KPI + **link suggestions**.
3. **Layer C — Conversation groups (v1 deterministic):** `mail_conversation_link` edges + `conversationId` overlay for inbox — header replay, B-signal pairs, JWZ-style **conversation-layer** subject normalize (not ingest). **Does not rewrite `thread_id`.**
4. **Layer D — Bedrock linker (gated):** Binary same-conversation classifier on ambiguous pairs (0.55–0.75 deterministic score), 500-char stripped bodies, batch 5–10 pairs/call, cap 50 pairs/mailbox/day. Titan embed optional spike (Task 14).
5. **Layer E — Frontend conversation UX:** `listThreads` returns `conversationId`, `linkedThreadIds`, `conversationResponded`; mail-list **Option C** (primary row + linked stub); merged timeline in thread detail.

**Tech Stack:** TypeScript, Zod, Vitest, Drizzle migration, Bedrock Converse adapter (`apps/server-pilot/src/ai/bedrock/`), private corpus gold.

**Prerequisites:** Phase 1 triage plan does **not** change threading. Phase 2 evidence dashboard consumes Layer B via Task 9 hook.

**Gold calibration:** `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01.json` — 438 actionable · 246 responded · 192 unanswered · audit PASS.

**External standards:** [RFC 5256 REFERENCES](https://www.rfc-editor.org/rfc/rfc5256.html), [JWZ threading](https://www.jwz.org/doc/threading.html), [Gmail thread headers](https://developers.google.com/workspace/gmail/api/guides/threads), [Titan Embed V2](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html).

**Execution posture:** Autonomous overnight-capable. **Run entire plan in a dedicated git worktree** — merge to integration branch after Phase 1 triage worker/mail-triage stabilize. Never rewrite `thread_id` during Phase 1 backfill.

---

## Worktree execution (required)

**Run all Tasks 1–11 in an isolated worktree.** Do not implement on the same checkout as active Phase 1 triage `/nava-run`.

### Why worktree (not same checkout)

| Risk on shared checkout | Worktree avoids |
|-------------------------|-----------------|
| `worker.ts` / `mail-triage.ts` merge fights with triage v6 | Independent branch until deliberate merge |
| Dirty unrelated corpus/nava files on `feat/connected-mailbox-corpus` | Clean tree scoped to thread matching only |
| Agent accidentally stages wrong files | Smaller diff surface at commit time |

### Setup (operator or agent)

```bash
# From primary repo root — use ignored .worktrees/ per repo convention
git fetch origin
BASE=origin/main   # or current integration branch if triage branches from feature branch
git worktree add .worktrees/centurion-thread-matching -b feat/centurion-thread-matching "$BASE"
cd .worktrees/centurion-thread-matching
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
```

- **Branch:** `feat/centurion-thread-matching` (single branch for full plan including gated Tasks 10–11 if gate opens)
- **Worktree path:** `.worktrees/centurion-thread-matching` (verify `.worktrees/` in `.gitignore` before add)
- **Skill:** `using-git-worktrees` — detect existing isolation first; do not nest worktrees

### What runs in worktree vs primary

| Work | Worktree | Primary checkout |
|------|----------|------------------|
| All Tasks 1–11 (this plan) | ✅ | ❌ |
| Phase 1 triage `/nava-run` | ❌ | ✅ |
| Phase 2 dashboard | ❌ | ✅ (after gates) |

### Merge order (after worktree implementation green)

1. **Prefer:** Land Phase 1 triage Tasks 1–5 (worker + `mail-triage.ts` stable) on integration branch **first**.
2. **Then:** Merge `feat/centurion-thread-matching` → integration branch (rebase or merge).
3. **Resolve once:** `worker.ts` Task 6 metrics wire vs triage v6 — expect **one** conflict surface, not ongoing edits.
4. **Verify on integration tree:** `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`; thread-matching tests + triage tests both green.
5. **Do not** merge `thread_id` rewrite or link-table auto-merge before Phase 1 backfill audit green (plan still forbids rewrite during backfill).

### Worktree cleanup (after merge)

```bash
git worktree remove .worktrees/centurion-thread-matching
git branch -d feat/centurion-thread-matching   # after branch merged to integration
```

### Pushback (acknowledged, not blocking)

- Worktree does **not** eliminate merge conflicts — it **defers** them to one controlled merge (especially Task 6 + `worker.ts`).
- If Phase 1 triage rebases heavily, rebase worktree branch onto integration before merge to shrink conflict diff.
- EC2 overnight deploy: only from **integration** branch after merge + verification — not from worktree alone unless explicitly testing.

---

## First-pass shortcuts (this plan corrects)

Prior draft was too fast. Gaps filled in this revision:

| Shortcut taken | What we missed | Now in plan |
|----------------|----------------|-------------|
| Assumed export lacks headers = DB lacks headers | Postgres reader emits `in_reply_to`; markdown dump omits ancestry | Task 7 export fix + operator RDS diag note |
| Single `resolveThreadId` fix framed as main win | 68% responded gap is **cross-thread/orphan/quoted**, not header walk | Layer B is primary KPI fix; Layer A is future-mail correctness |
| Under-explored `mail.send` | Compose uses `threadRootId: outbound-${uuid}`; `messageIdHeader` null until SMTP flush | Task 8 compose gap doc + optional provisional header |
| Ignored `message_id_header` index absence | Schema has `message_transport_thread_idx` only — no header lookup index | Task 2 migration |
| Conflated `threadSignals` with responded | `deriveThreadSignals` = R22/R23 spam staff proof, same-thread causal only | Task 6 thin wire; separate `conversation-signals.ts` |
| `hotelConversationNotSpam` overlap hand-waved | Triage refine needs payment terms; corpus quoted signal does not | Documented divergence in Problem Statement |
| LLM layer sized without token model | Bedrock triage uses 8k trigger / 2k context; Nova ~$0.0005/triage | Task 10 token budget + batch math |
| Skipped thread-walkthrough + waterfall metrics | 97 daily-un flipped by quoted+orphan; 29/246 in-thread-only responded | Problem Statement tables |
| Weak autonomous mandate | Missing overnight overlay infra table | Full mandate below |
| No product SoT doc | Only superpowers plan | `docs/plans/2026-09-02-001-feat-centurion-thread-matching-plan.md` |
| Frontend linking omitted | User goal = visible merged/linked inbox rows, not metrics-only | Layer E Tasks 15–16; Layer C v1 ships |
| Breakfast Pack class | Staff-internal spaced-subject RE split; not in 438 actionable | Task 0 audit + Layer C subject normalize at conversation layer |

---

## Global Constraints

- Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV`
- Never pilot-RDS Vitest; operator read-only SQL OK with existing gates
- **No subject merge at ingest** — subject normalize only at **conversation link** layer (Layer C) with participant + time guards
- **No `thread_id` rewrite** on historical rows — grouping via `conversationId` + links table
- List UI `conversationResponded` drives replied badge; per-thread `hasReplied` retained for Sent/debug
- `conversationResponded` overlay ≠ `legacyHotelsOutboundResponse` (`worker.ts:121-149` — LH staff outbound, spam trust)
- Raw PII out of Git; corpus gold in `.private/` only
- Phase 1 backfill: **no `thread_id` rewrite**; adding `threadSignals` fields requires `promptVersion` bump if wired into refine
- LLM (Layer D): approved Bedrock route only; no raw bodies in logs; 50 pairs/mailbox/day cap
- Chart **1,042 / 37.1%** unchanged — this plan fixes threading KPI methodology only

## Overnight Autonomous Execution Mandate

**User granted full autonomy for this plan.** Continue until done criteria evidenced. No routine checkpoints.

### Communication

- Orchestrator + subagents: **`/caveman ultra`**. Technical terms exact.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Deploy | `apps/server-pilot/deploy/ops-deploy.sh` |
| Restart | `apps/server-pilot/deploy/ops-restart.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** ops wrappers, read-only pilot SQL/diag, private corpus eval scripts, disposable-DB tests, Centurion markdown dump regen.

**Forbidden:** force-push main, `--no-verify`, Vitest against pilot RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into test shells, auto-merge `thread_id` from LLM.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

### RCA loop

FAIL → reproduce minimally → root cause (file:line) → smallest correct fix → test → resume. Symptom patches not completion.

### Cursor execution-backend flake

`Execution backend unavailable...` → `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`

### Done criteria

- [ ] **Task 0:** Corpus linkage audit artifacts in `.private/.../thread-linkage-audit-2026-09-02/` (waterfall, clusters, exemplars).
- [ ] Layer A: ordered References walk + canonical Message-ID + header index; ingest tests green.
- [ ] Layer B: `conversation-signals.ts` ports all 6 gold signal types; eval ≥221/438 recall, ≤4/192 FP.
- [ ] Layer C: `mail_conversation_link` + `conversationId` resolver; deterministic backfill from headers + B signals + subject clusters (guarded); gold eval on **link precision** ≥95% on enumerated high-confidence pairs.
- [ ] Layer E: `mail.listThreads` exposes `conversationId`, `linkedThreadIds`, `conversationResponded`; inbox shows linked stub rows; thread detail merged timeline; replied badge uses `conversationResponded`.
- [ ] Layer B wired to triage metrics (`conversationResponded`) without breaking Phase 1 spam refine contract.
- [ ] Private dump exports ancestry headers OR documented omission with reader parity test.
- [ ] Handoff report with before/after waterfall + **UI exemplar** (Breakfast Pack thread ids when found in full corpus).
- [ ] Layer D unimplemented unless Task 13 residual gate documents ≥10 enumerated FN thread pairs after deterministic linker.
- [ ] Phase 2 dashboard plan references Layer B card hook (Task 9).
- [ ] Deploy to EC2 pilot after integration merge; smoke: open linked conversation shows both thread bodies chronologically.

### True blockers

Missing credentials, destructive ambiguity on merge policy, safety-policy conflict, external outage preventing proof.

## Execution Mode

Autonomous. **Worktree-only** — see **Worktree execution (required)** above. Resume first incomplete task in `.worktrees/centurion-thread-matching`. Phase 1 triage runs on primary checkout in parallel. **Do not** run `thread_id` rewrite during Phase 1 Task 12. Merge worktree branch after triage worker/mail-triage stabilize.

---

## Problem statement (evidence)

### Phase 1 / Phase 2 triage plans and threading

**Neither plan changes ingest thread matching.** Phase 1 uses `threadSignals` for spam R22/R23 (`legacyHotelsOutboundResponse`, ReserveCloud staff outbound) — same thread, causal window. Phase 2 dashboard reads category counts from dump.

### Centurion corpus waterfall (438 actionable)

| Stage | Responded | Unanswered | Delta |
|-------|----------:|-----------:|------:|
| In-thread outbound only | 71 | 367 | baseline |
| + cross-thread conf# (daily layer) | 149 | 289 | +78 |
| + quoted + orphan (defensible) | **246** | **192** | +97 from daily-un |

**In-thread-only = 29/246 responded (11.8%).** Naive `thread_id` KPI misses **167/246 (68%)**.

### Signal exclusivity on gold responded (n=246)

| Family combo | Count |
|--------------|------:|
| quoted only | 52 |
| in_thread + quoted | 30 |
| in_thread only | 29 |
| cross + orphan | 26 |
| orphan only | 26 |
| cross only | 21 |
| other 3–4 family mixes | 62 |

### Archetypes

1. **Singleton PMS confirm** — guest RFQ thread inbound-only; `confirmation letter_{guest}` on new outbound thread → `cross_thread_conf` + `orphan_auto_confirm` (103 orphan hits corpus-wide).
2. **Quoted FW trail** — hotel quote in embedded `From: Centurion...` block; no outbound row → `quoted_hotel_header` (126 threads carry signal).
3. **Cross-thread staff** — human centurion email to guest on different thread → `orphan_centurion_human` (6).
4. **True in-thread reply** — minority path (29 exclusive).
5. **Spaced-subject RE split (Breakfast Pack class)** — staff-internal RE chain; quoted prior in body; fixes via Layer C `header_parent` + `subject_cluster` (not in 438 actionable KPI set).

### Failure modes + mitigations

| Risk | Mitigation |
|------|------------|
| False merge (digest subjects) | Ops subject denylist; participant overlap + 72h window for `subject_cluster` |
| False merge (same guest, different bookings) | conf# / guest email guards on B-signal links |
| Header missing in export | Task 7 dump fix + RDS header coverage diag |
| `thread_id` rewrite breaks triage | **Forbidden** — `conversationId` overlay only |
| N+1 list performance | Batch conversation resolver; `conversationResponded` on `listThreads` |
| LLM wrong merge | Cap 50 pairs/day; deterministic bands first |
| Spaced-subject (`B re akfast`) | `collapseSpacedSubjectArtifacts` at link layer |

### How responded counting shows in UI (v1)

| Surface | Field | Meaning |
|---------|-------|---------|
| Inbox badge | `conversationResponded` | Answered anywhere in linked conversation |
| Stub row | `linkedThreadIds` | Sibling thread under primary |
| Thread detail | merged timeline | Chronological across linked threads |
| Sent / debug | `hasReplied` | Per-thread outbound only |

### Current ingest (`resolveThreadId`)

```1732:1747:apps/server-pilot/src/mail/ingest/store.ts
  const candidates = [...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...parsed.references].filter(
    Boolean,
  );
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length > 0) {
    const parentRows = await tx
      .select({ threadId: message.threadId })
      .from(message)
      .where(
        and(
          eq(message.transportId, transportId),
          inArray(message.messageIdHeader, uniqueCandidates),
        ),
      )
      .limit(1);
```

**Gaps vs RFC 5256:** unordered `LIMIT 1`; no References chain walk; no Message-ID normalization at lookup; **no index on `message_id_header`** (`mail.ts:343-349` indexes transport+thread only).

### Export vs DB ancestry

`execute-reverse-joins-2026-08-30.py` reports 0 In-Reply-To/References in **markdown export** — offline header joins impossible from dump alone. Postgres reader **does** read `in_reply_to` from DB. Fix: Task 7.

### Related but distinct: triage `hotelConversationNotSpam`

```413:423:apps/server-pilot/src/ai/triage.ts
function hotelConversationNotSpam(input: TriageRefineInput): boolean {
  // requires payment/invoice terms — stricter than corpus quoted_hotel_header
}
```

Corpus quoted signal catches FW/RE without payment gate. **Do not merge** into spam refine without explicit product decision.

### Compose→ingest join gap

`mail.send` without `threadId` creates `threadRootId: outbound-${threadId}` (`mail.ts:1068`). Outbound `messageIdHeader` null until SMTP (`mail.ts:1205`). Guest reply before flush cannot header-join. Rocketseed reconcile uses `X-Zero-Outbound-Id`, not `resolveThreadId`.

---

## File map

| Path | Role |
|------|------|
| `apps/server-pilot/src/mail/ingest/message-id.ts` | **New** — RFC 5256 Message-ID normalize |
| `apps/server-pilot/src/mail/ingest/store.ts` | Ordered References walk |
| `apps/server-pilot/src/db/schema/mail.ts` | Header lookup index migration |
| `apps/server-pilot/src/mail/conversation-signals.ts` | **New** — Layer B detector + inline index builders |
| `apps/server-pilot/src/ai/thread-signals.ts` or `triage-input.ts` | Thin `conversationResponded` wire (metrics only v1) |
| `apps/server-pilot/src/ops/connected-mailbox-markdown-dump.ts` | Ancestry header export |
| `apps/server-pilot/scripts/eval-centurion-conversation-signals.ts` | Gold eval CLI |
| `apps/server-pilot/tests/message-id.test.ts` | Canonicalizer tests |
| `apps/server-pilot/tests/thread-join.test.ts` | Extended ingest join |
| `apps/server-pilot/tests/conversation-signals.test.ts` | Unit fixtures |
| `apps/server-pilot/tests/conversation-signals-gold.test.ts` | Gold gate |
| `apps/server-pilot/src/ops/centurion-thread-linkage-audit.ts` | **New** — offline corpus linkage audit |
| `apps/server-pilot/scripts/audit-centurion-thread-linkage.ts` | Corpus audit CLI |
| `apps/server-pilot/tests/centurion-thread-linkage-audit.test.ts` | Audit unit tests |
| `apps/server-pilot/src/mail/conversation-group.ts` | **New** — conversationId union-find + query |
| `apps/server-pilot/src/mail/conversation-link.ts` | **New** — deterministic link upsert + backfill |
| `apps/mail/hooks/use-threads.ts` | Conversation-aware list keys |
| `apps/mail/components/mail/mail-list.tsx` | Linked stub rows + badge |
| `apps/mail/components/mail/thread-display.tsx` | Merged timeline |
| **Gated:** `apps/server-pilot/src/ai/workflows/conversation-linker.ts` | Layer D |

---

### Task 0: Corpus linkage audit (offline, prerequisite evidence)

**Files:**
- Create: `apps/server-pilot/src/ops/centurion-thread-linkage-audit.ts`
- Create: `apps/server-pilot/scripts/audit-centurion-thread-linkage.ts`
- Create: `apps/server-pilot/tests/centurion-thread-linkage-audit.test.ts`

**Outputs (private, regen anytime):**
- `.private/connected-mailbox-corpus/follow-up/_work/thread-linkage-audit-2026-09-02/thread-linkage-audit.json`
- `thread-linkage-audit-summary.md` — waterfall, layer counts, subject clusters, breakfast-pack scan

**Command:**

```bash
pnpm exec tsx apps/server-pilot/scripts/audit-centurion-thread-linkage.ts
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/centurion-thread-linkage-audit.test.ts
```

- [ ] **Step 1:** Implement audit module (defensible + walkthrough + staff-brief subjects)
- [ ] **Step 2:** Subject normalize + spaced-artifact collapse (`normalizeConversationSubject`, `collapseSpacedSubjectArtifacts`)
- [ ] **Step 3:** PASS tests + run script; record counts in handoff

**Note:** Breakfast Pack RE split is **staff-internal** (not 438 actionable) — full-corpus header replay in Task 12 backfill still required for inbox UX.

---

### Task 1: Message-ID canonicalizer (RFC 5256 §6.4.3)

**Files:**
- Create: `apps/server-pilot/src/mail/ingest/message-id.ts`
- Create: `apps/server-pilot/tests/message-id.test.ts`

**Interfaces:**

```ts
/** Strip angles, lowercase local@domain per RFC 5256 duplicate-ID rules. */
export function canonicalMessageId(raw: string | null | undefined): string | null;
export function messageIdsEqual(a: string | null, b: string | null): boolean;
/** Merge In-Reply-To onto References per JWZ/RFC when both present. */
export function buildReferenceChain(inReplyTo: string | null, references: readonly string[]): string[];
```

- [ ] **Step 1: Failing tests** — `<'A@b>'` equals `'a@b'`; quoted sublocal per RFC 5256 example; chain puts IRT last

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/message-id.test.ts
```

- [ ] **Step 2: Implement**

- [ ] **Step 3: PASS**

---

### Task 2: DB index + ordered References walk

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/store.ts`
- Modify: `apps/server-pilot/src/db/schema/mail.ts` + migration
- Modify: `apps/server-pilot/tests/thread-join.test.ts`

**Algorithm (ingest parent pick):**

```
refs = buildReferenceChain(inReplyTo, references)
for id in reverse(refs):  // newest parent first per RFC walk
  parent = lookup(transportId, canonicalMessageId(id))
  if parent: return parent.threadId
fallback threadRootId = canonicalMessageId(parsed.messageId) ?? no-message-id-${uidl}
```

- [ ] **Step 1: Failing tests** — refs `[root, mid]` joins `mid` thread when both exist; transport isolation; duplicate MID deterministic

- [ ] **Step 2: Add partial index** `message_transport_header_idx ON (transport_id, message_id_header) WHERE message_id_header IS NOT NULL`

- [ ] **Step 3: Implement walk; remove unordered `LIMIT 1`**

- [ ] **Step 3b: Canonicalize on persist** — `messageIdHeader`, `inReplyTo`, `references` written canonical at insert (`store.ts:541-543`), not lookup-only

- [ ] **Step 3c: Duplicate MID tie-break** — if multiple rows share `(transport_id, message_id_header)`, pick lowest `(created_at, id)`; log metric only

- [ ] **Step 4: PASS**

**Non-goals:** subject merge; retroactive parent-late merge job (document as Task 8 follow-up).

---

### Task 3: Conversation signals detector + indexes (Layer B core)

**Files:**
- Create: `apps/server-pilot/src/mail/conversation-signals.ts`
- Create: `apps/server-pilot/tests/conversation-signals.test.ts`

**Interfaces:**

```ts
export type ConversationSignal =
  | 'in_thread_outbound'
  | 'cross_thread_conf'
  | 'orphan_auto_confirm'
  | 'orphan_centurion_human'
  | 'quoted_hotel_header'
  | 'quoted_hotel_phrase';

export type AutoConfirmRow = { conf: string | null; guestNorm: string; day: string; threadId: string };
export type OrphanOutboundRow = { guestEmail: string; threadId: string; subject: string; from: string; isAuto: boolean };

export function buildAutoConfirmIndex(messages: readonly IndexableMessage[]): readonly AutoConfirmRow[];
export function buildOrphanOutboundIndex(messages: readonly IndexableMessage[]): ReadonlyMap<string, readonly OrphanOutboundRow[]>;

export function detectConversationSignals(input: {
  threadId: string;
  triggerMessageId: string;
  messages: readonly ConversationMessage[];
  autoConfirmIndex: readonly AutoConfirmRow[];
  orphanByGuest: ReadonlyMap<string, readonly OrphanOutboundRow[]>;
}): ConversationSignal[];

export function isConversationResponded(signals: readonly ConversationSignal[]): boolean;
```

Port from `defensible-daily-chart-2026-09-01.py` + `staff-email-brief-analysis-2026-09-01.py` index builders inline.

- [ ] **Step 1: Failing tests** — one fixture per archetype + index builder unit cases

- [ ] **Step 2: Implement detector + indexes in one module**

- [ ] **Step 3: PASS**

---

### Task 4: Gold eval harness + gate

**Files:**
- Create: `apps/server-pilot/scripts/eval-centurion-conversation-signals.ts`
- Create: `apps/server-pilot/tests/conversation-signals-gold.test.ts` — loads gold from `.private/.../defensible-daily-chart-2026-09-01.json` in eval script; CI uses committed opaque 20-thread fixture subset for disposable gate

**Gate:**
- Responded recall ≥ **221/438** (90%)
- False responded on gold-unanswered ≤ **4/192** (2%)
- Confusion matrix stdout: counts only, no PII

- [ ] **Step 1: Eval script reads defensible JSON + snapshot markdown (or postgres reader fixture)**

- [ ] **Step 2: Failing gold test below threshold**

- [ ] **Step 3: Tune detector until gate passes**

- [ ] **Step 4: Record waterfall table in handoff**

---

### Task 5: Residual pair enumeration (feeds Layer C + D gates)

**Files:**
- Create: `apps/server-pilot/scripts/enumerate-centurion-link-residuals.ts`
- Output: `.private/.../thread-link-residual-2026-09-02.json`

Enumerate actionable thread **pairs** where:
- `responded=true` on thread A, outbound only on thread B (cross-thread)
- `quoted_hotel_header` without header parent edge
- Subject cluster multi-thread with same participant set within 72h

- [ ] **Step 1:** Script outputs pair list with suggested `linkType` + confidence band
- [ ] **Step 2:** Handoff table: pairs for deterministic linker vs LLM residual

---

### Task 6: Wire into triage context (additive, version-safe)

**Files:**
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts` or shared `thread-signals` module
- Modify: `apps/server-pilot/tests/ai-triage-input.test.ts`

**Interfaces:**

```ts
export type ThreadSignals = {
  legacyHotelsOutboundResponse?: boolean;
  reserveCloudStaffOutbound?: boolean;
  // ...
  conversationResponded?: boolean;
  conversationSignalReasons?: ConversationSignal[];
};
```

**Rules:**
- Compute indexes once per workflow run — same transport scope + causal message window as worker classify (`buildCausalTriageMessages` bound)
- **v1 metrics-only:** persist on `ai_workflow_run.metrics`; **do not** add to `canonicalThreadSignals()` / `hashTriageInput` / Mastra user prompt until explicit `triage-v7` coordination
- **Do not** feed `conversationResponded` into `staffConversationNotSpam` / spam refine in v1
- Regression: `conversationResponded: true` + `isSpam: true` from model → refine behavior unchanged

- [ ] **Step 1: Failing tests** — quoted-only → metrics `conversationResponded: true`; spam refine output identical with/without field

- [ ] **Step 2: Implement wire**

- [ ] **Step 3: PASS** — `hashTriageInput` stable when conversation fields omitted from hash

---

### Task 7: Export ancestry headers in private dump

**Files:**
- Modify: `apps/server-pilot/src/ops/connected-mailbox-markdown-dump.ts`
- Modify: `apps/server-pilot/tests/connected-mailbox-markdown-dump.test.ts`

- [ ] **Step 1: Failing test** — block includes `In-Reply-To` / `References` when DB row has them

- [ ] **Step 2: Implement**

- [ ] **Step 3: PASS**

- [ ] **Step 4: Re-run `execute-reverse-joins` v2 script note in handoff (counts should rise if DB has headers)

---

### Task 8: Compose/SMTP join gap (handoff doc)

**Deliverables (handoff paragraph, no new script required for v1 DoD):**
- Document compose gap: `threadRootId: outbound-${uuid}` (`mail.ts:1068`); `messageIdHeader` null until SMTP flush
- Reference existing `diag-centurion-staff-shapes.ts` cross-thread counts for operator follow-up
- Optional follow-up task: provisional `messageIdHeader` on `mail.send` insert

- [ ] **Step 1: Handoff section in `docs/superpowers/plans/handoff-reports/`**

---

### Task 9: Phase 2 dashboard hook

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-centurion-evidence-dashboard-implementation.md`

Add client card spec:

```ts
export const DAILY_ANSWERED_UNANSWERED_COPY = {
  title: 'Daily reservation answered vs unanswered',
  subtitle: 'Conversation signal overlay (cross-thread + quoted body). Not same as thread list replied badge.',
  methodology: 'defensible-daily-chart-2026-09-01',
} as const;
```

- [ ] **Step 1: Card spec + `availability: live_conversation_signals`**

---

### Task 10: Durable conversation links + conversationId (Layer C v1 — deterministic)

**Prerequisite:** Tasks 3–5 pass. **Not gated** on residual FN count — ships for inbox UX.

**Files:**
- Create: `apps/server-pilot/src/db/schema/mail-conversation-link.ts` + migration
- Create: `apps/server-pilot/src/mail/conversation-link.ts`
- Create: `apps/server-pilot/src/mail/conversation-group.ts`
- Create: `apps/server-pilot/scripts/backfill-centurion-conversation-links.ts`
- Create: `apps/server-pilot/tests/conversation-link.test.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` — expose conversation fields on `listThreads` + `get`

**Schema:**

```ts
mail_conversation_link {
  id, transportId,
  srcThreadId, dstThreadId,       // thread-level edges for v1 UI
  srcMessageId?, dstMessageId?,   // optional message anchor
  linkType: 'header_parent' | 'domain_conf' | 'domain_guest_email' | 'quoted_body' | 'subject_cluster' | 'llm_link',
  confidence: numeric,
  createdAt, supersededAt,
  UNIQUE(transportId, srcThreadId, dstThreadId, linkType)
}
```

**Deterministic link rules (no LLM):**

| Rule | Guard | linkType |
|------|-------|----------|
| Message B `inReplyTo`/`references` → message A MID | same transport | `header_parent` |
| B-signal cross_thread_conf / orphan pair | guest email or conf# match + 7d window | `domain_conf` / `domain_guest_email` |
| Quoted hotel header points to prior inbound | same guest norm email | `quoted_body` |
| Norm subject cluster | same primary participants (from/to overlap) + ≤72h span + not ops digest subject denylist | `subject_cluster` |

**conversationId:** Union-find on thread edges per transport; stable UUID per component. **Never** mutate `mail_thread.id`.

**Backfill:** Read-only RDS snapshot or private corpus replay → upsert links idempotently. Operator script, not Vitest on pilot.

**Precision gate:** On enumerated high-confidence pairs from Task 5, **≥95%** precision (manual allowlist in test fixture — opaque ids only in CI).

- [ ] **Step 1: Migration + idempotent upsert tests**
- [ ] **Step 2: Implement deterministic scorer + union-find**
- [ ] **Step 3: Backfill script + handoff pair counts**
- [ ] **Step 4: `listThreads` returns `conversationId`, `linkedThreadIds`, `conversationResponded`, `conversationMessageCount`**

---

### Task 11: Frontend API contract (Layer E — server)

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/src/lib/driver/types.ts`
- Create: `apps/server-pilot/tests/mail-conversation-list.test.ts`

**`listThreads` row additions:**

```ts
conversationId: string;
linkedThreadIds: readonly string[];  // other thread_ids in group, sorted
conversationResponded: boolean;      // Layer B on actionable OR any outbound in group
conversationMessageCount: number;
primaryThreadId: string;             // newest/latest in group
```

**`get` additions:** `linkedThreadIds`, optional `mergedMessages` when `?mergeLinked=1`.

- [ ] **Step 1: Failing tests** — two linked threads → one `conversationId`; responded on sibling when outbound only on linked thread
- [ ] **Step 2: Implement query-time group resolver (no N+1 per row — batch conversation lookup)**
- [ ] **Step 3: PASS**

---

### Task 12: Frontend inbox UX (Layer E — Option C)

**Files:**
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Modify: `apps/mail/lib/mail/build-mail-list-virtual-rows.ts`
- Create: `apps/mail/components/mail/linked-thread-stub-row.tsx`

**UX (Option C — stacked primary + stub):**
- Primary row: full row for `primaryThreadId`
- Stub row: compact "Linked thread · {date}" under primary when `linkedThreadIds.length > 0`
- Replied badge on **primary only** when `conversationResponded`
- Tooltip: "N messages across M linked threads"
- Hide duplicate full rows for non-primary linked threads (filter in `use-threads`)

- [ ] **Step 1: Failing browser/unit test** — stub visible when API returns linked pair
- [ ] **Step 2: Implement list filter + stub component**
- [ ] **Step 3: Remove per-row N+1 `useThread` for replied icon where `listThreads` now carries `conversationResponded`

**Design review:** `gstack-plan-design-review` — stub density, accessibility, bulk-archive prompt.

---

### Task 13: Frontend thread detail — merged timeline

**Files:**
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Modify: `apps/mail/components/mail/mail-display.tsx`

- [ ] **Step 1:** `get` with `mergeLinked=1` loads chronological messages across `linkedThreadIds`
- [ ] **Step 2:** Light segment divider between thread sources (label: "Earlier thread" + date)
- [ ] **Step 3:** Banner: "Linked conversation (M threads)" + jump links
- [ ] **Step 4:** Reply composer targets latest inbound in **merged** set

---

### Task 14 (GATED): Bedrock linker + optional Titan embed spike

**Prerequisite:** Task 10 shipped + Task 5 lists **≥10** pair candidates still unlinked after deterministic pass.

**Files:**
- Create: `apps/server-pilot/src/ai/workflows/conversation-linker.ts`
- Create: `apps/server-pilot/tests/conversation-linker.test.ts`

**Token budget (mirror triage):**

| Item | Limit |
|------|-------|
| Body per message | 500 chars stripped (no quoted history) |
| Pairs per invoke | 5–10 batched JSON |
| Daily cap | 50 pairs/mailbox |
| Model | Nova via existing `createModelAdapter()` |
| Output | `{ sameConversation: boolean, confidence: number }` |
| Cost order | ~$0.0003/day at cap (vs ~$0.0005/triage) |

**Deterministic pre-score bands:**
- ≥0.75 → link without LLM
- 0.55–0.75 → LLM
- ≤0.55 → no link; cache negative 30d

**Titan embed spike (optional, not v1 DoD):**
- `amazon.titan-embed-text-v2:0`, 512-dim, subject+from+512char body
- Cosine ≥0.85 → skip LLM
- Bedrock batch for backfill indexing only

- [ ] **Step 1: Mock Bedrock tests — prompt shape, cap enforcement**

- [ ] **Step 2: Implement linker behind feature flag `CONVERSATION_LLM_LINKER=0` default**

---

## Review disposition (nava-plan 2026-09-02 deep pass + frontend expansion)

| Gate | Result |
|------|--------|
| eng | Split layers; canonical MID; ordered walk; index; gold contract; compose gap; hashTriageInput; conversationId overlay; backfill script → Tasks 0–13 |
| ponytail | No subject **ingest** merge; deterministic C before LLM; port Python detector; union-find not full JWZ tree in hot path → A+B+C+E ship, D gated |
| design | Option C stub rows; badge on `conversationResponded`; merged timeline default → Tasks 12–13 |
| devex | Eval CLI + audit + backfill scripts → Tasks 0, 5, 10 |

## Decisions locked

1. **Responded KPI + inbox badge** use `conversationResponded` (Layer B + group outbound)
2. **Inbox grouping** uses `conversationId` from link edges — **not** `thread_id` rewrite
3. **Gold responded** = defensible-daily-chart 2026-09-01 (438/246/192)
4. **Ingest = header walk only** — subject normalize at **link** layer with participant/time guards
5. **threadSignals spam contract frozen** — `conversationResponded` additive, not spam refine input in v1
6. **LLM last** — deterministic linker covers corpus pairs; LLM only for Task 14 residual
7. **Phase 1 triage parallel-safe** — no `thread_id` rewrite during backfill
8. **Breakfast Pack class** — staff-internal; fixed by header replay + subject_cluster at Layer C, not actionable KPI set

## True blockers

None for Layers A+B+C+E. Layer D blocked on Task 14 gate.

## Execution Handoff

`/nava-run` on this plan **inside worktree** `.worktrees/centurion-thread-matching`. Phase 1 triage `/nava-run` stays on primary checkout. Merge worktree after triage worker stable. **Overnight:** Task 0 → 1–5 → 10–13 → deploy smoke. Phase 2 dashboard after Layer B green + Phase 1 nav flip.
