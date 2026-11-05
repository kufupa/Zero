# Git and Orca worktree inventory

Initial snapshot: 2026-11-02 ~19:10 UTC. Git listed **40** worktrees: **26 dirty**, **14 clean**, **one detached** and **one locked**. Orca listed 28 local trees and 18 terminal records; the 12 remaining Git trees are Claude-managed, and their runtime activity was not established by Orca. The snapshot may become stale immediately. Three specific clean, inactive checkouts were removed after the further checks below; no dirty worktree or session was removed.

Paths: `R` = `/home/ubuntu/projects/zero`; `C/` = `/home/orca/.codex/worktrees/`; `O/` = `/home/orca/orca/workspaces/zero/`; `A/` = `/home/ubuntu/projects/zero/.claude/worktrees/`. Short HEADs identify the snapshot. `dirty N` counts tracked and untracked paths individually. `terminal` means Orca had a connected, orphan-marked terminal record: this is a reason to protect, not proof that someone is typing. Claude-tree activity marked unknown means Orca did not establish it; plan 005 separately recorded AGT-F/A/M as idle at 18:55 UTC.

| Tree | Branch @ HEAD | State | Observed activity and proposed disposition |
|---|---|---|---|
| `R` | `main` @ `a0c9f615` | dirty 245 | Main; Claude working and five terminal records; protect. HEAD advanced to `14e958b6` by ~19:12 UTC. |
| `C/1b2b/zero` | `kufupa/hms-quote-board-alias-successor-20261101` @ `259576b1` | dirty 2 | No Orca agent/terminal; preserve dirty changes. |
| `C/317a/zero` | `refactor/hms-shared-saved-amend-lifecycle` @ `e79b2b7c` | dirty 2 | No Orca agent/terminal; preserve. |
| `C/72d3/zero` | `codex/hms-create-u2-followup-20261101` @ `133b2164` | clean | No Orca agent/terminal, but has an Orca child worktree with a terminal; preserve. |
| `C/9b5c/zero` | detached @ `a2ec3594` | dirty 5 | No Orca agent/terminal; detached, preserve. |
| `C/9c96/zero` | `codex/reservationist-xlsx-intake-20261031` @ `24a6fb64` | dirty 2 | No Orca agent/terminal; preserve. |
| `C/9cdc/zero` | `kufupa/labtest-readonly-preimage-diagnostic-20261101` @ `82c1af0f` | dirty 1 | No Orca agent/terminal; preserve. |
| `C/adcf/recover-parse-failure` | `codex/stay360-browser-benchmark-20261029` @ `aa81f31a` | dirty 3 | Terminal record; protect. |
| `C/cae5/zero` | `feat/hms-saved-amend-date-occupancy` @ `c8ffcda6` | dirty 5 | No Orca agent/terminal; preserve. |
| `C/gdate-zero` | `fix/reservationist-group-date-correction-apex` @ `7745a30d` | dirty 1 | No Orca agent/terminal; preserve. |
| `O/box2-amend-20261101` | `kufupa/box2-amend-20261101` @ `62254068` | dirty 8 | No Orca agent/terminal; preserve. |
| `O/box2-create-parties` | `kufupa/cloud-create-billing-reference` @ `1d3efe03` | clean | PR #878 merged; no active worker/terminal; removed after preserving tip. |
| `O/box2-date-room-rate` | `kufupa/box2-saved-native-room-rate` @ `0627764a` | clean | PR #875 merged, but a retained worker record needs reconciliation; preserve. |
| `O/box2-documents` | `kufupa/cloud-document-attachment` @ `8156fb3d` | clean | PR #874 merged; no active worker/terminal; removed after preserving tip. |
| `O/box2-documents-20261101` | `kufupa/box2-documents-20261101` @ `1161a277` | dirty 2 | No Orca agent/terminal; preserve. |
| `O/box2-occupancy-write` | `kufupa/box2-occupancy-reprice` @ `f581241b` | clean | PR #876 merged; no active worker/terminal; removed after preserving tip. |
| `O/box2-quote-folio` | `kufupa/cancellation-preflight-facade` @ `012ea423` | clean | PR #877 merged, but retained worker records need reconciliation; preserve. |
| `O/box2-two-room-20261101` | `kufupa/box2-two-room-20261101` @ `62254068` | dirty 2 | No Orca agent/terminal; preserve. |
| `O/centurion-evidence-investigation` | `kufupa/centurion-evidence-investigation` @ `e9b99814` | dirty 1 | Terminal and ready/dispatched worker; protect. |
| `O/connected-pilot-integrator-20261102` | `kufupa/connected-pilot-integration-20261102` @ `90319e29` | clean | Terminal; plan 005's integrator; protect/reuse. |
| `O/hms-create-body-diagnostic-20261101` | `kufupa/hms-create-body-diagnostic-20261101` @ `f80b5eb8` | clean | Terminal; protect. |
| `O/hms-create-draft-inspect-20261101` | `kufupa/hms-create-draft-inspect-20261101` @ `a2ec3594` | dirty 5 | Terminal; protect. |
| `O/hms-create-nosave-probe-20261031` | `kufupa/hms-create-nosave-probe-20261031` @ `1b04436e` | dirty 1 | Terminal; protect. |
| `O/hms-labtest-room-amend-explore-20261031` | `kufupa/hms-labtest-room-amend-explore-20261031` @ `1885ce85` | clean | Codex working and terminal records; protect. |
| `O/hms-parallel-under2h-plan-20261101` | `kufupa/hms-parallel-under2h-plan-20261101` @ `62254068` | dirty 2 | Terminal; protect. |
| `O/hms-read-finance-rooming-20261031` | `codex/hms-stay-total-editor-20261031` @ `dd345e17` | clean | Terminal; protect. |
| `O/hms-saved-note-booker-pair-20261101` | `kufupa/hms-saved-note-booker-pair-20261101` @ `a2ec3594` | dirty 3 | Terminal; protect. |
| `A/agent-a3c945a345bd14bb1` | `worktree-agent-a3c945a345bd14bb1` @ `d5965524` | dirty 13 | Runtime unknown; preserve. |
| `A/agent-a58d477dbd18020f4` | `worktree-agent-a58d477dbd18020f4` @ `d5965524` | dirty 12 | Runtime unknown; plan 005 AGT-A; preserve/reuse. |
| `A/agent-a622b74da134a5ced` | `worktree-agent-a622b74da134a5ced` @ `d5965524` | dirty 18 | Runtime unknown; plan 005 AGT-F; preserve/reuse. |
| `A/agent-a649800c980aff834` | `worktree-agent-a649800c980aff834` @ `d5965524` | dirty 20 | Runtime unknown; plan 005 AGT-M; preserve/reuse. |
| `A/agent-a744e52868331d408` | `kufupa/history-snapshot-contract-20261102` @ `897bee39` | clean | Runtime/ownership unknown; verify before cleanup. |
| `A/agent-a8e94ecbcb0eba3ce` | `worktree-agent-a8e94ecbcb0eba3ce` @ `d5965524` | dirty 14 | Runtime unknown; preserve. |
| `A/agent-a90b160483c5888ce` | `worktree-agent-a90b160483c5888ce` @ `d5965524` | dirty 10 | Runtime unknown; preserve. |
| `A/agent-abfc09754025e9aa9` | `worktree-agent-abfc09754025e9aa9` @ `d5965524` | dirty 27 | Runtime unknown; preserve. |
| `A/connected-cancel-preview-reader-20261102` | `kufupa/cloud-cancel-preview-reader-20261102` @ `49758301` | clean | Runtime/ownership unknown; verify before cleanup. |
| `A/connected-cloud-availability-20261102` | `kufupa/cloud-availability-reader-20261102` @ `c462a1c2` | clean | Runtime/ownership unknown; verify before cleanup. |
| `A/connected-saved-stay-reader-20261102` | `kufupa/cloud-saved-stay-reader-20261102` @ `2bf138b1` | clean | Runtime/ownership unknown; verify before cleanup. |
| `A/three-connected-workflows` | `worktree-three-connected-workflows` @ `d5965524` | dirty 17; locked | Locked Claude session; preserve. |
| `R/.worktrees/recover-parse-failure` | `feat/centurion-stay360-ui` @ `cfe1bd02` | dirty 78 | Deploy tree and two terminal records; protect. |

## Cleanup performed after the snapshot

The six initial clean, attached candidates all had Orca workspace status `in-progress`, but their Orca process summaries were inactive. One was a parent of a tree with a connected terminal and was protected. The other five matched the exact heads of merged PRs #878, #875, #874, #876 and #877. No candidate was named by plan 005, had an Orca terminal, or had a process with that checkout as its current directory. A complete local worker listing showed retained context records referring to `box2-date-room-rate` and `box2-quote-folio`; those two were protected despite later released records for the same handles.

The remaining three had no active worker, connected terminal, dirty/untracked/ignored files or live process cwd; their corresponding merged PR heads matched the local HEADs. The source remote branch names were already absent from `git ls-remote`, so the exact tips were first protected under `refs/keep/2026-11-02-pr-retro/{box2-create-parties,box2-documents,box2-occupancy-write}`. Orca's exact-path `worktree rm --run-hooks` removed those three sequentially, without force. Orca also removed their local branch names; they were immediately recreated at the exact protected SHAs. No branch history was lost. Git and Orca now list **37** and **25** local worktrees respectively, with the three targets absent; terminal inventory also shows none of the targets. The pre-existing tracked changes in the main checkout were unchanged. The preserved refs are local and do not imply a remote backup.

No conclusion about remote-host activity follows from the local inventory. This cleanup did not close any open PR, remove the parent tree, touch either ambiguous retained-worker tree, remove a dirty worktree, force a deletion, or stop a session. A future cleanup should recheck live state rather than reuse this snapshot.
