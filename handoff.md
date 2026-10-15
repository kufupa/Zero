# HANDOFF: ingest audit, five legacy mailboxes

Written 2026-10-12 09:36 UTC. Prod data snapshot is 2026-10-09 ~11:47 UTC, so it is 3 days old. Re-run before quoting any number.
Untracked file. Do not commit unless asked.
Full transcript of the chat: `/home/orca/.claude/projects/-home-ubuntu-projects-zero--worktrees-centurion-dashboard-tools/3cede93e-d05f-4508-904a-c16dbb450a61.jsonl`

---

## 0. Read first

**Answer:** the five mailboxes are not connected. Nothing from them lands in their own inboxes. But since 2026-10-08 13:24 UTC, their own sent and received mail reaches `navaai@` as hidden copies. Every copy is quarantined as `missing_owner_header`. Nothing is routed to them.

Five things to know before acting:
1. **Data is 3 days old.** Re-run the queries in section 6 first.
2. **The scripts are gone.** `/tmp/zero-ingest-audit/` no longer exists. Section 6 has the pattern to rebuild them.
3. **Main has moved.** `origin/main` is `61ac5d77f` (2026-10-12). The RCA's line numbers and basis (`e7fc3357`) are stale. Four ingest commits landed since (section 2b). Check the worker HEAD before trusting any code reading.
4. **The hotel contact said no outbound rule was set.** The data says otherwise: outbound copies exist from 10-08 13:24 UTC. Unresolved. Do not say anyone is lying. Ask IT for the config (section 4).
5. **The V6 "still running" ETAs from 10-09 are probably moot.** `gh pr view 53` in `kufupa/Zero` says PR #53 was created 2026-10-08 11:06Z and merged 2026-10-08 11:18Z. That conflicts with the earlier "open, CI pending" note from 10-09. Trust `gh`.

---

## 1. People, rules, constraints

**Names and mailboxes** (use the names given. No pronouns were stated, so use they/them):
- davinci@: "DAVINCI Reservations" is a shared display name on this mailbox.
- adladla@: Ayanda Dladla
- fkhumalo@: Faith Khumalo
- kmgidi@: Khanyisile Mgidi
- epick@: Elizabeth Pick
- PMBOBO = pmbobo@legacyhotels.co.za (Penny Mbobo). Reserve Cloud sender = pmbobo@eu.mail.reservecloud.com.
- Centurion = centurion@legacyhotels.co.za (the hotel's shared inbox transport).

**User's rules (from this chat and CLAUDE.md):**
- Read-only on prod. No DB inserts, no deploys, no edits to code unless the user asks. The user said "plan, don't fix".
- Do not touch the other two sessions: the Lunar Plan executor and the Outlook side-pane reader. Read their transcripts only.
- Never ask client staff to run scripts. Ask hotel IT for config checks instead.
- Show counts per mailbox. The user rejected random example emails twice. Say "no" plainly when the answer is no, and give last-seen dates.
- Output style: caveman full + adhd. Bold answer first, numbered sections, tables, at most 3 bullet levels. Cost in $ by model, never raw tokens.
- ETA rule: log every ETA to `/home/orca/.claude/eta-ledger.jsonl` with `jq -c` (start row, then close row with the same `id`). Give ETAs in minutes. Scale the raw guess by the median ratio for the kind first. None of this chat's ETAs were logged. That's a rule miss. Log them retroactively or note it.
- Decisions: option blocks need completeness X/10, ETA and ROI. Recommend one option. Don't ask open questions when a default is clear.
- Generalize. The routing fix must not hardcode the five addresses (no entity rules, no rare-case work under 2% of mail).
- No GitHub Actions workflows. Never add or trigger one.
- Never commit or push unless asked.

---

## 2. Facts (snapshot 10-09 ~11:47 UTC unless noted)

### 2a. Configuration

| Item | Value |
|---|---|
| Pickup mailboxes (`mail_ingest_mailbox`) | `navaai@legacyhotels.co.za` only (id `ingest-nava-legacy`) |
| Transport rows | `centurion@legacyhotels.co.za`, `navaai@legacyhotels.co.za`, plus 3 `example.com` rows (`nava-0d03ffcb@`, `nava-9efba301@`, `replay@`). These look like test or replay rows. None is one of the five. |
| `INGEST_REQUIRE_OWNER_HEADER` | false in prod (per RCA; fallback routes observed). Default in `env.ts` is true. |
| `X-Zero-Mailbox` stamps on inbound | 0 since 10-08 10:50 UTC |
| Quarantine table columns | id, ingest_mailbox_id, pop3_uidl, raw_mime_s3_key, reason, owner_header_value, parsed_headers (jsonb), created_at. **No direction column.** |
| `parsed_headers` keys | subject, messageId, references, inReplyTo, date, to, cc, from. **No bcc.** |

### 2b. Code (origin/main `61ac5d77f`)

Routing, `apps/server-pilot/src/mail/ingest/store.ts`:
- L304: `findDirectToTransport(parsed.toAddresses)`. Matches `transport.email` only, in To only. Defined at L1737.
- L305–306: if no direct match and strict flag is false, `findCenturionEquatedTransport`. Identities include aliases. Checks From, To, CC and BCC. Defined at L1832.
- L315: otherwise quarantine `missing_owner_header`.
- L322: `X-Zero-Mailbox` stamp path, `findTransportByStamp` (L1805). No match gives `unknown_transport`.

Direction, same file L668–674:
- Outbound only if From is a transport identity (transport email plus send-from aliases) and no To, CC or BCC is one.
- Otherwise inbound.
- Runs only after routing succeeds. The five have no transport, so their mail can never be outbound in the app.

Ingest commits on main since the RCA basis `e7fc3357`:

| Commit | Date | What |
|---|---|---|
| ab8896ebf | 10-09 | U3 ingest extraction + translation |
| e4d0901df | 10-10 | U5 retire old triage + backfill |
| d30c973ca | 10-11 | C3+C2 |
| 29896d04c | 10-11 | #180 trusted arrival clock from top Received header |

Routing structure is unchanged. #180 adds a `deliveredAt` field in provenance and the work-item clock. It does **not** change `created_at`, so my windows still use `created_at` (insert time).

Other code notes:
- `promote-quarantine.ts`: the only re-route path. It handles PMBOBO only, sender exactly `pmbobo@eu.mail.reservecloud.com`, with a non-Legacy recipient. Requires strict flag false. `transportOverride` has no generic caller, so there is no replay tool for the backlog.
- Quarantine raw MIME is archived to S3 at `quarantine-archive/<ingestMailboxId>/<uidl>.eml` (bucket `nava-zero-mail-845242190536-af-south-1`). No expiry rule on that prefix.
- One `message.raw_mime_s3_key` returned 404 in S3 during the check. Quarantine keys read fine.

### 2c. The five's own mail arrived as hidden copies

Delegate notices. Each mailbox granted `navaai@` delegate permission, and Zimbra sent a notice to navaai:

| Mailbox | Notice (UTC, 10-08) | First own mail sent (UTC) | First mail to them received (UTC) |
|---|---|---|---|
| davinci | 13:16 | 13:24 | 13:35 |
| adladla | 13:20 | 14:08 | 13:39 |
| fkhumalo | 13:23 | 13:32 | 13:26 |
| kmgidi | 13:26 | 13:51 | 13:35 |
| epick | 13:28 | 14:24 | 13:24 |

Historic notices, already routed to navaai: centurion@ on 07-27 13:17 UTC, pmbobo@ on 09-03 08:34 UTC.

Those 5 notices were routed to navaai as inbound. Everything else for the five is quarantined.

### 2d. Counts (quarantined only)

Labels are from headers, from the mailbox owner's point of view:
- **Inbound** = To or CC has the mailbox, and From is not it.
- **Outbound** = From is the mailbox.

These are not the app's direction labels (see 2b).

**Yesterday, SAST day 10-08** (10-07 22:00Z to 10-08 22:00Z). Full day.

| Mailbox | Inbound | Outbound | Total |
|---|---|---|---|
| davinci | 24 | 23 | 47 |
| adladla | 24 | 4 | 28 |
| fkhumalo | 34 | 5 | 39 |
| kmgidi | 22 | 7 | 29 |
| epick | 31 | 4 | 35 |
| **Total** | **135** | **43** | **178** |

All quarantined yesterday, any mailbox: 181.

**Today so far, SAST day 10-09** (from 10-08 22:00Z). Snapshot at ~11:30 UTC, about 13.5 hours in.

| Mailbox | Inbound | Outbound | Total |
|---|---|---|---|
| davinci | 33 | 39 | 72 |
| adladla | 46 | 11 (12 later) | 57 |
| fkhumalo | 81 | 20 | 101 |
| kmgidi | 41 | 10 | 51 |
| epick | 62 | 8 | 70 |
| **Total** | **263** | **88** | **351** |

All quarantined today, any mailbox: 299 at ~11:22 UTC.

Routed today, any mailbox, ~11:22 UTC: 102 inbound and 34 outbound, all to Centurion. The 34 outbound are Centurion's own sent mail. None is in `outbound_send_queue`, so none came from the app.

Since 10-08 10:50 UTC: routed 244 (158 inbound, 81 outbound on Centurion, 5 notices to navaai). Quarantined 443, all `missing_owner_header`.

**Recipients of the five's sends** (quarantined, From = the five):

| Window | Sends | Self-CC | No other of the five (self included) | …any external | …external only |
|---|---|---|---|---|---|
| Yesterday | 43 | 0 | 5 | 3 | 2 |
| Today, ~11:47 UTC | 89 (90 later) | 3 | 12 | 5 | 2 |

Today, with the sender excluded from the recipient set: 13 went to no other of the five, and 21 had at least one external recipient. "External" means outside `legacyhotels.*`. Recipient domains include gmail.com, springbokatlas.com, newfrontierstours.co.za, allsportstravel.co.za, travel.co.za, citytyres.net, eventureescapes.com. These counts are recipients, not mails.

### 2e. Headers (today's quarantined rows)

- No `navaai@` anywhere in headers, across 351 rows read.
- No Bcc header. No Delivered-To header.
- `X-ExSBR-Direction: Incoming` is on 60 of 88 sends. The other 28 have no such header. It can't be used for direction.
- Header-name set for sends is the same yesterday and today, apart from normal per-mail extras.
- No stamp on any copy.

**Received chain** (2 samples, read with S3):

| Sample | Path |
|---|---|
| Davinci's first send yesterday, 13:24 UTC | `CMS-SRV` (172.24.240.60) → `mail.legacyhotels.com` Postfix → Postfix re-injected on localhost (twice) → LMTP delivery |
| Davinci's latest send today, 11:47 UTC | `ResMngPC` (172.24.56.41) → `branding.legacyhotels.co.za` Exim → `mail.legacyhotels.com` Postfix (for fkhumalo) → Postfix re-injected on localhost (twice) → LMTP delivery |

Reading: the second copy is made by `mail.legacyhotels.com` itself, after the normal send. A PC-side Outlook rule would not produce those hops. This fits a server-side BCC or transport rule, or a per-account mail filter on the mail server. Two samples only. Confirm with IT.

---

## 3. What I believe, and how sure

| Claim | Confidence |
|---|---|
| The five's own mail (sent and received) reaches `navaai@` as hidden copies since 10-08 13:24 UTC | High |
| None of it reaches their own inboxes. All of it is quarantined. | High (no transport rows) |
| Copies start within 8–46 min after each delegate grant | High on timing. Cause not confirmed. |
| Copies are created on `mail.legacyhotels.com`, server-side | Medium (two samples) |
| Inbound and outbound copies start within the same hour on each mailbox, so probably one mechanism covering both | Medium-high |
| A delegate grant alone does not put mail in navaai's POP3 inbox | Medium (reasoning, not tested) |
| The hotel contact's "no outbound rule" is wrong, or the rule covers more than they know | Unresolved. Possibilities: (a) rule set 10-08 afternoon and remembered as "today"; (b) rule set by an admin, not the mailbox owner; (c) a server-wide BCC or journaling rule; (d) a second rule added later. |

Do not present (d) as likely without evidence.

---

## 4. Open decisions and asks

Recommended order (my default, not yet agreed by the user):

| # | Action | Who | Completeness | ROI | Notes |
|---|---|---|---|---|---|
| 1 | IT config check (draft below) | User sends it. We draft. | 9/10 | High, low cost | Settles the rule question and gives the change log. |
| 2 | Re-run the audit (section 6) and refresh the numbers | Us, read-only | 9/10 | High | Snapshot is 3 days old. |
| 3 | Update RCA doc (`docs/plans/2026-10-08-005-ingest-routing-rca.md`). Its "Answer" section still says "not set up / passenger only". Refresh line numbers. | Us | 10/10 | Medium | Untracked file. |
| 4 | Insert five `mailbox_transport` rows | Needs user approval (prod DB write) | 6/10 | Medium | Inbound to them then routes (direct To). **Their sends still won't route**, because routing checks To/CC only. |
| 5 | From-first routing (From, then To, then CC, against all identities incl. aliases), plus tests | Us, after approval | 7/10 | High | Generic, not hardcoded. Fixes sends. Makes the app's outbound rule reachable. |
| 6 | Gated replay for the quarantined backlog | Us, after 4 and 5 | 6/10 | High for backlog | Nothing exists today. `promote-quarantine.ts` covers PMBOBO only. |
| 7 | Flip `INGEST_REQUIRE_OWNER_HEADER=true` | Us, after 4–6 verified | 5/10 | Risky now | Strict mode would park about 28% of Centurion's 30-day routes (about 998 of 3,573), mostly alias-To and CC/BCC/From-only. |
| 8 | Find the 10-08 Codex/Cursor chat about "distinguishing these" | Us | 5/10 | Low–medium | The user recalled one. Not in docs, memory, or hindsight `reflect` (which timed out). Try `cursor-zero-history-sync` or hindsight search (not reflect). |

ETA: not estimated yet. Before quoting one, read the relevant code (done for routing) and scale a raw guess by the ledger median for `code-server`. The command is in CLAUDE.md.

**Draft IT message** (for the user to send; not sent):

> Quick config check on five mailboxes (davinci, adladla, fkhumalo, kmgidi, epick @legacyhotels.co.za). Since 8 Oct ~15:15 SAST, copies of their sent and received mail reach navaai@legacyhotels.co.za with no navaai address in To or CC. Please check on mail.legacyhotels.com:
> 1. Any Postfix `always_bcc`, `sender_bcc`, `recipient_bcc` or transport map entries that cover these addresses or legacyhotels.co.za.
> 2. Any Zimbra filter or "send copy" setting on the five accounts.
> 3. When navaai@ was added as delegate on each mailbox.
> 4. Any journaling rule.
> Please send the rule names, who created them, and when.

---

## 5. Other chats (do not disturb)

**Lunar Plan executor** (V4 → V5 → V6, Opus-led):
- Transcript: `728a2973-7b9f-48b4-bb74-d9b638d8cc5a.jsonl`
- Last write at last check: 10-09 11:12 UTC
- V6 sprint: the 11:05 UTC freeze most likely fell on 10-08. That matches the gh timestamps for PR #53 (created 11:06Z, merged 11:18Z on 10-08). Not confirmed from the plan itself.
- My earlier ETA (given 10-09 11:14 UTC): ledger/handoff ~11:25, PR #53 ~11:40, summary ~11:45, speed-flag test ~12:00–12:15. **Likely moot.** PR #53 is merged per gh.
- Speed-flag two-quote test: never ran. Flag stays OFF per the cut rule.
- Centurion folder-row check: unverified. It was a never-cut item.
- Tourvest and DHET agency check: pending.
- Check `docs/plans/2026-10-08-003-luna-plan-v6-folders-and-followups.md` and `docs/plans/handoff-reports/2026-10-08-luna-pilot-morning.md` (origin/main) for current state.

**Outlook side-pane reader:**
- Transcript: `59bff2f7-...jsonl`
- Last write at last check: 10-08 10:57 UTC
- Do not touch.

---

## 6. Re-creating the checks

The scripts are gone. Rebuild from this.

**Pattern** (one `.mjs` per check, read-only):
- Load `postgres` and `@aws-sdk/client-s3` with `createRequire('/home/ubuntu/repos/zero/apps/server-pilot/package.json')`.
- Use `readFileSync('.../deploy/rds-ca-global.pem')` for SSL with `rejectUnauthorized: true`.
- Inside `sql.begin`: `SET TRANSACTION READ ONLY`, then `SET LOCAL statement_timeout = '30s'`.
- S3 reads: `GetObject` with `Range: 'bytes=0-16383'` only, on `raw_mime_s3_key`.

**Run on the worker via SSM** (`i-008f737974a9ba9b3`, `af-south-1`):

```bash
B64=$(base64 -w0 check.mjs)
JSON=$(jq -n --arg b "$B64" '{commands:[
  "install -d -m 755 /tmp/zero-audit-run",
  ("echo " + $b + " | base64 -d > /tmp/zero-audit-run/check.mjs && chmod 644 /tmp/zero-audit-run/check.mjs"),
  "sudo -u ubuntu bash -lc '"'"'cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && . ./.env.production && set +a && node /tmp/zero-audit-run/check.mjs'"'"'"]}')
CID=$(aws ssm send-command --region af-south-1 --instance-ids i-008f737974a9ba9b3 \
  --document-name AWS-RunShellScript --comment "read-only: <short label>" \
  --timeout-seconds 120 --parameters "$JSON" --query 'Command.CommandId' --output text)
aws ssm wait command-executed --region af-south-1 --command-id "$CID" --instance-id i-008f737974a9ba9b3 >/dev/null 2>&1 || true
aws ssm get-command-invocation --region af-south-1 --command-id "$CID" --instance-id i-008f737974a9ba9b3 --query StandardOutputContent --output text
```

Gotchas:
- SSM rejects `--comment` over 100 characters.
- SSM output is capped at about 24k characters.
- `left(jsonb, n)` fails. Use `left((parsed_headers->'to')::text, n)`.
- `parsed_headers::text ILIKE '%addr%'` matches display names too (for example `"DAVINCI Reservations" <davinci@…>`).

**Core queries:**

```sql
-- Window: yesterday [2026-10-07 22:00Z, 2026-10-08 22:00Z); today from 2026-10-08 22:00Z
-- Sent by mailbox
SELECT count(*) FROM mail_ingest_quarantine
WHERE created_at >= $start AND created_at < $end
  AND parsed_headers->>'from' ILIKE '%davinci@legacyhotels.co.za%';

-- Received by mailbox (To or CC has it, From does not)
SELECT count(*) FROM mail_ingest_quarantine
WHERE created_at >= $start AND created_at < $end
  AND parsed_headers->>'from' NOT ILIKE '%davinci@legacyhotels.co.za%'
  AND ((parsed_headers->'to')::text ILIKE '%davinci@legacyhotels.co.za%'
    OR (parsed_headers->'cc')::text ILIKE '%davinci@legacyhotels.co.za%');

-- Routed rows and direction (message table)
SELECT coalesce(t.email,'(none)'), m.direction, count(*)
FROM message m LEFT JOIN mailbox_transport t ON t.id = m.transport_id
WHERE m.created_at >= $start GROUP BY 1,2;

-- Hotel copies vs app sends (outbound copies not from the app)
SELECT (q.message_id IS NOT NULL) AS app_sent, count(*)
FROM message m LEFT JOIN outbound_send_queue q ON q.message_id = m.id
WHERE m.created_at >= $start AND m.direction = 'outbound' GROUP BY 1;

-- Notices (delegate)
SELECT created_at, from_address, subject FROM message
WHERE subject ILIKE '%granted delegate%' ORDER BY created_at;
```

Recipient split: parse `parsed_headers->'to'` and `->'cc'` as JSON, pull emails with `/[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi`, then classify. Legacy = `/@legacyhotels?\.(co\.za|com)$/`.

Header read: `Received`, `X-ExSBR-Direction`, `Bcc`, `Delivered-To`, `navaai@`. Unfold continuation lines first (`replace(/\r?\n[ \t]+/g, ' ')`).

---

## 7. Next steps, in order

1. Re-run section 6's core counts for yesterday and today. Read-only.
2. Confirm with the user what IT said, and whether it was in writing. Send the draft IT message if they want.
3. Update the RCA doc's Answer section and timeline with the facts above. Use current line numbers.
4. Wait for the user's decision on items 4–6 in section 4. Give the completeness, ETA and ROI for each option.
5. Log ETAs to the ledger, with a retro row for the 10-09 V6 ETA.
6. Check the Codex/Cursor history for the 10-08 chat.

---

## 8. Don'ts

- Don't show random example emails as evidence. Use counts per mailbox.
- Don't say "not ingesting" when copies are arriving. Say: hidden copies, quarantined, not in any inbox.
- Don't claim the outbound rule exists or doesn't without evidence.
- Don't name IT staff or call anyone a liar.
- Don't insert transport rows or change prod config without approval.
- Don't touch the executor or reader sessions.
- Don't commit or push. Don't add workflows.
- Don't quote the RCA's line numbers or "not set up" wording as current.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| Parked / quarantined | Row in `mail_ingest_quarantine`. Not in any inbox. |
| Routed | Row in `message` with a transport. |
| Transport | A `mailbox_transport` row (an inbox identity). |
| Identity | Transport email plus send-from aliases. |
| Hidden copy | Mail that reaches navaai with no navaai address in To, CC or headers. |
| SAST day | 22:00Z of the previous day to 22:00Z. |
| Stamp | `X-Zero-Mailbox` header. Designed route, not in use. |
| Delegate notice | Zimbra email "<mailbox> has granted delegate permission", sent to the delegate. |
