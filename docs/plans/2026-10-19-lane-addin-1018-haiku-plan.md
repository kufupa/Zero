file could break it), and the time.
Before the plan is final, two facts decide whether Task 4's "PASS" means anything: whether the Zero EC2 clone has the private VSTO source, and what Oxlint version the repo pins. Both are read-only. I'm also pulling the tail of OWNER-ASKS, since your ask rule says to log each new ask there.
Plan review done. Logging the asks and the ETA ledger row first, then I'll write the reply with the plan and wait.
Next I need to check whether the Zero contract test fails or silently skips when the submodule is absent. The plan's "PASS" expectation depends on that.
Before finalizing, I need to check three things that could break the plan. First, whether the Zero commit hook runs tsc or project-wide lint on this VPS. Second, whether a Zero deploy builds from the submodule, which decides if merging the pin reaches staff. Third, whether the `_webView` ordering check I flagged is really vacuous.
# Lane E plan: Outlook add-in 1.0.18, the client reviewer hardening

**Plan ready. About 140 min from your approval to a merged Zero PR (band ~85–195, your reply time excluded). The plan as written has 12 defects, and 6 of them would fail a check or pass it for nothing. Four decisions (A–D) block code.**

- **Read before this plan** (origin/main: Zero `57b23c965`, add-in `47d0d9d`): PRODUCT.md, AGENTS.md, AGENT.md, docs/context/ACTIVE.md, OWNER-ASKS.md, research README (head), the plan, the ETA ledger, the Zero VSTO contract tests (skip blocks), add-in `TaskPaneControl.cs`, `ThisAddIn.cs`, `native-hardening.test.mjs`, `outlook-vsto.yml` and both remote scripts (parts).
- **Not re-checked:** the the client reviewer items marked "already done" (PaneUrl, Drafts-first). I take them as owner-locked.
- **Corrections:** my 55-min and 110-min ETAs are superseded. The 110 row mixes raw and scaled numbers. The 140-min row is not written yet, because you said no tool calls before the plan.
- **Context 160k of 300k (53%):** past AGENTS.md's 150k handoff line. The handoff goes into the plan file before code starts.

---

## 0. Asks logged this turn

| # | Ask | Status | Where |
|---|---|---|---|
| 121 | Run the the client reviewer plan. Fresh clone for Tasks 1–3, this worktree for Task 4 only. Commit plan in Task 4 PR. Plan → you → code. Stop after Task 4. No email, no installer publish. Approvals only from you, in chat. | 🟡 waiting on A–D | This plan; [OWNER-ASKS §10](/home/orca/orca/workspaces/zero/oct19-addin-1018/docs/context/OWNER-ASKS.md) |
| 122 | Greptile CLI review on every PR before push-for-merge. Fix or validate every P1, two rounds max. Zero on. Add-in off, so Haiku diff-only. Never `greptile init`. | 🟡 | §2 |
| 123 | Stop checking. Post plan with steps, ETA per step, owner needs. Unchecked = assumption. No tool calls before plan. | ✅ answered here | Row written on next write |

---

## 1. Plan as written: 12 defects, 6 break a check

| # | Plan says | Reality (checked) | Amendment |
|---|---|---|---|
| 1 | Task 1 test: `catch\s*\(` | Plan code is bare `catch {`. Test fails on its own code. | `/catch\b/` |
| 2 | Task 2 test and Zero Task 4: `_webView.Dispose()` | Plan code is `_webView?.Dispose()`. No match. | `if (_webView != null) _webView.Dispose();` inside the try |
| 3 | Order check `indexOf(Dispose) < indexOf(Clear)` | Missing Dispose gives -1, so the check passes for nothing. | Require `> -1` first |
| 4 | Task 2 Step 4: `Write("toggle_pane_failed", ex)` | [ThisAddIn.cs:174](/home/orca/work/nava-outlook-addin-1018/NavaOutlookAddin/ThisAddIn.cs) is `catch (Exception)`. `ex` is undefined, so compile error. | `catch (Exception ex)` |
| 5 | the client reviewer "failed WebView null-and-reopen" is covered by ShowPaneError | Null-and-reopen is ToggleTaskPane [L174–177]. ShowPaneError never reopens. Step 4 skips disposing the failed control, citing a Zero rule that "forbids Remove almost file-wide". The Zero test slices only from `ThisAddIn_Shutdown` [L185], which sits below toggle. | Decision D |
| 6 | Task 3 stamp list | Misses [RegisterTrust.cs:13–14](/home/orca/work/nava-outlook-addin-1018/installer/RegisterTrust.cs), `outlook-vsto.yml` L90, L107, L111, L172, L284 (`version = '1.0.17'`), and `release-identity.test.mjs` L12–13, L27 (these fail after the bump). | Full list: 23 sites, 9 files (grep) |
| 7 | Task 3 Step 4: 4 mjs files | CI runs 7. Adds native-mailbox-sync, read-policy, move-consent. Baseline `node --test tests/*.mjs` = 74/74 at `47d0d9d`. | Run the full set |
| 8 | Task 4 Step 1: version test goes red, then green | Test sits in `describe.skipIf(!hasVstoSource)` ([L44](/home/orca/orca/workspaces/zero/oct19-addin-1018/apps/server-pilot/tests/vsto-source-contract.test.ts)). VPS submodule uninitialised (`-47d0d9df`). EC2 `apps/server-pilot/vsto` is an empty dir (SSM, read-only). Skipped means no red and no green. | Decision B |
| 9 | Task 4 Step 2: `pnpm exec vitest` by hand, "Expected PASS" | Sanctioned path is `remote-vitest.sh`, which ships committed HEAD only. Exit 0 also when everything is skipped. | Use the wrapper. Pass = 0 skipped + expected test count |
| 10 | File map: install-doc SHA "after CI hash known". Task 5 Step 3: record after virus check. | Contradiction. The doc still says 1.0.17, "verified on the server". | Record the 1.0.18 SHA only at Task 5 publish |
| 11 | No review gate | You asked for Greptile on Zero and Haiku on the add-in. | §2 |
| 12 | "Submodule update to merged SHA" | Submodule not initialised. `gh` is the github.com credential helper (checked), so `git submodule update --init` works. | Init, then pin the merge SHA |

---

## 2. Review gates: Greptile on Zero, Haiku on add-in

| Repo | Gate | Rounds | P1 rule | Status |
|---|---|---|---|---|
| kufupa/Zero (this worktree) | `greptile review --agent` on committed commits (merge base → HEAD; uncommitted excluded). Runs before the push. | 2 max | Fix or validate every P1. New P1 after round 2: check real path and impact, fix real ones, send the rest to you with a one-line reason. Never merge with an unvalidated P1. A fresh adjacent P1 at round 3 is a design flag: split or redesign. | **On** (`greptile whoami`: org NAVA) |
| kufupa/nava-outlook-addin | **No Greptile.** Fresh Haiku, max effort, diff-only (`git diff origin/main...HEAD`), new agent each round. | 2 max | Same P1 rule | **Off, your call.** No add-in code goes to Greptile until you say on. |

- Add-in Haiku brief lists the plan's hard constraints: no WinVerifyTrust, `File.Copy` overwrite kept, no Root CA, no PII in log, no Remove in shutdown, exact comment kept, PaneUrl unchanged, no Send/Delete.
- The add-in is pushed early only to start the Windows build. Its merge waits for the gate.
- Zero base = remote default (assumed `main`; first run shows it). Never `greptile init`.

---

## 3. Steps and ETA: 140 min chain

Method: raw guess × ledger median (code-server **0.77**, n=102; review **0.87**, n=20). "Guideline" = no ledger rows.

| Step | Work | ETA min | Basis | Gate |
|---|---|---|---|---|
| S0 | Amendments 1–12 into plan file; ask 123 row; ledger row | 5 | 6 × 0.77 | — |
| S1 | Task 1: `NativeDiagnosticLog.cs`, csproj, test | 8 | 10 × 0.77 | — |
| S2 | Task 2: dispose failed WebView, log swallows, toggle per D | 12 | 15 × 0.77 (+5 if D = L) | — |
| S3 | Task 3: 1.0.18 stamps (23 sites, 9 files), test updates | 9 | 12 × 0.77 | — |
| S4 | Local: `node --test tests/*.mjs`; `mcs -t:library` on changed .cs, grep `error CS1` (syntax only) | 3 | guideline | — |
| S5 | 3 commits, push branch, open add-in PR (starts CI, no merge) | 2 | 3 × 0.77 | — |
| S6 ∥ S7 | Windows build on PR, in parallel with Haiku round 1 | 9 | max(CI 5, Haiku 9). CI = job time 1.4–1.9 min over 6 green runs (Oct 8–12), plus queue allowance. Installer minutes are authorised. | Decision C |
| S8 | Fix real P1s (cheap P2s too); push | 10 | fix 9 (review 0.87 × 10) + push 1 | — |
| S8b ∥ | CI rerun in parallel with Haiku round 2 | 9 | max(CI 5, Haiku 9) | Gate |
| S9 | Merge add-in PR | 2 | — | **your OK** |
| S10 | Zero: `submodule update --init`, pin merge SHA; 1.0.18 edits in contract L71–85 and nginx L15; keep `File.Copy(src, dest, true)` and no-Remove | 3 | 4 × 0.77 | — |
| S11 | Zero commit, local only (husky oxlint on staged .ts; no `--no-verify`) | 3 | 4 × 0.77 | — |
| S12 | Greptile round 1 (CLI) + P1 triage | 19 | CLI 10 (guideline) + triage 9 (review 0.87 × 10) | Gate |
| S12b | Fix real P1s, commit | 9 | review 0.87 × 10 | — |
| S13 | Greptile round 2 on fixed head; validate new P1s | 14 | CLI 10 (guideline) + validate 4 | Gate |
| S13b | Push Zero branch, open PR (push comes after the gate) | 2 | 2 | — |
| S14 | EC2 contract run (Decision B route): `remote-vitest.sh` on both VSTO contract files, require 0 skipped. Route set-up runs during S10–S13, off chain. | 15 | guideline; typecheck included unless `SKIP_TYPECHECK=1`; needs clean tree | Decision B |
| S15 | Zero merge (after your OK) + close-out: ACTIVE.md, ledger close rows, handoff | 6 | merge 2 + close-out 4 (5 × 0.77) | **your OK** |
| **Chain** | | **140** | ≈ 2 h 20 min. Band ~85–195. Guideline items: S4, S12, S13, S14, CI queue. Decision D = L adds +5 (145). | |

---

## 4. State now: nothing pushed, merged or published

- Add-in clone at `/home/orca/work/nava-outlook-addin-1018`, on `main` @ `47d0d9d`, no edits.
- Zero worktree: plan file untracked. OWNER-ASKS §10 rows 121–122 added, uncommitted.
- Ledger: lane-e start row (10:53Z, est 55). Revision row (11:34Z, est 110), superseded.
- Calls made: one read-only SSM call on EC2 (`ls`, `cat`, `git rev-parse`; the git part failed on dubious ownership, and I used the `ls` result). Read-only `gh` calls. `greptile whoami`. Local `node --test` (74/74). Scratch files in /tmp, removed.
- Not done: no add-in commits, pushes, PRs, merges, Actions triggers, deploys, mail, publishes, tsc, or Vitest.

---

## 5. Not doing

- **Task 5 is yours:** no publish, no `/download` change, no install-doc SHA before publish, no email.
- No deploy, flag, HMS or guest write.
- No Greptile on the add-in. No `greptile init`.
- No workflow beyond the add-in installer workflows. No new workflow or check.
- No merge without your OK. Push and PR-open are in the plan (S5, S13b).
- No `--no-verify`. No tsc or Vitest on this VPS.
- Commit and PR text carries the session attribution lines.

---

## 6. Assumptions not checked yet

- `greptile review --agent` works on local committed commits without a push. Base assumed `main`.
- Windows queue ≈ 0. Only job time is measured.
- EC2 typecheck + Vitest timing: no ledger rows. S14 is a guess.
- The Decision B route is buildable from existing scripts. Not written.
- C# syntax check on the real files not run. Only sample files tested.
- The EC2 typecheck clone is separate from the running app, per script comments. App path unchecked.
- Zero Actions: 4 seen disabled. `sync-production.yml` and `lingo-dev.yml` are missing from the API list. Their YAML runs on `staging` push or manual only. State unverified.
- Haiku or Greptile may add P1s. The chain assumes one fix round on each side.

---

## 7. Decisions I need from you (blocking)

| Decision | Option | Completeness X/10 | ETA added (min) | Value / ROI | Risk |
|---|---|---|---|---|---|
| **A. Plan** | Approve amended plan (1–12 + gate) | 9 | 0 | Unblocks code | None |
| A | Approve as written | 2 | 0 | Faster start | 6 failing or vacuous checks |
| **B. VSTO source on EC2** (contract tests skip today) | S3-bundle the add-in at merged SHA into the EC2 typecheck `vsto` path under the existing flock; run; require 0 skipped; delete after | 9 | 0 (set-up overlaps Greptile wait) | Runs the real Zero-side contract without your machine | Writes under `/home/ubuntu/typecheck` on prod EC2. Not the app dir (unchecked). |
| B | You run the two Zero contract files on your machine | 8 | your time | Real gate | Slow; drift |
| B | Skip the contract | 3 | 0 | None | Gitlink bump unverified on Zero side |
| **C. Windows build** | Wait for "Outlook VSTO installer" on the PR, then merge | 9 | 0 (parallel with Haiku) | Only full C# compile before merge | Conflicts with global "never wait for GitHub checks". Needs your exception. |
| C | Merge on Haiku review + `mcs` syntax; build at Task 5 | 4 | 0 | Nothing gained on time | C# semantic errors found at publish |
| **D. Toggle path.** the client reviewer item "failed WebView null-and-reopen" (locked: dispose before reopen) | P: as amended. No toggle dispose. Log as open. | 5 | 0 | No new live-pane risk | Locked item not done. Old pane can linger (1.0.17 behaviour). |
| D | L: dispose failed pane + `CustomTaskPanes.Remove` in try | 9 | +5 | Matches the lock | Remove on a live pane. Not testable in Outlook here. |

**Recommendation:** A amended (fixes 12 defects). B S3-bundle (runs the real contract without your machine). C wait (+0 min, only compile proof). D P (L can't be proven in Outlook here, and the pane is live; log L as a follow-up after an Outlook test). Reply "A-amended, B-S3, C-wait, D-P" or pick differently.

FYI, not blocking:
- Each merge (add-in, then Zero) needs your OK in this chat. PRODUCT.md says Opus does merges; I'm Haiku. Say if Opus should run the merge.
- One add-in PR, 3 commits, per your plan (≈150 product lines, under 500). AGENTS.md says one behaviour per PR. Say if you want two (+≈15 min).
- The plan names client staff (the client reviewer, the client contact, one staff user). Committing it and running Greptile sends those names to Greptile. Kept as written unless you say redact.
- At approval I write the handoff into the plan file. You may `/clear` after that.

---

## 8. Running lanes and open topics (ROI order)

- **Running lanes:** none. Lane E paused at plan.
1. **Lane E, the client reviewer add-in 1.0.18:** blocked on A–D. Client reviewer waiting.
2. **Quote read_tool live proof** on `extract-3ccdd9c9966e` (ACTIVE next check). Not started. Needs a quote-class inbound.
3. **Owner pass on 180 silver disagreements** (ACTIVE). Owner's call.
4. **Azure content-filter blocks** (ACTIVE). Owner decision.
