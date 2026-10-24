---
date: 2026-10-24
lane: P1 sizing (multi-hotel ce-plan)
model: GPT-6 Luna max (Sonnet slot)
method: read-only code read; no tests, prod or HMS
base: origin/main 1656bca50
---

# Multi-hotel P1 sizing — S1–S3

Basis: required `PRODUCT.md`, `ACTIVE.md`, `OWNER-ASKS.md` (#210–220), `docs/research/README.md`, `FACTS.md`, `CATALOG.md`, `WORKSTREAMS.md`, `AGENT.md`; shape brief + A1 read first. `origin/main=1656bca50`; target checkout `451761827`.
`[V]` verified in cited checkout/evidence; `[I]` sizing/design inference. LOC = product source touched, tests/generated churn excluded.

## 1. Slice sizing
- **S1 — shared registry + mailbox resolver, unknown refuses:** [I] **180–260 LOC**; new `packages/property-registry/{package.json,registry.json,index.mjs,index.d.mts}`. Registry owns property/transport/target identifiers; keep existing room/rate profiles as data for later slices.
- S1 edits: `apps/server-pilot/{package.json,src/hms/hms-read-target.ts,src/hms/hms-quote-target.ts,src/hms/mailbox-hms-origin-bind.ts,src/ai/pane-stay-spawn-env.ts,src/ai/pane-stay-save.ts,tooling/playwright-quote/property-registry.mjs,tooling/playwright-quote/property-profile.mjs}`; `apps/mail/{package.json,lib/quote-proposal/copy.ts}`; root `pnpm-lock.yaml`.
- S1 tests change: `apps/server-pilot/tests/{hms-read-target.test.ts,hms-quote-target.test.ts,hms-property-registry.test.ts,mailbox-hms-origin-bind.test.ts,pane-stay-spawn-env.test.ts,pane-stay-save.test.ts}`; `apps/server-pilot/tooling/playwright-quote/property-profile.test.mjs`; `apps/mail/tests/quote-proposal.test.ts`.
- S1 dependency: none; S2/S3 consume its stable registry API. `[V]` tooling registry and pane-spawn resolver already reject unknown transports; preserve that. Do not change `property-profile.mjs`'s explicit CLI-only omitted-`--property` HRCEN default into a mailbox rule.
- **S2 — seed per-mailbox ACL rows, no property grants:** [I] **20–45 LOC** if recipients already exist in seed; tests ~30–55 LOC. Edit `apps/server-pilot/src/db/seed.ts`; update `apps/server-pilot/tests/seed-contract.test.ts`. No new files.
- S2 dependency/hold: confirm each grant's recipient and exact rows from allowed source before coding. Shape line 66 says six prod-only grants; evidence says five DV mailboxes and prod 13 vs seed 7 (= six extra rows). `seedAll` prunes non-seeded users, so add a user/secret allowlist only if a grant recipient is outside `PILOT_USERS`; do not silently drop that user.
- **S3 — generalize HMS target, installation, slot, runtime and job guards:** [I] **300–450 LOC**; tests ~150–250 LOC. Edit `hms-read-target.ts`, `hms-quote-target.ts`, `production-runtime.ts`, `browser-artifacts.ts`, `staff-quote-installation.ts`, `pane-stay-spawn-env.ts`, `pane-stay-save.ts`, `hms-jobs.ts`; include `live-company-account-read-driver.ts` only if call graph confirms it is on the generalized path. No new file expected.
- S3 tests change: `hms-read-target.test.ts`, `hms-quote-target.test.ts`, `hms-jobs.test.ts`, `hms-runtime.test.ts`, `staff-quote-installation.test.ts`, `pane-stay-spawn-env.test.ts`, `pane-stay-save.test.ts`, `hms-property-read-lock.test.ts`, `hms-slot-hrdav-install.test.mjs`. Replace two-hotel enum/fallback assertions with registry + synthetic HRFAKE cases.
- S3 dependency: S1 registry API; define whether lock identity is property or shared browser slot before wiring. No source change appears needed in `property-read-lock.ts` if each property has its own slot.

## 2. Registry recommendation
- `[I]` Add neutral workspace package `@zero/property-registry`, canonical JSON + small ESM resolver + `.d.mts` types. It is importable by server TS, server `.mjs` tools, and `apps/mail`; a TS-only server module would not serve the other consumers cleanly.
- Keep credentials out of registry; store secret/env *references* there only if needed. Keep full profile/catalog migration for S4+; S1 should not absorb pane-fields/rates scope.

## 3. S3 call sites (file:line → change)
- `src/hms/hms-read-target.ts:9–15,31–45,79–115,128–148` → replace two-slot union/maps and unknown→HRCEN behavior with registry lookup; unknown must refuse.
- `src/hms/hms-quote-target.ts:35–72` → remove non-DV→HRCEN target fallback; share resolver.
- `src/hms/production-runtime.ts:249–273,308–315,349–359` → validate allowed origin per registry property; remove literal-HRCEN compatibility fallback.
- `src/hms/browser-artifacts.ts:54` → replace exported Centurion-only origin with registry target origins.
- `src/ai/staff-quote-installation.ts:43–74,128–169` → remove CEN dinner default / HRDAV-special env branch; require property installation.
- `src/ai/pane-stay-spawn-env.ts:12–31,70–123` → keep unknown-transport refusal; resolve slot/env via registry, not `slot==='davinci'` branch.
- `src/ai/pane-stay-save.ts:264–297` → replace DV-only flag/property branches and omitted-property CEN path with resolved property.
- `src/ai/hms-jobs.ts:734,800–804,1348–1353,1706–1711,1808–1813,1915–1920,1736,1763,1933,2172–2173,2222–2228,2401–2413,2427–2430,2918–2925,3021,3061–3099,3279` → remove CEN-only origin guards/tags/history defaults and fallback targets; pass resolved target/property through each path.
- `src/hms/property-read-lock.ts:26–30,76–80,244–246,330–352` → already hashes tenant+property; no rewrite. Extend lock test to HRFAKE; if slots can be shared, key lock by actual shared slot instead.

## 4. DB / env / runtime risks
- No schema migration/property-grant table for S1–S3. S2 seed changes mutate production ACL on reseed; owner approval required before any production seed, and this lane does not run one.
- Env/EC2: each property needs valid origin, secret reference, browser CDP slot, and quote installation; provision consistently for every PM2/systemd consumer. Current code names `HMS_STAGEHAND_CDP_URL_DAVINCI`; future names/values need an explicit config map, not guessed identifiers.
- `[V]` seed has six users/seven grants; production has seven users/thirteen grants. Recipient identities are masked in the cited S3 report; any seventh user pruned by `seedAll` is a data-loss risk until mapped.
- Strong counterevidence: unknown transport already fails closed in tooling registry and pane-spawn resolver. Fix remaining duplicate HRCEN fallbacks; do not broaden into unrelated CLI defaults.
- Acceptance: synthetic HRFAKE unknown mailbox refuses before HMS call; known properties resolve correct origin/slot/installation; lock isolation holds; HRCEN behavior unchanged. Live canaries/flag flips are separate owner-authorized work.
