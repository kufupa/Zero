# Centurion Aug–Sep Sent Catchup Handoff — 2026-09-11

## Goal

Ingest all Aug–Sep 2026 Centurion Sent from PST into pilot RDS, keep existing catchup/live dups, preserve real Message-IDs, recompute conversation links, re-enqueue inbound triage on affected inbound-bearing threads.

## Result: DONE

| Gate | Evidence |
|------|----------|
| MID preserve | `resolveCatchupMessageId`; **333** new rows with real `message_id_header` (not `@catchup.legacyhotels.co.za`) |
| Dry-run | scanned=1267, dupContent=177, wouldStore≈1090 |
| Write | scanned=1267, **stored=1068**, dupContent=199, errors=0, skippedFp=0 |
| TZ/day skips | skip list 28 pre-filtered from manifest; TZ uidl hits in RDS = **0** |
| Catchup keep | prior catchup rows retained; catchup_all=1376 (=308 prior +1068) |
| Aug–Sep outbound | **2153** (baseline was ~1069) |
| Links | apply: proposed/upserted **2274**, superseded **52**, activeAfter **2274** |
| Mega-cluster | max connected component **7**, components >40 = **0** |
| Retriage | **356** `inbound_triage` keys `inbound-triage:catchup-augsep-2026:<threadId>` (33 self-inbound + 323 linked) |

## Commits

- `14b74f3f` feat: MID preserve + skip-fps + plan
- `9d2f79a3` fix: retriage import
- `c0adb6b3` fix: `supersededAt` (not `deactivatedAt`)

## Divergences

1. Store target ~1076 → actual **1068** (within 5%; dry-run 1090, write content-dup rose 177→199 as batch self-dups).
2. Catchup day+norm exclude measured **276** (design ~270).
3. Retriage first attempt failed on wrong column name; fixed and re-ran successfully.
4. Blind body-hash SKIP not used; only locked 4 TZ fps + day-only 24.

## Artifacts (local, not committed)

- `.private/backup-zip-2026-09-10/augsep-store-manifest.json`
- `.private/backup-zip-2026-09-10/augsep-tz-bodyhash-skip.json`
- `.private/backup-zip-2026-09-10/augsep-dayonly-verdict.json`

## Cleanup

- S3 `tmp/operator/augsep-catchup-stage.tar` removed
- EC2 `/home/ubuntu/augsep-catchup` removed

## Safety

- No Vitest against pilot RDS
- Operator scripts sourced `.env.production` then unset
- No `.private/` mail committed
