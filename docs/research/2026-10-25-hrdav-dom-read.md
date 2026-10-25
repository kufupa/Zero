---
title: HRDAV allowed strategies and blank-create DOM option lists
unit: U0
date: 2026-10-25
property: HRDAV
method: guarded Playwright over the existing HRDAV CDP slot; native Ext stores and screenshots
requirements: [R2, R3]
---

# HRDAV DOM capture — U0

**STO exists as Track code `STO`, label `STO Rate`, with market-segment label `Wholesale`. Sales Strategy has `WS` / `Wholesale`, not a separate STO entry.** No Faith question is needed to locate the native STO code. This capture does not identify one particular wholesale rate plan as the unique STO price source.

The profile is [HRDAV.json](../../apps/server-pilot/tooling/playwright-quote/property-profiles/HRDAV.json). It now preserves native option codes/labels, field requirements, screenshots and one wholesale shop timing. Consumers are U4b/U6; this lane does not change their runtime behavior.

## Provenance and scope

- Required startup files, FACTS/CATALOG, relevant solutions/MISTAKES and U0 plan section read. Initial fetched `origin/main`: `281dc98c3`; EC2 checkout used for existing tooling: `23b71fa4092`.
- Reuses the two D0 BAR captures in the original profile and [S1 field audit](2026-10-24-multihotel-shape-S1-infor-fields.md). Those artifacts lacked native create option lists and STO's field location; this is why a new DOM read was necessary.
- Owner A1/read-only U0 authorization is in the executing brief and PRODUCT.md. Used only the HRDAV slot, validated its secret/property identity, and held `createPostgresPropertyReadLock` for each borrowed session using the pane's tenant selection and property `HRDAV`.
- One capture job controlled one borrowed context at a time. Locator and DOM click guards reject Save, OK, Book, Confirm, Cancel Reservation, Submit and Delete; mutation requests are blocked. JavaScript dialogs are dismissed, never accepted. Browser dialogs and existing guest records were not opened; no mail/DB content was queried. PostgreSQL was used only for the advisory lock.
- `hms-job.sh` was inspected: it accepts only the Labtest proof CLI, not a DOM-capture tool. Used existing `ssm-run-command.sh` to start/poll an ephemeral systemd job, importing the existing Playwright/login/lock kernel. No tracked tooling, deployments, environment files, flags or slot services were changed.
- CodeGraph `explore` was attempted. No index exists in this worktree; its own instruction directed the lane to source reads without indexing.

## Sales strategies — all 9 loaded native choices

Source: `input[name="salesstrategy"]`, native `value` / `display` store. `allowBlank=false`; store count and total both 9. Screenshot `dropdown-salesstrategy-0.png`.

| Code | Exact HMS label |
|---|---|
| PROMO | Promotions |
| BAR | BAR |
| PRESET | Preset |
| WS | Wholesale |
| NC | Negoticated Contracted |
| GOV | Government |
| AIR | Airline Crews |
| DOML | Domestic Leisure |
| OTHER | Other |

The native spelling `Negoticated Contracted` is intentionally retained. STO is absent from this list but present in the Track list below; absence from one field is not absence from HMS.

## Create controls and complete loaded lists

Source: blank Guest Stay → New Record. No guest name, contact, rate or other reservation value was filled; no Save was clicked. Lookup lists were opened, read and closed without selecting a row.

| Native field | Control / requirement | Captured choices | Native value / display fields | Screenshot |
|---|---|---:|---|---|
| sourceofbusinessdesc | Lookup; required | 27 | codevalue / description | lov-sourceofbusinessdesc.png |
| track | Lookup; required | 20 | trackcode / tcddesc | lov-track.png |
| guaranteetype | Dropdown; required | 11 | value / display | dropdown-guaranteetype-0.png |
| mealplan | Read-only text; optional | No independent list | Native board codes not exposed | create-blank.png |

The lookup stores report total=0 although they contain 27/20 rows; counts here mean all rows loaded into these native lookup stores, not an inferred server-side count. Full option rows live in the profile. Examples: source `EMA` / `E-Mail`, `TA` / `Travel Agent`; Track `COR` / `Corporate` / `Negotiated Contracted`, `STO` / `STO Rate` / `Wholesale`.

Guarantee codes: `AVOUCH`, `CNFREC`, `DEPREQ`, `GRPDEF`, `GTDAGT`, `GTDCMP`, `GTDCC`, `CCIATA`, `GTDDEP`, `NGG`, `NGI`. Exact labels are in the profile.

**Board finding:** `mealplan` is a read-only text field, not an editable board dropdown. Opening the create rate lookup opened native Rate Shop and an informational message. No OK/Complete/Update Stay action was taken and no extra shop inquiry was run. That screen does not establish a native board-code catalogue. Keep codes unknown; do not import Centurion board codes or infer them from rate names.

The one successful WS Hotel Availability grid exposes these exact labels: `Bed & Breakfast R`, `Bed & Breakfast NR`, `Wholesale Dinner, Bed & breakfast - NR`. They are stored separately as observed labels, not independent create choices or normalized board codes. A wholesale dinner-package offer does not establish a dinner add-on policy; `dinnerAddOn` is unchanged.

## Required markers on blank create

Native `allowBlank=false` plus red-star screenshot evidence. Field keys are preserved, including the description field used by the Source lookup and the checkbox used for Terms and Conditions. This is the observed UI metadata, not a claim that the existing create tool fills every required field.

| Native field | UI label | Screenshot |
|---|---|---|
| arrivaldate | Arrival Date | create-blank.png |
| departuredate | Departure Date | create-blank.png |
| adults | Adults | create-blank.png |
| sourceofbusinessdesc | Source Of Business | create-blank.png |
| guaranteetype | Guarantee Type | create-blank.png |
| roomtype | Room Type | create-blank.png |
| rateplan | Rate Plan | create-blank.png |
| marketsegment | Market Segment | create-blank.png |
| track | Track / Sub Segment | create-blank.png |
| reservationnote | Reservation Note / Billing Instructions | create-reservation-note.png |
| lastname | Last Name | create-blank.png |
| firstname | First Name | create-blank.png |
| guestoptin4 | Terms and Conditions | create-blank.png |

`requiredCreateFields: ["reservationnote"]` remains the existing additional-property-requirements contract. All 13 observed UI markers live in `createForm.requiredMarkers`; adding them to the existing create validator is outside U0.

## One wholesale strategy shop — timing for U6

HRDAV, WS, 2027-02-16 → 2027-02-17, 1 adult; no organization/agency/group context. The native grid shows 133 room/rate rows and 16 distinct rate plans. This is one date/occupancy sample, not a latency distribution or universal entitlement claim.

- Inquiry HTTP 200; Search click to inquiry response: **3,388.96 ms**.
- Criteria setup to post-response screenshot capture: **4,800.22 ms**. Includes a 1-second display wait and evidence capture; not a pure criteria+network timing.
- Raw `shop.json` used the original field name `criteriaAndResponseMs`; profile renames it `criteriaToScreenshotMs` to describe the actual measured boundary.
- Wholesale offer names include `BWS1B–BWS3B` / `Wholesale Best Available Rate 1–3`, `WSF1B–WSF3B` / `Wholesale Contracted Rate 1–3`, and `WSG5DB` / `TITAN / SAGA - includes dinner`. All 16 observed native names/codes are in `observedStrategyRatePlans.WS`.
- Source screenshot: `wholesale-shop.png`; prices/inventory remain in private evidence and were not promoted into a static price catalogue.

## Execution deviations, safety and remaining limits

The requested single-session capture was not achieved. Sessions were sequential and individually locked: an import failure stopped before connection; strategy extraction then failed on TypeScript's serialized `__name`; a later session captured the sole shop but timed out opening create; the next captured create/source and expired after 20 minutes; a follow-up captured Track/Guarantee/rate-shop metadata; a final brief session captured the note marker. All failures/retries were read-only; their sequence is recorded here and per-session audits are retained. There was no simultaneous HMS controller activity.

A secondary read connection inspected the same active capture page under its owner's still-held lock; it did not create another context or select a guest. Capture helpers and signed upload requests are private temporary files, not repository changes. S3 evidence transfer needed a regional signed upload because the EC2 role cannot write the evidence prefix directly; no IAM permissions changed.

Native board codes remain unknown, and one sampled WS shop does not prove every strategy's prices. No production golden-set score or staff-price agreement is claimed. The lane provides source-backed configuration for the dependent units, not their acceptance proof.

## Evidence locators and verification

Private archive: `s3://nava-zero-bootstrap-845242190536/mh-U0-20261025/evidence.tar.gz`. Local mirror: `/tmp/mh1024/evidence/`. EC2 capture directory: `/tmp/mh-U0-20261025/`. `manifest.json` records every capture's SHA-256, byte size and UTC modification time. Screenshots and raw DOM/native stores remain outside Git.

Verification: profile loads through the production `profileFor('HRDAV')`; native counts, unique codes and STO/Wholesale linkage checked against captures. U0 is data capture: no test code and no test runner are needed (plan expectation); U4b/U6 consume the data in their tests. Remote server-pilot typecheck and Greptile Apex results are reported in the PR. No local typecheck, Vitest or other test runner was run.

Archive SHA-256: `fc36de50fd18a4e8fea7a93e87186aa25248e0bf35de4f0ebb64c334a53876d1`. Capture hashes verified against all 41 manifest entries.

| Screenshot | SHA-256 |
|---|---|
| dropdown-salesstrategy-0.png | `d4609533b6034bae3570292693993b3c45b1561af6b36f4c1b3eee49785703bd` |
| lov-sourceofbusinessdesc.png | `881f91a1f683d9d8efa8976816ee4bdf604b3e7efa196403b9981028ab7034f6` |
| lov-track.png | `dbeb7296e79e498f61b068a320c8575f17637e3532caf641766542c8e7a7d4b7` |
| dropdown-guaranteetype-0.png | `be39c3c6ed8d7db7b4776cbfbd978692343c6274a8c75983ec890966406fb69e` |
| create-blank.png | `e7862d4f047b0e1ca867f23968ee21860bea7931a0b04fb28ade74cbf13ce69c` |
| create-reservation-note.png | `757265fec2db6ae149c35f10767a94e2dbc5583e4e084533536b152313949773` |
| wholesale-shop.png | `dc21493fe3faff85621be2829dbe901bec825b5e4cf5f7d6d4be8a6bf2891a7f` |

Audit: all 5 sequential borrowed contexts closed; no JavaScript dialogs or mutation requests were observed. The conservative route guard aborted one automatic read-only `/api/internalBooking/rateshop/inquiryForGrid` request, so the create Rate Shop did not perform a second shop. The note-marker screenshot was taken during a processing overlay; its red marker remains visible.
