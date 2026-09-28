# Handoff — Quote and create CLIs

**Date:** 2026-09-23
**Branch:** `feat/centurion-dashboard-tools`
**Worktree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools`
**Plan (done boxes checked):** `/home/orca/.cursor/plans/Finish quote create CLIs-01e947f5.plan.md`
**Prior harness handoff (still binding for HMS):** [2026-09-23-quote-create-harness-handoff.md](2026-09-23-quote-create-harness-handoff.md)
**Private coverage note (gitignored):** `.private/cli-coverage/COVERAGE.md`

This file is for a new LLM. The CLI contracts below are done. The harness handoff's HMS bans are still in force. Nothing in this pass was committed.

---

## 0. What this workstream is

Finish the quote CLI and the create CLI as two separate tools. Each has one request schema and one result schema. Luna then reported what nine-day mail can fill. Luna did not edit the schemas.

It is not:

- A find-party lookup
- A reservationist, and not a Mastra `mailTriage` swap
- A harness or skill rewrite
- A lab overlay, a deploy, or a new HMS click

---

## 1. Locked decisions

- Screen is the boss. `.private/create-screen/new-record.md` supplies create enums. Luna cannot add or delete a schema field.
- `search.salesStrategy` is only `BAR`, `Preset`, `Negotiated Contracted`. Room codes and rate codes stay open native codes. `ratePlan` is not an enum.
- Outcome `quote` requires both `screenshots/group-N-criteria-applied.png` and `screenshots/group-N-availability-results.png`. A missing after-search png is not a quote.
- Create optional refs, not a lookup inside create: agency, organization, arAccount, billingReference, profileId. Find-party is the next tool.
- Language, title, settlement, and VIP live in `create-side-catalog.json`. They are not request keys.
- Deposit due and deposit amount stay explicit `unknown` on the result. No second Save to discover them.
- Quote holdout 15 and create holdout 15 stay closed.
- Luna is `gpt-6-luna` with `model_reasoning_effort=max`. No fallback to `gpt-5.6-luna`.
- Before every test: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Never set `VITEST_ALLOW_PILOT_RDS=1`. Never source `.env.production`.
- Do not commit `.private/` or mail bodies.

---

## 2. Done

| Piece | State | Where |
| --- | --- | --- |
| `salesStrategy` enum | Done | `apps/server-pilot/tooling/playwright-quote/quote-tool.schema.json`, `quote-contract.mjs` |
| Quote outcome fails closed without both shots | Done | `fetch-quote.mjs` (`QUOTE_SCREENSHOT_MISSING`), `README.md` |
| Create request and result schema | Done | `create-tool.schema.json` |
| Side catalog | Done | `create-side-catalog.json` |
| `--request` on create CLI, no hardcoded guest | Done | `create-lab-stay.mjs`, `create-request.mjs` |
| Offline tests, `DATABASE_URL` unset | 88 pass, 0 fail | `fetch-quote.test.mjs`, `quote-contract.test.mjs`, `create-tool.schema.test.mjs`, `create-lab-stay.test.mjs` |
| Luna coverage | 355/355, holdout leak 0 | `.private/cli-coverage/` |
| Negative control | 218/218 old create extracts fail the new schema | scored, holdout extract files not opened |

`create-lab-stay.mjs` was not executed. `cancel-lab-stay.mjs` was not executed. No HMS search. No Save. No Astra. No deploy. No commit.

### 2.1 Quote

`quote-contract.mjs` rejects any `salesStrategy` outside the three labels (`INVALID_SEARCH`). Room and rate codes stay the open `nativeCode` pattern.

`fetch-quote.mjs` refuses outcome `quote` unless every occupancy group lists both screenshot paths. The code is `QUOTE_SCREENSHOT_MISSING`. The README states the same rule. The offline test `skipped availability-results cannot be outcome quote` passed. The 2026-09-22 run under `.private/playwright-quote/runs/2026-09-22T19-32-44-421Z-ba882ac0/` is prior evidence that the hook fired once. It is not a new live search.

Cache reuse can skip writing `group-N-availability-results.png` for a later group with the same signature. The result then stays `partial`, not `quote`. That is fail-closed. The next human run is what writes the next pair of pngs.

### 2.2 Create schema

`$defs.request` required: arrival, departure, adults, sourceOfBusiness, roomType, ratePlan, track, firstName, lastName, guaranteeType. `additionalProperties` is false, so `boardBasis`, `guestName`, language, and settlement fail.

Enums copied from the opened lists in `new-record.md`: guarantee 10, room 9 (`STQN` through `DLXTWN`), source 25, track 21. `ratePlan` is a free native code.

Optional and not required: agency, organization, arAccount, billingReference, profileId.

`$defs.result` facts are `{ value, provenance }` with provenance `observed` or `unknown`. Required result fields: confirmationNumber, status, mealPlan, marketSegment, totals, depositDue, depositAmount, screenshots. `depositDue` and `depositAmount` use `explicitUnknown`: provenance `unknown`, value null. Screenshot names on the contract: `filled.png`, `availability.png`, `saved.png`.

Side catalog counts: language 145, title 45, VIP 10, settlement 19.

### 2.3 Create CLI

`create-lab-stay.mjs` loads `--request <path>` through `create-request.mjs` and validates `$defs.request` before any browser call. A bad request exits 2 and does not open CDP. The hardcoded guest (`LAB` / Nava / Labcancel) is gone. Dates, names, and the optional refs come from the request. Shot names are unchanged. Tests call `loadCreateRequest` only. They do not spawn the script.

### 2.4 Luna coverage

Population: nine-day canonical rows whose `pmsTools` or `primaryTool` included `hms_quote_stay` or `hms_create_reservation`. Both holdout files were used only as id exclude lists. Skip decisions were excluded too. None of the tagged ids were skips.

| Set | Count |
| --- | ---: |
| Eligible | 355 |
| Quote | 288 |
| Create | 91 |
| Both | 24 |
| Tagged ids removed because they were in a holdout | 19 |
| Holdout ids inside Luna input | 0 |
| PDF text (`pdftotext -layout` after S3 get) | 67 messages, 77 files, 0 failures |
| JSONL rows returned | 355 |
| Schema-key violations | 8 (all `quote_room_extra`) |

Gap labels Luna emitted: filled 855, blank_required 858, not_a_field 756, find_party 352, prompt_bug 296.

`blank_required` means the mail or PDF did not state a required field. That does not make the field optional. `find_party` means a name with no native ref. `not_a_field` means language, title, settlement, VIP, and similar. Those stay off the request.

Old create lab-card extracts, holdout files not opened: 218/218 fail the new schema because they still carry keys such as `settlementType`, `title`, `phone`, `email`, and `nights`.

Prompt budget: shards 1–6 (42 rows) had ignore rate 0, so there was no schema-ignore edit and no confirm slice. Shard 40 stopped and asked permission instead of writing. One clarification, that shard only, is `.private/cli-coverage/PROMPT-shard40-edit.txt`. The retry wrote 7 rows. No second edit. Schemas were not grown.

What mail can fill: quote dates, occupancy, and a sales strategy when the mail states them. Native room and rate codes are often absent and were left blank. Create can fill names and dates from vouchers. Guarantee, source, room code, rate code, and track are usually blank unless the mail states the native value. Agency and organization names need find-party. Deposits stay unknown.

Shards, prompt, and extracts are under `.private/cli-coverage/`. Do not commit them.

---

## 3. Do not

- Do not reopen either holdout of 15.
- Do not run `create-lab-stay.mjs`. Save mode is still banned.
- Do not run `cancel-lab-stay.mjs`.
- Do not click OK on "Cancellation Penalty of 2060.00 may be added to account."
- Do not void, delete the stay, or delete profile 45552. Confirmation `11110906-1` stays cancelled.
- Do not start Astra. Do not click HMS, including a fresh quote search.
- Do not let a Luna key add or delete a schema field.
- Do not fall back from `gpt-6-luna` to `gpt-5.6-luna`.
- Do not commit `.private/` or mail bodies.
- Do not point a test runner at `nava-zero-mail-pilot`.

The rest of the harness handoff's do-not list still applies.

---

## 4. Open

- Find-party is the next PMS tool. Kind and name in. Native ref and a dialog shot out. Create does not resolve names.
- Reservationist (the later agent that picks these CLIs and cites the mail span) is not built. Mastra `mailTriage` was not swapped.
- The repeatable harness for the next tool was out of this plan.
- Eight quote rows emitted a room key outside the allowed set. Schema stayed. A later prompt edit was not spent on them.
- Whether 2060 posted to the folio of `11110906-1` is still unknown. See the harness handoff. Do not void without a new yes.
- Cache reuse on quote still yields `partial` when the after-search png is not written again. A human run is what produces the next png pair.

---

## 5. Next LLM start

1. Read this file, then the harness handoff.
2. Read `quote-tool.schema.json`, `create-tool.schema.json`, and `.private/cli-coverage/COVERAGE.md`.
3. Do not attach CDP unless the user asks for a new HMS action.
4. If they do, the identity gate is still confirmation `11110906-1`, last name `Labcancel`, first name `Nava`, arrival `08-JUN-2027`. Any mismatch: stop and cancel nothing.
