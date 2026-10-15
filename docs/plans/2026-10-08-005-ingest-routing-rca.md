# Ingest routing RCA: new legacy mailboxes + quarantine backlog

Date: 2026-10-08 (SAST day = 2026-10-07 22:00Z onward)
Status: analysis and plan only. No prod writes, no code changes.
Basis: `origin/main` e7fc3357 (= prod worker HEAD at 10:44Z). This worktree's ingest files are behind main by about 1,100 lines, so line numbers below are origin/main's.

## Answer

- The five new mailboxes are **not set up** on our side:
  - no `mailbox_transport` row for any of them
  - no `X-Zero-Mailbox` stamp on any of their mail
  - no ingest rule evidence for their own mail
- Their mail reaches us only as a **passenger** on Centurion or PMBOBO copies. It lands in Centurion's inbox, not their own.
- None of the five appears in today's pulled mail.

## Evidence

| Metric | Value |
|---|---|
| Pulled today (SAST day) | 100 = 69 routed + 31 quarantined |
| Routed today | 69, all to `centurion@legacyhotels.co.za`, all unstamped |
| Quarantined today | 31, all `missing_owner_header` |
| Quarantined today, PMBOBO in To/CC | 21 (1 is Penny-to-Penny-Legacy-only, fails closed) |
| Quarantined today, promotable Penny Reserve Cloud sends | 4 (06:58, 07:07, 07:49, 08:41 UTC) |
| Quarantined today, other | 6 (2 with empty To/CC, 4 other non-PMBOBO) |
| Inbound ever stamped with `X-Zero-Mailbox` | 11 of 8,261 |
| Quarantined 30d, all reasons | 1,238 `missing_owner_header`, 2 `message_too_large`, 0 `unknown_transport` |
| Quarantined 30d with `pmbobo@legacyhotels.co.za` in headers | 894 (72%) |
| Routed 30d to Centurion | 3,573 = 2,575 direct To, 471 To alias only, 527 CC/BCC/From only |
| Active transports in prod | `centurion@legacyhotels.co.za` (aliases `centurion@legacyhotels.com`, `centurion@legacyhotel.com`), `navaai@legacyhotels.co.za` |
| Prod env | `INGEST_REQUIRE_OWNER_HEADER=false` (documented pilot intent) |

Emails with the address in From/To/CC, all-time (ILIKE match, so "Name <address>" senders count):

| Mailbox | Emails | Latest | Routed |
|---|---|---|---|
| davinci@legacyhotels.co.za | 14 | 2 Oct | Centurion |
| adladla@legacyhotels.co.za (Ayanda Dladla) | 18 (4 sent by her) | 7 Oct | Centurion |
| fkhumalo@legacyhotels.co.za (Faith Khumalo) | 1 | 3 Sep | Centurion |
| kmgidi@legacyhotels.co.za (Khanyisile Mgidi) | 4 (1 sent by her) | 11 Sep | Centurion |
| epick@legacyhotels.co.za (Elizabeth Pick) | 3 (1 sent by her) | 18 Sep | Centurion |

Examples (subject, sender):

- davinci: "2026 STO Rate Holders List 2 October 2026" (Jaco Vermaak, 2 Oct; `davinci@` and `centurion@` both on the stored To line)
- adladla: "RE: World Cup Cricket Dates 2027 -Confirmed" (Nicole Bowman, 7 Oct, adladla on To); "RE: AIRBUS EVENT - 15/09-20/09" (Ayanda's own reply, 11 Sep)
- fkhumalo: "RE: Request to Book Room for 1 Adult from 15-09-2026 …" (Ayanda Dladla, 3 Sep, Faith on CC). Only one.
- kmgidi: "RE: AIRBUS EVENT - 15/09-20/09" (Khanyisile's own reply, 11 Sep, first found in the 2nd audit); "FW: AIRBUS EVENT - 15/09-20/09" (Ayanda Dladla, 10 Sep)
- epick: "RE: SOUTH AFRICAN HIGH COMMISSION KAMPALA (U) - HOTEL CONFIRMATION" (Elizabeth's own reply, 18 Sep); "SOUTH AFRICAN HIGH COMMISSION KAMPALA (U) - HOTEL CONFIRMATION" (kampala_immigration@dirco.gov.za, 18 Sep)

## Verified: do the five's own emails arrive?

Checked against the stored rows (`audit7`/`audit8`, 2026-10-08 ~10:50Z):

- Pickup mailboxes: only `navaai@legacyhotels.co.za`. None of the five is connected.
- Emails with any of the five on them that arrived without Centurion or PMBOBO also on them: **0 for all five** (received, sent, or quarantined).
- `navaai@` on any of their emails (a staff forward would show this): **0**.
- Tagged `X-Zero-Mailbox` email for any of the five: **0**.
- Emails from or to any of the five on the SAST day so far: **0**.

Raw header check (quarantined PMBOBO copy, 10-08 09:57): `To: Penny Mbobo <pmbobo@legacyhotels.co.za>`, no `navaai@` in To/CC. The copy arrives BCC-style, with no routable identity.

## Root causes (ranked)

1. **Ingest rule is unstamped.** The hotel-side `X-Zero-Mailbox` stamp and strip rules are still "Deferred" in `apps/server-pilot/deploy/exchange-smoke.md` (lines 40–47). Without a stamp, routing has only two keys.
2. **Pass rule has two keys only** (`apps/server-pilot/src/mail/ingest/store.ts:272-316`, origin/main):
   - (a) `To` equals an active transport email (`findDirectToTransport`, `store.ts:1704`)
   - (b) Centurion identity fallback, only when `INGEST_REQUIRE_OWNER_HEADER=false` (`findCenturionEquatedTransport`, `store.ts:1799`)
   - Everything else → `missing_owner_header`.
3. **Only Centurion and navaai have transports in prod.** No rows for PMBOBO or the five. A mailbox with no Centurion identity has no route.
4. **Copy trigger looks like Centurion or PMBOBO (inferred from headers, unconfirmed).** Every routed row carries a Centurion identity. 72% of quarantined rows carry `pmbobo@`. The 10-07 LEAPP mail has 97 To + 13 CC with `pmbobo@` present and adladla in CC. So the five are riding along. Hotel IT must confirm the real rule.
5. **Latent bug: direct-To ignores aliases.** `findDirectToTransport` compares only `transport.email`. The stamp path (`findTransportByStamp`) and the fallback use the identity set, which includes aliases. 471 Centurion routes match only through alias To. They work only because the fallback is on.
6. **Strict-flip hazard.** Turning `INGEST_REQUIRE_OWNER_HEADER=true` now would quarantine about 998 of 3,573 Centurion routes (28%, 30d): the 471 alias-To plus the 527 CC/BCC/From-only.
7. **PMBOBO re-route is manual and narrow.** `apps/server-pilot/src/mail/ingest/promote-quarantine.ts` only moves mail where the sender is exactly `pmbobo@eu.mail.reservecloud.com` with at least one non-Legacy recipient, into Centurion, from `ingest-nava-legacy` only. Staff and guest mail to `pmbobo@` never promotes. `transportOverride` has no other caller, so there is no generic replay. The 1,238-row backlog stays parked even after transports exist.

Non-bug, heads-up: 4 Synxis "RESERVATION FAILED TO INTEGRATE (MODIFICATION)" alerts today (02:00–06:50 UTC) and 2 hotel FortiMail quarantine digests are landing in the Centurion inbox.

## Options for the five mailboxes

| Option | Pros | Cons | Risk |
|---|---|---|---|
| **A. Per-mailbox BCC to navaai@ + `X-Zero-Mailbox: <addr>` (last), strip forged stamps, one `mailbox_transport` row each** (recommended) | Deterministic. Covers To-less BCC copies and From-only mail. Matches the designed path. | Hotel IT change plus DB inserts | Typo'd stamp → `unknown_transport` (visible, not silent) |
| B. Transport rows only, no stamps | No stamp work at hotel | Mail they send without their address in To stays quarantined. Still leans on fallback. | Silent gaps |
| C. Add the five as Centurion aliases | Zero hotel work | Puts their mail in Centurion's inbox. Wrong ownership. | Mis-ownership |

Assumptions: the five are separate mailboxes, not Centurion aliases; hotel IT can add rules.
Open questions: separate transports or fold into Centurion? Is `pmbobo@legacyhotels.co.za` its own transport? Who approves prod DB inserts?
Recommendation (updated 2026-10-08): **route on addresses first**. Order: From, then To, then CC, against every inbox identity including aliases. That covers the five's sent and received mail. Add the hotel tag (option A) later, only for BCC-only copies, which carry none of the five's addresses. Centurion's 2,376 outbound emails in 30 days route only through the lenient fallback, so this ordering is also the blocker for flipping strict mode.

## Plan (not executed)

1. Hotel IT: confirm the copy-rule trigger and add the five with stamp + strip rules.
2. Approval, then insert one `mailbox_transport` row per address (`email` = `owner_header_value` = address, `mailbox_type`, `display_name`).
3. Code: route on From, then To, then CC, against every inbox identity including aliases (not To-only). Tests: an email sent from an inbox routes there as outbound; an alias To routes; strict mode no longer parks Centurion's outbound mail.
4. Decide PMBOBO: own transport, or keep promote-only with a documented policy.
5. Build a gated generic replay for quarantined rows after steps 1–3, so the backlog can re-route.
6. Flip `INGEST_REQUIRE_OWNER_HEADER=true` only after 1–3 are verified. Rollback = set false.

Verification: `missing_owner_header` per day trends down; `unknown_transport` stays near zero; Centurion routes by reason stay stable across the flip.

## Method

- Read-only on prod: SSM `RunShellScript` to the worker (`i-008f737974a9ba9b3`), with SELECTs inside `SET TRANSACTION READ ONLY`, S3 `GetObject` header bytes only, `pm2 jlist`/`logs`, and `git log`.
- RDS and EC2 `describe-*` only. RDS has no events in the last 6h and no pending changes.
- Audit scripts live in `/tmp/zero-ingest-audit/` and are not in the repo.
