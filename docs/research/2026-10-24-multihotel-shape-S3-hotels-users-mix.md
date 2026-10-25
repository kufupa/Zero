---
date: 2026-10-24
lane: S3 (multi-hotel shape)
model: GPT-6 Luna max (Sonnet slot)
method: read-only prod SQL via SSM (BEGIN READ ONLY / ROLLBACK), aggregates only
window: 2026-09-24 00:23 to 2026-10-24 00:23 UTC (30 d); user events 14 d
base: origin/main 1656bca50
---

# S3 — Multi-hotel shape

**Verdict: Production has two mapped hotels, 7 active mailboxes and 7 users; user access is mailbox-granted, not property-granted. Unknown HMS reads fall back to HRCEN.**

- Read required context and sources; `origin/main` was `1656bca50`. Current checkout is `a9435e6a3`.
- Read-only production SQL via requested SSM path. Schema discovered with `\dt`/`\d`; all queries used `BEGIN READ ONLY` / `ROLLBACK`.
- Windows: **30 days: 2026-09-24 00:23–2026-10-24 00:23 UTC**; **14 days: 2026-10-10–2026-10-24 UTC**.
- No guest names or personal emails included.

---

## 1. Live transports map to two hotels

| Transport ID | Display / mailbox | Code mapping | Active | Inbound / outbound, 30d | Users with access | User events, 14d |
|---|---|---|---:|---:|---:|---:|
| `transport-centurion` | Centurion Hotel Reservations · `centurion@legacyhotels.co.za` | HRCEN | Yes | 4,095 / 1,465 | 5 | 6,254 |
| `transport-davinci` | Da Vinci Hotel Reservations · `davinci@legacyhotels.co.za` | HRDAV | Yes | 1,248 / 937 | 1 | 0 |
| `transport-ayanda` | Personal staff mailbox · `a***@legacyhotels.co.za` | HRDAV | Yes | 1,095 / 164 | 2 | 0 |
| `transport-faith` | Personal staff mailbox · `f***@legacyhotels.co.za` | HRDAV | Yes | 1,279 / 277 | 2 | 251 |
| `transport-epick` | Personal staff mailbox · `e***@legacyhotels.co.za` | HRDAV | Yes | 1,277 / 331 | 1 | 0 |
| `transport-kmgidi` | Personal staff mailbox · `k***@legacyhotels.co.za` | HRDAV | Yes | 814 / 222 | 1 | 0 |
| `transport-nava` | Nava AI Transport · `navaai@legacyhotels.co.za` | HRCEN* | Yes | 462 / 0 | 1 | 0 |
| `0d03ffcb-ca93-48da-81a9-ca0b07506dec` | — · `nava-0d03ffcb@example.com` | HRCEN* | No | 0 / 0 | 0 | 0 |
| `389ec388-11f2-4092-b115-908804088c44` | — · `replay@example.com` | HRCEN* | No | 0 / 0 | 0 | 0 |
| `9efba301-def9-4ae1-ab75-39de4317fe68` | — · `nava-9efba301@example.com` | HRCEN* | No | 0 / 0 | 0 | 0 |

- **VERIFIED:** `HRCEN*` means read-target fallback: every non-Da Vinci transport maps to HRCEN. Quote registry is stricter: only Centurion and Da Vinci are registered; unknown transport throws. Personal local-parts masked. All 7 active DB rows have `mailbox_type=personal`, including role-address mailboxes.
- Totals: HRCEN **4,557 inbound / 1,465 outbound**; HRDAV **5,713 / 1,931**. By `Message-ID`, these are **4,375 / 4,592 distinct**; repeated copies = **182 / 1,121**. HRDAV volume therefore counts many cross-mailbox copies.
- `work_event.actor_kind='user'` counts are events, not confirmed staff adoption or distinct users.

## 2. Users have mailbox grants, not property grants

| Property | Distinct users with active-mailbox access | User-mailbox grants |
|---|---:|---:|
| HRCEN | 5 | 6 |
| HRDAV | 3 | 7 |

- **VERIFIED:** 7 user rows; all 7 have grants; 13 grants total; all stored grants have ACL role `owner`. One user has 7 mailbox grants; six users have one each. No names/emails reported.
- `mailbox_access` links user → transport. Public schema has no property table or user-property grant. Property comes from code mapping.
- **Code/production mismatch:** local `seed.ts` has 6 pilot users and 7 grants, only Centurion/Nava grants; production has 7 users and 13 grants, including five Da Vinci transports.
- `#179` asks one login to handle multiple inboxes; `#210` asks for ≥3 more hotels and many users/property. Current grants show mailbox sharing, not property-scoped authorization.

## 3. Mail mix is partial extraction output, not gold truth

Latest inbound `mail_extraction.payload.action` per message row; repeated mailbox copies remain in counts. `payment_proof` shown as voucher/POP proxy; `other` groups `no_action`, billing, group-event and other-actionable.

| Property | Inbound copies; distinct Message-ID | With action / coverage | Quote · booking · amend · cancel · voucher/POP · other |
|---|---:|---:|---|
| HRCEN | 4,557; 4,375 | 2,587 / **56.8%** | 55 · 266 · 59 · 16 · 51 · 2,140 |
| HRDAV | 5,713; 4,592 | 1,460 / **25.6%** | 24 · 121 · 86 · 16 · 54 · 1,159 |

- **VERIFIED:** remaining inbound copies had no extraction or no action payload; they are unclassified here. These are model outputs, not adjudicated labels or accuracy results.
- HRDAV has lower extraction coverage and more repeated mailbox copies; raw property mix is not unique-mail mix.

## 4. HMS records show HRDAV quote refusals; exact causes are not persisted

**AI workflow rows, 30d** — failure rate here = `dead_letter / all created`; superseded shown separately.

| Property | Kind | Rows | Outcome |
|---|---|---:|---|
| HRCEN | `read_tool` | 1,185 | 54 dead-letter (**4.6%**); 201 superseded |
| HRCEN | `inbound_extraction` | 7,497 | 0 dead-letter; 449 superseded |
| HRCEN | `inbound_triage` | 3,735 | 0 dead-letter; 44 superseded |
| HRCEN | `candidate_draft` | 106 | 0 dead-letter |
| HRDAV | `read_tool` | 29 | 0 dead-letter; all succeeded |
| HRDAV | `inbound_extraction` | 1,580 | 0 dead-letter; 1 superseded |
| HRDAV | `inbound_triage` | 1,047 | 0 dead-letter; 1 superseded |

- HRCEN read-tool rate is 5.5% if superseded rows are excluded from denominator. No `hms_write` rows found.
- **HITL non-OK / total:** HRCEN quote 229/344 (66.6% refused); booking-draft 34/56 (60.7% refused); stay-lookup 227/345 (65.8%); guest-search 45/124 (36.3%); cancel-preview 2/6; cancel-commit 2/2 unconfirmed; stay-commit 1/2. Overall HRCEN **540/886 (61.0%)** non-OK. HRDAV quote **29/29 refused (100%)**.
- HRDAV quote refusals persist only as `PRECONDITION_FAILED`; result subcode fields are null. **VERIFIED prior diagnosis:** Oct 23 retro attributed 19 rapid refusals to missing HRDAV quote configuration. Current 30-day rows cannot distinguish installation failures from origin guards. No exact `installation_unavailable` or Centurion-origin refusal count is recoverable from these columns.
- Code has a Da Vinci-origin guard and a Da Vinci-read flag; background skips may happen before a run row exists.

## 5. Other onboarding candidates are weak signals, not confirmed properties

| Candidate | Evidence | Status |
|---|---|---|
| The Bakubung Bush Lodge — `HRBAK` | Sept 23 pane mockup lists it; one all-time To/Cc address-string match on `legacyhotels.co.za` | **INFERENCE:** plausible candidate; no current transport or verified tenant |
| Kwa Maritane Bush Lodge — `HRKWA` | Same mockup; one all-time To/Cc address-string match on `legacyhotels.co.za` | **INFERENCE:** plausible candidate; no current transport or verified tenant |

- Da Vinci interview covers Centurion/Da Vinci work; no third property named there. Current transports explicitly map only HRCEN and HRDAV.
- Code aliases `.co.za`, `.com`, and `.legacyhotel.com` are company aliases, not property identifiers. Quarantine has **3,425** `missing_owner_header` rows and 2 `unknown_transport`; domain alone cannot assign a hotel.
- **95 threshold: not met** for full property roster or candidate ownership. Need owner-approved roster and transport/tenant mapping; unresolved quarantine recipients could add candidates.

## 6. Sources and route

- Production: read-only SSM aggregates; schema from `\dt`/`\d`. No raw email or credentials retrieved.
- [HMS read mapping](../../apps/server-pilot/src/hms/hms-read-target.ts:8), [quote property registry](../../apps/server-pilot/tooling/playwright-quote/property-registry.mjs:3), [seed users/grants](../../apps/server-pilot/src/db/seed.ts:66).
- [Da Vinci mailbox identities](../../apps/server-pilot/src/hms/mailbox-hms-origin-bind.ts:8), [extraction action schema](../../apps/server-pilot/src/ai/extraction/schema.ts:32), [Centurion reply copy](../../apps/mail/lib/quote-proposal/copy.ts:17).
- Owner asks #179 and #204–215: `origin/main@1656bca50`; #210 sets ≥3 more hotels. Prior [A1 architecture review](../../docs/research/2026-10-23-g1023-retro/A1.md:1); [Oct 23 HRDAV quote diagnosis](../../docs/context/ledger/2026-10-23-g1023-retro.md:20); [demo hotel selector](../../docs/superpowers/specs/2026-09-23-centurion-outlook-side-pane-demo.html:1394).
- Route: local code/docs + read-only production SQL; no web/Exa. Sonnet 5.5 cost telemetry unavailable; Exa **$0**.
