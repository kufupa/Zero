# 2026-10-20 Da Vinci ingest: where the 5 mailboxes' mail goes today

Read-only prod SQL (`BEGIN READ ONLY … ROLLBACK` via `ssm-run-command.sh`, counts only) at 18:10–18:28Z on prod `3e1acb694`, plus a `provision-prod.ts` dry-run (no `--apply`, no writes). Owner ask 172; IT confirmed 5 Da Vinci mailboxes (davinci@, adladla@, fkhumalo@, kmgidi@, epick@) send inbound and outbound copies to the Nava sink.

## 1. Answer

All 5 mailboxes' mail reaches the sink, but only the two mailboxes with a `mailbox_transport` row (fkhumalo, adladla) get routed. The other three (davinci, epick, kmgidi) have no row, so their mail lands in `mail_ingest_quarantine` with reason `missing_owner_header`. Raw MIME stays in S3 (`raw_mime_s3_key`) and can be promoted later.

## 2. Counts

| Mailbox | Transport row | Routed msgs (since 10-16) | Outbound routed | Quarantined 30 d (`missing_owner_header`) | Quarantined last 4 d | In From (30 d) |
|---|---|---:|---:|---:|---:|---:|
| davinci | **no** | 0 | 0 | 1,609 | 463 | 691 |
| epick | **no** | 0 | 0 | 1,160 | 307 | 228 |
| kmgidi | **no** | 0 | 0 | 611 | 163 | 111 |
| fkhumalo | yes | 268 | 64 | 858 (mostly before 10-16) | 0 | 140 |
| adladla | yes | 210 | 31 | 646 (mostly before 10-16) | 0 | 78 |

- Distinct quarantined messages naming any Da Vinci mailbox, 30 d: **3,422** (a message naming two boxes counts once here, once per box above).
- Also `multi_transport` quarantine (mail naming two known transports): davinci 6, epick 49, kmgidi 52, fkhumalo 68, adladla 68.
- Owner-header stamp is absent on all of them (`owner_header_value` null). Prod runs `INGEST_REQUIRE_OWNER_HEADER=false` (env file + `/proc` on 2 ingest procs), so unstamped mail routes by To/Cc/Bcc/From identity — it only fails because the three identities have no row.

## 3. Provision dry-run (what `provision-prod.ts --apply` would do as-is)

| Would create | Count | Note |
|---|---:|---|
| Transports | 3 | davinci, epick, kmgidi — the fix |
| Users (staff logins with passwords) | 3 | ask 110 says **no logins now** |
| Grants | 8 | 3 staff + 5 Nava-user grants (incl. missing Nava grants on faith/ayanda) |
| Centurion aliases | 2 | centurionrec@, centurionbq@ — changes Centurion routing; pending 5 days |

So the as-is apply does more than the 3 rows. A transport-only path (`--transports-only`: transports + Nava grants, no users, no alias edits) is the safe write.

## 4. Multi-mailbox mail (superseded the "accept 20%" proposal; owner ask 173)

| Fact (read-only, 18:40–18:55Z) | Count |
|---|---:|
| POP copies per quarantined DV Message-ID | 1 for all 3,422 (the sink gets one copy, not one per mailbox) |
| Distinct DV mails naming 1 / 2 / 3 / 4 DV boxes | 2,157 / 1,007 / 76 / 182 |
| Of those, From is a hotel mailbox | 1,254 |
| Routed fkhumalo/adladla mail whose From is another DV box (that box never got its sent copy) | 86 / 19 |
| Routed fkhumalo/adladla mail that would turn `multi` once the 3 rows exist | up to 62 / 36 |
| Centurion mail (30 d) naming any DV box | 11 / 5,414 |
| Ingest sinks | 1 (`ingest-nava-legacy`) |
| fkhumalo/adladla mail live-admitted / with extraction | 480 / 335 (AI already runs on DV mail) |

Fix: fan-out, so every named mailbox gets its own `message` row (plan unit UDV-2). It needs no migration, because extra copies key on `<uidl>#t:<transportId>`. It removes `multi_transport` for hotel mailboxes and the lost Cc/sent copies.

## 5. Promotion of the backlog

`promote-quarantine.ts` is Centurion-only (plan unit UDV-3 generalises it with `skipAiEnqueue`) (`CENTURION_TRANSPORT_ID`, `CENTURION_INGEST_MAILBOX_IDS`, sender predicate, hard-coded outbound direction). Promoting Da Vinci history needs it generalised to resolve the target transport from parsed To/Cc/Bcc/From identity with the same resolver as `store.ts`, infer direction, and leave ambiguous rows quarantined. The promoter does not enqueue extraction itself.

## 6. Limits

Counts are header-regex matches on `parsed_headers` JSON, not parsed identities; one quarantine row can name several boxes. Not checked: S3 lifecycle on quarantined raw MIME (oldest row seen 10-07), and whether promoted old mail would pass live admission (it should not extract old mail).
