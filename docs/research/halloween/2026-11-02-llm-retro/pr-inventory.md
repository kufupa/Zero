# Open pull requests: complete inventory

Snapshot: 2026-11-02 ~19:15 UTC. GitHub returned 47 open PRs, including 29 drafts. The coordinator subsequently closed #658 after proving its documentation exists on main and #802 after comparing its paired Booker behavior and guards with merged #807; **45** open, including 28 drafts, remained at 19:36 UTC. Both rows remain below for the complete original snapshot. Mergeability is GitHub's computed state against the **listed base**, not necessarily main, and may change asynchronously. Lines include tests, docs and generated files; they are not the product-line merge gate. Behavior and disposition: [early detailed audit](pr-audit-early.md), [later detailed audit](pr-audit-late.md), and [plan/worktree reconciliation](2026-11-02-pr-worktree-audit.md).

| PR | Title | Base | State | Mergeability | Total diff lines |
|---|---|---|---|---|---|
| [#488](https://github.com/kufupa/Zero/pull/488) | fix(hms): log dismissed browser dialogs during create | `main` | open | unknown | +32/−3 |
| [#651](https://github.com/kufupa/Zero/pull/651) | fix(hms): copy Guest Stay date fields onto the bound record [F2e] | `main` | draft | unknown | +182/−1 |
| [#658](https://github.com/kufupa/Zero/pull/658) | docs(plan): Da Vinci full-field provisional booking plan | `main` | **closed after snapshot** | unknown | +570/−0 |
| [#689](https://github.com/kufupa/Zero/pull/689) | fix(intake): preserve case identity in prefill | `main` | draft | unknown | +1870/−98 |
| [#690](https://github.com/kufupa/Zero/pull/690) | Hold unverified HMS saves across a property | `main` | draft | unknown | +1567/−161 |
| [#691](https://github.com/kufupa/Zero/pull/691) | Require an explicit HMS create mode | `main` | open | unknown | +287/−79 |
| [#692](https://github.com/kufupa/Zero/pull/692) | Guard property leases and supervise HMS children | `main` | draft | unknown | +644/−3 |
| [#693](https://github.com/kufupa/Zero/pull/693) | Add server-owned one-room create approval plans | `main` | draft | unknown | +763/−5 |
| [#694](https://github.com/kufupa/Zero/pull/694) | Bind Centurion quotes to complete child occupancy | `main` | draft | unknown | +1379/−63 |
| [#695](https://github.com/kufupa/Zero/pull/695) | Keep uncertain pane saves fenced and outcomes distinct | #690 | draft | mergeable | +827/−591 |
| [#696](https://github.com/kufupa/Zero/pull/696) | Keep case identity bound across quote edits | #689 | draft | mergeable | +869/−120 |
| [#697](https://github.com/kufupa/Zero/pull/697) | Carry email identity and reject stale quote results | `main` | draft | unknown | +101/−37 |
| [#698](https://github.com/kufupa/Zero/pull/698) | Preserve child counts in prepared quote inputs | #697 | draft | mergeable | +1326/−134 |
| [#699](https://github.com/kufupa/Zero/pull/699) | Confirm child occupancy before a Centurion quote | #698 | draft | conflicting | +217/−75 |
| [#700](https://github.com/kufupa/Zero/pull/700) | Bind Centurion quotes to saved room occupancy | #698 | draft | mergeable | +1473/−57 |
| [#701](https://github.com/kufupa/Zero/pull/701) | Verify Centurion rate eligibility before quoting | #700 | draft | mergeable | +286/−43 |
| [#702](https://github.com/kufupa/Zero/pull/702) | Bind Centurion quotes to saved source details | #701 | draft | mergeable | +905/−93 |
| [#703](https://github.com/kufupa/Zero/pull/703) | Show Centurion rate averages only for complete stays | #702 | draft | mergeable | +58/−12 |
| [#704](https://github.com/kufupa/Zero/pull/704) | Bind Centurion quotes to saved party details | #702 | draft | mergeable | +1051/−65 |
| [#705](https://github.com/kufupa/Zero/pull/705) | Bind Centurion quote drafts to current source evidence | #704 | draft | mergeable | +1246/−52 |
| [#706](https://github.com/kufupa/Zero/pull/706) | Scope reversed-date warnings to the affected stay | #700 | draft | mergeable | +53/−10 |
| [#707](https://github.com/kufupa/Zero/pull/707) | Bind quote prices to the hotel that supplied them | #700 | draft | mergeable | +207/−19 |
| [#708](https://github.com/kufupa/Zero/pull/708) | Avoid reusing quote jobs from an older Centurion read | #704 | draft | mergeable | +209/−14 |
| [#709](https://github.com/kufupa/Zero/pull/709) | Track quote parties while the hotel catalogue loads | #704 | draft | mergeable | +47/−4 |
| [#710](https://github.com/kufupa/Zero/pull/710) | Hold unsafe prior quote reuse for Centurion | `main` | draft | mergeable | +74/−3 |
| [#711](https://github.com/kufupa/Zero/pull/711) | Hold quote prices when a thread changes hotel | #707 | draft | mergeable | +1070/−63 |
| [#712](https://github.com/kufupa/Zero/pull/712) | Expose a checked cursor for case recovery | #696 | draft | mergeable | +456/−18 |
| [#713](https://github.com/kufupa/Zero/pull/713) | Flush quote edits before saving webmail drafts | #705 | draft | mergeable | +115/−0 |
| [#714](https://github.com/kufupa/Zero/pull/714) | Wait for aborted quote child to close | `main` | draft | mergeable | +161/−2 |
| [#715](https://github.com/kufupa/Zero/pull/715) | Bind Centurion extraction and classification to their source | `codex/cen-source-witness-base-20261029t1025` | draft | mergeable | +988/−47 |
| [#716](https://github.com/kufupa/Zero/pull/716) | Hold unassigned Centurion guest edits | `codex/cen-source-witness-base-20261029t1025` | draft | mergeable | +761/−119 |
| [#764](https://github.com/kufupa/Zero/pull/764) | Add private evidence source contracts | `main` | open | mergeable | +375/−0 |
| [#798](https://github.com/kufupa/Zero/pull/798) | Prepare causal reservationist worker input | `main` | open | conflicting | +901/−45 |
| [#802](https://github.com/kufupa/Zero/pull/802) | Allow one-save paired Booker updates | `main` | **closed after snapshot** | conflicting | +223/−53 |
| [#808](https://github.com/kufupa/Zero/pull/808) | fix(quote): preserve unknown child occupancy | `main` | open | conflicting | +1165/−66 |
| [#809](https://github.com/kufupa/Zero/pull/809) | Use cited message view for stay dates | `main` | open | conflicting | +508/−10 |
| [#815](https://github.com/kufupa/Zero/pull/815) | refactor(reservationist): extract causal email intake normalizer | `main` | open | conflicting | +962/−58 |
| [#818](https://github.com/kufupa/Zero/pull/818) | Align reservationist draft message identity | #815 | open | mergeable | +157/−26 |
| [#830](https://github.com/kufupa/Zero/pull/830) | Preserve invoice continuations across email alternatives | #815 | open | mergeable | +94/−26 |
| [#831](https://github.com/kufupa/Zero/pull/831) | Wire reservationist preparation into inbound worker | #818 | open | mergeable | +789/−43 |
| [#832](https://github.com/kufupa/Zero/pull/832) | Prepare source-bound booking suggestions for staff | #831 | open | mergeable | +742/−17 |
| [#833](https://github.com/kufupa/Zero/pull/833) | Open prepared booking suggestions from the staff pane | #832 | open | mergeable | +442/−29 |
| [#835](https://github.com/kufupa/Zero/pull/835) | Surface unmatched voucher requests for staff review | #815 | open | conflicting | +309/−52 |
| [#836](https://github.com/kufupa/Zero/pull/836) | Preserve quote requirements across message views | `main` | open | conflicting | +448/−56 |
| [#845](https://github.com/kufupa/Zero/pull/845) | Prepare source-bound reservationist email context | `main` | open | mergeable | +1182/−24 |
| [#850](https://github.com/kufupa/Zero/pull/850) | fix: bind cross-view stay dates by unique endpoint | `main` | open | mergeable | +602/−23 |
| [#887](https://github.com/kufupa/Zero/pull/887) | Guard section reset against newer revisions | `main` | open | conflicting | +33/−1 |

For a base shown as another PR, the head of that PR supplies the branch. A base branch without a listed open PR is shown by name; it may still exist or contain valuable commits. Confirm head SHA, ownership, base, checks and unique behavior again before closing or merging.

