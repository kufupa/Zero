---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
plan_depth: standard
date: 2026-08-27
---

# fix: Make Nava Gemini 3.7 Flash work and 10x the overlay

## Goal Capsule

`./scripts/nava` must land a Nava-branded board, then a working Gemini 3.7 Flash chat. First `hi` must get a model reply, not `Provider rejected the request (ApiError, 400)`. Overlay only. Do not patch `external/prime-agent` sources.

- **Authority:** Pilot-RDS safety still overrides. Founder brand mark is NAVA + bar (attached). Do not ship Prime Agent on the start button. Do not label latency as FTE hours saved. No £ / ADR.
- **Execution profile:** Pin thinking to a Gemini 3.7 Flash-accepted level, brand the TUI + Prime theme, prove with tests plus one print-mode `hi`.
- **Stop conditions:** Stop if Gemini 3.7 Flash rejects every thinking level overlay can send without a Prime source patch. Do not invent a different model without saying so.
- **Product Contract preservation:** Overlay goal unchanged. Thinking-off is withdrawn: that setting is what 400s this model.

---

## Product Contract

### Summary

Investor TTY path shows Nava (wordmark + FTE board), then Gemini 3.7 Flash actually answers. Status bar must not sit on `minimal` for this model.

### Problem Frame

Live `hi` in the Nava Prime session failed with:

`Provider rejected the request (ApiError, 400)`

Provider log: `Thinking level MINIMAL is not supported for this model.` Model was `google/gemini-3.7-flash`. Status showed `Gemini 3.7 Flash • minimal`.

Causal chain:

1. `.prime/agent/settings.json` sets `defaultThinkingLevel: "off"` (original overlay plan).
2. Catalog row `google` / `gemini-3.7-flash` has `thinkingLevelMap: {"off":null}`. `getSupportedThinkingLevels` drops `off` (`null` means unsupported) but treats unmapped `minimal`/`low`/`medium`/`high` as available.
3. `clampThinkingLevel("off")` walks to the next available: `minimal`.
4. `streamSimpleGoogle` then sends `thinkingConfig.thinkingLevel = MINIMAL` (enabled path). Even the disabled-thinking path for Gemini 3 Flash hardcodes `MINIMAL` inside Prime. Overlay cannot patch that.
5. Gemini 3.7 Flash API 400s. Direct probe: `MINIMAL` → 400 same message; `MEDIUM` → 200 `NAVA_OK`; `HIGH` → 200 `NAVA_OK`; `LOW` hung past 60s (do not pin).

Second gap: board is a sparse one-line `Nava` header. Founder wants the NAVA + bar mark and a product that does not feel like a jump into an unbranded error chat.

### Requirements

- R1. Gemini 3.7 Flash first user prompt succeeds (not ApiError 400) when launched via `scripts/nava`.
- R2. Pinned provider is `google`, model `gemini-3.7-flash`, thinking `medium` (proven accepted). Never pin `off` or `minimal` for this model.
- R3. TTY board shows NAVA wordmark + underline bar, mix 2957, hours KPIs, HITL, tools `live=false`/`shadow=false`. No butterfly. No £. No "FTE hours saved."
- R4. After Enter, `TUI.stop()` then exec Prime with explicit `--provider` `--model` `--thinking` so clamp cannot reintroduce MINIMAL.
- R5. Prime theme is Nava blue, `quietStartup: true` (no Prime butterfly splash).
- R6. Non-TTY path still prints markdown and exits. Missing dump still exits non-zero.

### Actors

- A1. Operator on this host running `./scripts/nava` in a TTY.
- A2. Gemini 3.7 Flash via `GEMINI_API_KEY` from `.gemini_api_key`.

### Key Flows

- F1. TTY: dump/hours/dashboard → Nava board → Enter → Prime Gemini 3.7 Flash with thinking medium → `hi` gets text.
- F2. Non-TTY: print `docs/infor-hms/nava-fte-dashboard.md`, no TUI, no exec.

### Acceptance Examples

- AE1. Print-mode (or equivalent Prime path) `Reply with exactly NAVA_OK` with `--provider google --model gemini-3.7-flash --thinking medium` returns `NAVA_OK` and does not contain `ApiError, 400`.
- AE2. Board header contains `NAVA`, a bar of `█`/`▀`, `gemini-3.7-flash`, and `medium`. Footer says start Gemini, not a generic "agent".
- AE3. Settings + launcher both pin thinking `medium`. Tests fail if either drifts back to `off`/`minimal`.

### Scope Boundaries

In scope: overlay launcher, dashboard view, project Prime settings, project theme, tests, one live print-mode proof.

Out of scope: patching `external/prime-agent` (including `getDisabledThinkingConfig`), Orca start-button name-gate, EC2 deploy, dump ACL (already unblocked), HMS live tools.

Deferred: user `/thinking minimal` inside Prime still 400s (Prime source bug). Different Gemini SKU if 3.7 Flash inventory changes.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Pin `medium`, not `off`. `off` clamps to `MINIMAL` and 400s. `HIGH` also works; `medium` matches Prime's built-in default and is faster than high.
- KTD2. Dual pin: `defaultThinkingLevel` in `.prime/agent/settings.json` **and** `exec` argv `--provider google --model gemini-3.7-flash --thinking medium`. CLI thinking wins in `main.ts`. Do not rely on settings alone (resume/daemon can ignore project defaults).
- KTD3. Do not patch Prime. Overlay cannot fix `getDisabledThinkingConfig` sending `MINIMAL` for all Gemini 3 Flash ids.
- KTD4. Brand 10x is overlay TUI wordmark + `.prime/agent/themes/nava.json` (Nava blue, not Prime purple). `quietStartup` stays true so Prime's butterfly splash stays off. Founder mark overrides the earlier "no giant NAVA word-art" overlay constraint: the mark is the NAVA + bar, not figlet.
- KTD5. No Vitest against live Gemini. Unit tests lock pins and chrome. One manual/script print-mode call proves AE1. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest.

### Assumptions

- `.gemini_api_key` line 1 remains a valid Generative Language API key.
- Dump remains readable to the operator user (ACL grant already applied).
- Prime submodule stays unpatched; `prime-agent.sh` already boots.

### Risks

- Daemon resume of the failed session: mitigated by argv `--thinking medium` on every exec.
- Operator later sets thinking to minimal in-session: residual Prime bug; skill copy can warn, cannot prevent without a fork.

---

## Implementation Units

### U1. Pin Gemini 3.7 Flash thinking medium

**Goal:** First prompt cannot send `MINIMAL`.
**Requirements:** R1, R2, R4, AE1, AE3
**Dependencies:** none
**Files:** `.prime/agent/settings.json`, `scripts/nava`, `apps/server-pilot/tests/nava-prime-settings.test.ts`, `apps/server-pilot/tests/nava-launcher.test.ts`
**Approach:** Set `defaultThinkingLevel` to `medium`. Exec Prime with `--provider google --model gemini-3.7-flash --thinking medium`. Keep dump-deny env, key export, `TUI.stop()` then exec. Tests assert settings + argv never contain thinking `off`/`minimal`.
**Patterns to follow:** existing `scripts/nava` exec block; `nava-prime-settings.test.ts`.
**Test scenarios:**
- Happy: settings `defaultThinkingLevel === "medium"`, `defaultProvider === "google"`, `defaultModel === "gemini-3.7-flash"`.
- Happy: launcher source contains `--thinking medium`, `--provider google`, `--model gemini-3.7-flash`, and `exec "$PRIME"`.
- Error: launcher still errors on missing dump / missing key; no stub board.
**Verification:** Vitest on those two files green. Print-mode AE1 after U3.

### U2. 10x Nava board chrome

**Goal:** TTY board looks like NAVA + bar, denser Cursor-class KPIs, honest Gemini start hint.
**Requirements:** R3, R6, AE2
**Dependencies:** none (can parallel U1)
**Files:** `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts`, `apps/server-pilot/tests/nava-fte-dashboard-view.test.ts`, `scripts/nava-dashboard-tui.ts`
**Approach:** Render a geometric NAVA wordmark plus a solid underline bar. Keep mix sum 2957, caveat, HITL, tools flags. Header names `gemini-3.7-flash` and `medium`. Footer: Enter starts Gemini 3.7 Flash. ANSI Nava blue on the wordmark is allowed; tests assert plain `NAVA` + bar even if ANSI wrapping is stripped. No figlet. No butterfly. Wider mix bars.
**Patterns to follow:** existing `renderDashboardSections`; TUI still `TUI.stop()` without `preserveAltScreen`.
**Test scenarios:**
- Happy: header contains `NAVA`, `gemini-3.7-flash`, `medium`; board contains mix classes, caveat, `live=false`.
- Edge: wordmark includes a bar line of `█` or `▀` spanning the letters.
- Error: board must not contain `£`, `FTE hours saved`, butterfly/figlet noise, or `minimal`.
**Verification:** dashboard-view + launcher TUI tests green. Non-TTY still cats markdown.

### U3. Nava Prime theme

**Goal:** Chat chrome reads Nava, not Prime purple, without a butterfly splash.
**Requirements:** R5
**Dependencies:** U1 (settings file)
**Files:** `.prime/agent/themes/nava.json`, `.prime/agent/settings.json`, `apps/server-pilot/tests/nava-prime-settings.test.ts`
**Approach:** Project theme `name: nava`, accent/border Nava blue (`#2F6BFF` class). `settings.theme = "nava"`. `quietStartup` remains true. Optional `--theme nava` on exec if that is the reliable discovery path.
**Patterns to follow:** Prime `docs/themes.md` project path `.prime/agent/themes/*.json`; copy required color keys from built-in `dark.json`.
**Test scenarios:**
- Happy: theme JSON `name === "nava"` and accent/vars include `#2F6BFF` (or documented Nava blue).
- Happy: settings `theme === "nava"` and `quietStartup === true`.
**Verification:** settings/theme tests green.

---

## Verification Contract

Before Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never `VITEST_ALLOW_PILOT_RDS=1`. Never source `.env.production`.

- `pnpm --filter @zero/server exec vitest run tests/nava-prime-settings.test.ts tests/nava-launcher.test.ts tests/nava-fte-dashboard-view.test.ts`
- Print-mode AE1 with key from `.gemini_api_key` (do not print the key): `prime-agent.sh --print --provider google --model gemini-3.7-flash --thinking medium --no-tools --no-session` and a prompt that must echo `NAVA_OK`.
- Do not log dump bodies, addresses, or the API key.

---

## Definition of Done

- U1–U3 landed. Pins cannot silently revert to thinking `off`.
- AE1 proven once on this host (print-mode or live TTY).
- Board 10x chrome tests green. Mix still 2957. No PII in git.
- No `external/prime-agent` source edits.
- Commit only if the user asks.
