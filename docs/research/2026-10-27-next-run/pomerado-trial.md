# Pomerado Labtest Add-On trial — 2026-10-27

**Verdict:** Not ready for a live write. Smallest safe fit is a single, Zero-governed Add-On operation using Pomerado as an authoring aid—not a runtime replacement. Blockers: no verified Add-On row reader, no proven Azure provider bridge, and no confirmed shared per-hotel browser lock for Pomerado.

## Evidence boundary

- Static source at `92be0e5d2` (`HEAD` = `origin/main`). Public npm metadata and the exact `.439` tarball inspected; tarball extracted for source reading only. No install, execution, EC2/production access, HMS interaction, model call, flag flip, or deployment.
- Reused [prior Pomerado source-fit](../2026-10-26-pomerado-source-fit.md) and the Pomerado lane in [Plan 007](../../plans/2026-10-26-007-dv-faith-run-plan.md#L129-L134), plus [Add-On setup, trial, and sizing](../../plans/2026-10-26-006-addons-ux-speed-plan.md#L105-L108) and [B0–B2 units](../../plans/2026-10-26-006-addons-ux-speed-plan.md#L129-L132). Those are planning/source evidence, not live proof.

## Readiness matrix

| Contract | Ready | Missing / limit |
|---|---|---|
| Version | npm `canary` is `0.4.0-canary.439`; `latest` and GitHub latest release remain `.399`. `.439` requires Node `>=24.21.0 <25` and peer `@openai/agents@0.18.0`; tarball integrity: `sha512-c42Z1+Ev0/X4VBw/6mfkpXxTpxdgA/Fi/Ozt9IpaXLHZPYhoHneuUP3c+KaZatF0GsBJElKAc/R/b16eAkqSSQ==`. | `.439` has no `gitHead` and no matching GitHub tag. Pin exact tarball/version; validate target Node before any trial. |
| Browser | `.439` low-level Playwright executor accepts CDP. Standalone host supports a Playwright `launchServer` endpoint. | Standalone browser options omit CDP and `makeSession` rejects it. Nava's `slot-owner.mjs` uses `launchPersistentContext` + CDP, not `launchServer`. `createPomerado` exposes no executor injection. No config-only attachment to Nava's current slot. |
| Model | `.439` exposes separate `minterProvider`, `guardianProvider`, and `outcomeReviewerProvider` hooks. Nava already has Azure Foundry config in `ai/bedrock/luna.ts`. | Nava's `ModelAdapter` / AI SDK model is not an OpenAI Agents `ModelProvider`. Build a bridge and explicitly route all three roles to the approved Azure ZDR endpoint. No provider invocation/routing proof exists; model labels alone do not prove deployment. |
| Write recovery | Pomerado reports `possible_commit` / `may_have_applied`; its failure text says read back before retry. | No Add-On idempotency or Nava authorization boundary is supplied by Pomerado. Zero must reconcile from a fresh native read; never blindly replay an uncertain write. |
| HMS / pane | HMS manifest has Add-On screen resources and sort/required-field names. Existing create path has preview/commit and Labtest guard patterns. | No deterministic Add-On catalog/row reader or writer found. `hms_read_folio` is not an Add-On row reader. `PaneStay` has no Add-On rows; no pane integration is needed for this trial. Screen resource names do not prove save, removal, or readback semantics. |
| Runtime | One HMS browser lock per hotel is a hard rule. | Current Node version, two usable HRDAV Labtest stays, Add-On inventory, and lock interoperability with a Pomerado-owned browser are unverified. Do not run side-by-side browsers without an exclusive property lock. |

## Smallest safe trial contract

1. **Pin and preflight.** Use exact npm `.439` tarball/integrity. Confirm compatible Node, HRDAV target, and two existing fake `Proof Labtest` stays dated 2027+. Prior Plan 006 proposes a Pomerado-owned browser, with B0/B1 only when no production HMS job is in flight for that property (or a second login); this is a scheduling proposal, not proof of current lock/runtime behavior. Keep the full trial serialized under the one-browser rule. Do not create extra reservations. If exclusive use cannot be assured, stop.
2. **Read-only first.** Inspect the native Add-On catalog and both stays' current rows. Establish exact item code, quantity, amount/currency, date/charge semantics, and a stable row identity. Build or prove a deterministic fresh-navigation Add-On reader first. If native rows cannot be read unambiguously, do not write. A folio summary is not a substitute.
3. **One-row authoring proof.** On Labtest A only, Zero validates the exact stay/property/item/current-row snapshot, presents a one-row preview, and requires an explicit grant for that exact action. Treat any Pomerado mint/author step that reaches HMS as the write itself—not offline code generation. Commit once; capture HMS screenshot and result.
4. **Independent reconciliation.** Freshly read the stay and verify the exact row. On `possible_commit`, `may_have_applied`, timeout, or lost response, stop and read back before any retry. If row identity is ambiguous, stop for human reconciliation.
5. **Removal and replay.** Remove that same row through the same guarded path; independently read back absence. Inspect the generated artifact, then replay only against distinct Labtest B, verify the row, remove it, and verify absence. Never test with a real guest, penalty dialog, send, shuttle policy, or inferred fee.

Zero boundary should be a separate Add-On preview → explicit grant → commit operation, with Labtest-only validation, per-row outcome, screenshot, and fresh readback. Keep this out of `PaneStay` create and do not change the staff pane in this trial. If the current shared lock cannot be acquired by the runner, the isolated-browser option is not safe; stop rather than bypass it.

## Adapter versus rewrite size

- Existing Plan 006 B2 (`#L132`) gives a **planning estimate**, not a measured diff: **120–200 product LOC + 80–120 test LOC** for a Zero-owned Add-On wrapper with `PANE_WRITE_ADDON=lab`, property from mailbox, per-row result, readback-before-retry, and no create replay. This is the only source-grounded range available; it does not size the package or live HMS DOM work.
- A separate Pomerado-owned `launchServer` browser avoids a custom browser-host adapter but still needs Zero's lock and write boundary. No defensible LOC range exists for a safe custom-CDP host: standalone rejects CDP, and low-level CDP executor support does not supply the missing host lifecycle/injection. Full runtime rewrite is unsupported and out of scope.

## 95 threshold and source links

**Not met for execution readiness.** Code establishes the compatibility blockers; only a read-only native inventory, a proven shared lock, and a non-sensitive Azure routing smoke check can close them. No live state is inferred.

- Pomerado npm tags: https://registry.npmjs.org/-/package/pomerado/dist-tags
- `.439` package metadata: https://registry.npmjs.org/pomerado/0.4.0-canary.439
- `.439` tarball: https://registry.npmjs.org/pomerado/-/pomerado-0.4.0-canary.439.tgz
- `.439` package source under `/tmp/pomerado-canary439.SprFki/package`: `dist/typescript/src/standalone/contracts.d.ts:9-20`; `standalone/session.js:7-10`; `execution/playwright-execute.d.ts:17-22,58-63`; `runtime/run-outcome.js:360-471`; `standalone/failure-text.js:3-21`; `standalone/mint-host.js:49,135-138`; `standalone/request-context.js:191-198`.
- GitHub latest release: https://api.github.com/repos/Pomerado/pomerado/releases/latest
- Owner's Azure ZDR approval: [OWNER-ASKS.md ask 266](../../context/OWNER-ASKS.md#L406); this does not prove Pomerado routing.
- Nava browser slot: `apps/server-pilot/tooling/playwright-quote/slot-owner.mjs:79-84`
- Nava Azure adapter/config: `apps/server-pilot/src/ai/bedrock/luna.ts:119-129`; `apps/server-pilot/src/ai/bedrock/adapter.ts`
- Add-On evidence: `apps/server-pilot/src/hms/live-read-manifest.ts:710-756,879-887`; `apps/server-pilot/src/hms/read-tools.ts:457-508`
- Pane contract: `apps/server-pilot/src/ai/pane-stay-save.ts:59-85`; `apps/mail/lib/quote-workflow/pane-stay-bind.ts:75-108,157-173`
