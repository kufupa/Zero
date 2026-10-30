# Read-only runtime observation

**Observed:** 2026-10-30 02:29:27 UTC, through the repository's Systems Manager runner. This inspection read the pilot checkout, process metadata and one named configuration key. It did not call HMS, enqueue work, read the database, change flags, restart processes or deploy.

| Evidence | Observation | Limit |
|---|---|---|
| Pilot checkout | `00d814ca3071abb0262d9a50b1ed828c78cd6499`; ancestor of this research branch. | Checkout HEAD is not proof of the exact executable or bundle loaded in each process. |
| Source identity | On-box `quote-rate-switch.ts` and `staff-quote-run.ts` hashes match both that Git commit and this research worktree. | Matching source files do not prove current pane wiring, an HMS quote, or current price correctness. |
| Process manager | `http`, `worker`, `ai-worker` and `remote-http` each reported online. | Online does not establish end-to-end readiness, a successful quote or staff usage. |
| Named quote-rate context switch | The named key was absent from the inspected `.env.production`, each process's initial `/proc` environment, and PM2 configuration. The checked source treats an absent value as enabled. | This does not prove effective `process.env` after application initialization, all durable sources, current party binding, or a live HMS rate result. No other flags were checked. |

The inspection read only the named switch and emitted a normalized `unset`, `off` or `not_off` status, never other environment values. The observed source files were compared with `git show` of the observed checkout commit and the research worktree. The HMS capture evidence in [tool inventory](tool-inventory.md) is a separate historical read, not a current runtime test.

The non-sensitive [on-box inspection script](inspect-quote-runtime.sh) reproduced this limited check through the repository's existing Systems Manager runner at 02:30:50 UTC. It returned the same checkout, source hashes, process states and normalized switch observations. It is for an authorized operator, not hotel staff. It does not test the quote flow.

**Unavailable:** Current Centurion quote prices, staff-surface end-to-end behavior, and effective in-process switch values were not tested. The owner subsequently clarified that the HMS tools are being rewritten from scratch. This snapshot concerns the older runtime and does not prove or prioritize its quote path for the rewrite. A future probe of the new path would need an authorized, property-appropriate input and outcome validation.
