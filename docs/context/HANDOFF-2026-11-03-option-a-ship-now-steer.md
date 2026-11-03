# HANDOFF 2026-11-03 19:10 UTC: Option A retro + ship-now steer

**Supersedes the scope/ETA sections of** `HANDOFF-2026-11-03-option-a-adversarial-override.md`. Safety rules there and in `PRODUCT.md` stay in force.
**Owner authority (granted in the Option A `/goal`, still valid):** implementation, worktrees, PRs, approved-gate merges, `ops-deploy.sh` bundle deploys, the plan's production flag cutovers including `PANE_CLOUD_CREATE_DISPATCH=on`. Staff Go remains required for every real HMS write.
**Status of this steer:** recommended to the owner. **Not yet sent** to the running Sol session unless the owner confirms.

---

## 1. TL;DR

- The Option A run (Codex `forked sol ultra | zero`, terminal `term_f9666207-ff5f-4e98-b916-ad20f27de693`) started 14:42 UTC with a Tranche 1 target of 120–165m. At 19:05 it was **263m in**. Prod was still on **`0da451e`**: no deploy, no flag cutover.
- Merged to `main` (`dc26b3863`): **U0 #988, U1 Create #989, U4 prep #990**.
- U2 (Filing + Cancel) and U3 (Amend) work, but are **unmerged and still scope-growing**.
- **Decision recommended: ship what's proven now.** Deploy `main` (real Create) immediately. Freeze Amend and Cancel at their proven envelopes, merge, then deploy #2. Park U5/U6.

## 2. Current state (19:05 UTC)

| Item | Where | State |
|---|---|---|
| `origin/main` | `dc26b3863` | U0 + U1 + U4 merged; **deployable now** (real-guest Create) |
| Prod EC2 | `0da451e` | old SHA; 3 procs lab-mode; `remote-http` lacks prefill/write flags (per Sol 14:47) |
| Integration branch | `/home/orca/.codex/worktrees/22ad/zero` `codex/option-a-integrate-20261103` @ `258e671f0` | contains U2 commits `25bf7ef32`, `453a8930a`; **35 uncommitted U3 files** (amend runner/dispatch/session, price projection, nightly rates, tests; 3 server suites / 28 tests pass per Sol 18:45) |
| U3 Sol worktree | `/home/orca/.codex/worktrees/ee01/zero` | Sol (`/root/u3_sol`) mid **authorized fake-fixture write** to create varying nightly rates (`/tmp/nava-u3-rate-probe-HLLwep/save55→save65.mjs`). **Do not kill mid-write**; reconcile first |
| U2 finance probes | `/tmp/zero-option-a-u2-finance.uUUJ1I/probe*.mjs` (12 so far) | Terra (`/root/u5_native_new_read_recon`, repurposed) probing folios/deposit accounts (`OSACCT.HDR`) to widen Cancel beyond NGI |
| Other worktrees | `aceb` (U1, merged), `810e` (U2), `d4c4` (coordinator) | — |

### Proven native facts
- **Amend retain-rate:** two-Save sequence **without** the redundant availability call keeps booked rates. Evidence: 3 nights at R2,610 retained against a fresh R2,830 quote, with fresh readback (`report-save52.json`). Production prepare/commit returns `amended` (Sol 18:37). An extension probe observed a 4th night at R2,610 (17:51). Not yet wired as a supported case.
- **Cancel:** Cloud path is gated to **NGI-only**. `deposit === 0` does **not** prove there are no payments or secondary folio charges, so a wider gate needs folio proof.
- **U5 recon:** native New Profile unsaved preview works. HRCEN requires first name, last name, mobile and status. Persistence and duplicate handling are unproved.

## 3. Retro: why 263m and not 165m

Full analysis: `~/.gemini/antigravity-cli/brain/cd12dfc8-785f-461d-8001-fa996eac521a/sol-ultra-retro-2026-11-03.md`

| Unit | Plan | Actual |
|---|---|---|
| U0 | 20m | 34m |
| U1 | 65m | ready at 16:51 (95m), then **89m idle** until merge at 18:20 |
| U2 | 45m | 226m+ |
| U3 | 65m | 258m+ (77 probe scripts) |
| U4 | 35m | not started |

Root causes, ranked:
1. **Uncalibrated ETA.** The prior handoff called Amend a "15-line fix, 65m" without native proof. Every native-HMS unit today overran 1.6–4×.
2. **Single release gate.** U4 waited on U1+U2+U3 together, so Create sat finished behind Amend research.
3. **Unbounded proof-seeking.** "No scope cut / never infer" on a max-reasoning model kept adding cases: varying rates, extensions, broader Cancel. U5 recon also ran during Tranche 1.
4. **Fork derail.** The session was forked from a chat whose last ask was "give me a /goal prompt". 6 of 7 compactions produced a wasted `/goal`-prompt turn, and one spawned the `goal_prompt_scope_check` agent.

Not the cause:
- **Tests.** Focused runs took a few minutes each.
- **Reviews.** Six reviewers found about 11 **real** write-safety bugs, e.g. 2× P1 alias overlapping holds, Cancel Go showing a cached guest, Cancel A→B transition, a 2027 floor left in approval, a midnight date bug. Keep reviews.

## 4. Next actions (ship-now)

1. **Deploy `main` now (real Create)**, in parallel with step 2:
   - `bash /home/orca/bin/remote-typecheck.sh <clean worktree @ main SHA> --app mail` and `--app server-pilot`
   - `ops-deploy.sh` bundle sync.
   - Create flags on all 4 PM2 procs (`http`, `worker`, `ai-worker`, `remote-http`). Use the **merge-preserving env writer**: Sol 18:04 found that writing only the new flags drops unrelated settings.
   - Verify each process's effective env, then run 1 live canary.
2. **U3 Amend freeze:**
   - Reconcile the in-flight fixture write.
   - Support only **date shift with the same night count + adult change**, where retained readback matches.
   - If the night count changes or saved nightly rates are not uniform → **HOLD** with "amend manually in HMS".
   - Commit the 35 files in `22ad`.
3. **U2 Cancel freeze:** ship NGI-only as gated. Stop the folio-widening probes.
4. **Deploy #2:**
   - Merge U2+U3 (PR → final-head remote typecheck for both apps → Greptile Apex → validate P0/P1 → `scripts/orch/merge-gate.sh`).
   - `ops-deploy.sh` → `PANE_WRITE_ATTACH`, `PANE_WRITE_AMEND`, `PANE_WRITE_CANCEL_UNPAID` on → canary per workflow.
5. **Park U5/U6.** Start Tranche 2 in a **fresh, non-forked session** with a short goal. Realistic U5+U6: **4–8h** (the plan said 165–210m).

### ETA (evidence-based)
- Ship-now path to Tranche 1 live: **P50 ≈ 75–90m, P90 ≈ 2.5–3h.** Basis: today's PR open→merge times (#988 21m, #985 27m, #986 24m), remote typecheck about 2–5m per app (12:26–12:28 logs), bound-guard change 30–45m with one review loop, and deploy + flags + canary 20–30m (estimate, not measured today).
- Continuing as-is: **no predictable ETA.** No convergence signal.

### Steer message (paste into the Sol terminal once the owner confirms)
```text
OWNER STEER — ship-now, overrides scope-growth. No new authority needed.
1. NOW, in parallel: deploy current main (U0+U1+U4 = real Create). Remote typecheck that SHA (mail + server-pilot) → ops-deploy.sh → Create flags on all 4 PM2 procs → 1 canary.
2. U3 Amend: finish/reconcile the in-flight fixture write, then FREEZE at the proven envelope: date shift with the same night count + adult change, retained readback must match. If the night count changes or saved nightly rates are not uniform → HOLD with "amend manually in HMS". No more varying-rate/extension probes before deploy.
3. U2 Cancel: ship NGI-only as gated today. Stop the folio/deposit widening probes.
4. Merge U2+U3 → typecheck → Apex → merge-gate → deploy #2 → Filing/Amend/Cancel flags → canary.
5. Park U5/U6 and all recon until both deploys are verified. Report the release SHA and canary proofs, then stop.
Safety unchanged: exact native guards, staff Go, readback, penalty abort, NGI gate.
```

## 5. Holds and constraints (unchanged)

- Never accept penalty dialogs, test against pilot RDS, bypass hooks, or blind-retry uncertain writes. CMS and auto mail-send stay off.
- Unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL` before tests. Report DB-backed suites as skipped.
- Do not touch dirty files in root `main` (`/home/ubuntu/projects/zero`). Do not use Hindsight.
- Live writes that touch the same confirmation must be serialized (per-target dispatch key from U0).

## 6. Evidence sources

- Coordinator rollout: `~/.codex/sessions/2026/11/03/rollout-2026-11-03T14-38-36-01a1a1a2-…_01a1a1d9-02a3-7553-9057-676ad7440715.jsonl`
- Sol U3: `…T15-27-01-01a1a205-…jsonl`; U2 finance / U5 Terra: `…T17-34-56-01a1a27a-…jsonl`
- Goal text: `/home/orca/.codex/attachments/7560d57f-7ce9-4d29-ae01-3a151fc122fc/pasted-text-1.txt`
- Probe artifacts: `/tmp/nava-u3-rate-probe-HLLwep/`, `/tmp/zero-option-a-u2-finance.uUUJ1I/`
- PR timings: `gh pr list --state all` (#985–#990)
