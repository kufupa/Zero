# HMS Cloud lane brief (paste at top of every lane and subagent)

Owner direction, 2026-11-01. Keep this block through compaction. If a rule here conflicts with an older doc, this wins; flag the conflict.

## Rules (12)

1. **Build new.** Modular tools in `apps/server-pilot/tooling/hms-cloud/` for the Centurion Cloud UI. `tooling/playwright-quote/` is reference only: never edit it, never call it from new code.
2. **Product, not Labtest.** Inputs are general (any guest, rate, guarantee, party, CMS code). Labtest is only the proof target. Never hard-code NGI, a rate or blank A/R as a product rule.
3. **Saves.** Save only on Proof Labtest stays dated 2027 or later. Real stays: open, type, explore freely, then close without saving.
4. **Never send.** CMS checkbox, ID and email are optional; suggest `03`, allow change or clear. A save with the send box checked returns `unsupported`.
5. **Never accept a cancellation-penalty dialog.**
6. **Every save:** screenshot the filled form, save once, screenshot the result, reopen the stay and read it back. No blind retry.
7. **Prove one, generalize by design.** One representative Labtest save per distinct behavior. No per-field, per-rate or per-combination proofs.
8. **Tests are small.** One happy path and one refusal per tool. The live Labtest run is the real test.
9. **PR size.** One behavior, at most about 250 product lines and 300 test lines. Never stack on an unmerged PR.
10. **No new frameworks.** Reuse existing sessions and `page-request-fence.mjs`. No new guard, queue or fixture system.
11. **Property read lock is legacy.** New Cloud tools do not use it. Do not add it, do not spend time on it.
12. **Do not block.** Unknown or low-ROI field: pick the sensible default and add one row to the decision log (field, choice, why, evidence). Ask the owner only for real-guest writes, sends, deploys or flags.

## Lane slot (fill per lane)

- **Goal:** one sentence.
- **Owned files:**
- **Input / output schema:** table.
- **Done when:** named Labtest proof with screenshot and readback, PR merged through `scripts/orch/merge-gate.sh`.
- **Report:** caveman, at most 10 lines, every 30 minutes: proved / merged / blocked / next.

Checks: remote typecheck and Product EC2 tests only, Greptile Apex on final head, fix valid P0/P1, never `--no-verify`, unset `DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` before Vitest.
