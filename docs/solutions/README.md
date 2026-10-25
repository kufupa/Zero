# Documented solutions (Compound Engineering)

Searchable learnings from solved problems on this repo. Written by `/ce-compound` after verified fixes.

## Index

| Doc | Topic |
|-----|-------|
| [workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) | EC2 deploy, bundle sync, SSM — prefer `ops-deploy.sh` |
| [workflow-issues/ec2-pilot-safe-reboot-and-prod-restart.md](workflow-issues/ec2-pilot-safe-reboot-and-prod-restart.md) | Soft reboot + EIP; primary ops: `ops-reboot.sh` / `ops-restart.sh` |
| [workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md](workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) | Three laptop ops scripts + PM2 boot survival + post-boot smoke |
| [integration-issues/fe-pilot-trpc-wire-contract-drift.md](integration-issues/fe-pilot-trpc-wire-contract-drift.md) | tRPC 405, FE/pilot payload drift, load gate false positives |
| [security-issues/ec2-pilot-pre-real-ingest-security-gate.md](security-issues/ec2-pilot-pre-real-ingest-security-gate.md) | Security hardening wave before real mail |
| [architecture-patterns/mail-transport-mode-fixture-vs-real.md](architecture-patterns/mail-transport-mode-fixture-vs-real.md) | MAIL_TRANSPORT_MODE fixture vs real handoff |
| [architecture-patterns/live-pilot-production-parity-real-mail.md](architecture-patterns/live-pilot-production-parity-real-mail.md) | Live-pilot parity: auth host, 15s poll, forceSync, U9 gate, UNDO 0↔30 |
| [logic-errors/mail-open-thread-stale-and-recipient-you-label.md](logic-errors/mail-open-thread-stale-and-recipient-you-label.md) | Open-thread poll + To:You only when recipient is mailbox |
| [logic-errors/mail-quoted-history-crop-and-collapse.md](logic-errors/mail-quoted-history-crop-and-collapse.md) | Reply quote crop + ellipsis collapse for quoted history |
| [runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md](runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md) | PM2 ESM `isMain` + unref sleep → worker errored / empty logs |
| [workflow-issues/2026-10-13-evidence-first-research-library.md](workflow-issues/2026-10-13-evidence-first-research-library.md) | Reuse private snapshots; distinguish execution from scored correctness |
| [../research/2026-10-13/README.md](../research/2026-10-13/README.md) | 2026-10-13 research index, corpus boundary, and report links |
| [logic-errors/2026-10-25-wal-grid-vs-restricted-walk-in.md](logic-errors/2026-10-25-wal-grid-vs-restricted-walk-in.md) | WAL #548 calendar merge; native restricted Walk-in still dropped |
| [ui-bugs/2026-10-25-extras-in-stay-cards.md](ui-bugs/2026-10-25-extras-in-stay-cards.md) | U13a extras in stay cards; alts under rate rows |
| [conventions/2026-10-25-cen-8-row-held.md](conventions/2026-10-25-cen-8-row-held.md) | DoD4 CEN 8-row held 5/8 |
| [integration-issues/2026-10-25-labtest-create-cancel-both-hotels.md](integration-issues/2026-10-25-labtest-create-cancel-both-hotels.md) | DoD5 Labtest create+cancel HRCEN+HRDAV |
| [conventions/2026-10-25-reply-check-eval-n114.md](conventions/2026-10-25-reply-check-eval-n114.md) | DoD7 n=114; do not flip REPLY_RECHECK on |
| [ui-bugs/2026-10-25-stay-contact-canonical.md](ui-bugs/2026-10-25-stay-contact-canonical.md) | U13-dedup Stay+contact canonical |

Domain vocabulary: [CONCEPTS.md](../../CONCEPTS.md) at repo root.

## Layout

- `docs/solutions/<category>/<slug>.md` — one file per learning
- YAML frontmatter: `module`, `tags`, `problem_type`, `component`
- `CONCEPTS.md` (repo root, when present) — shared domain vocabulary

## When to search here

Before implementing or debugging in areas already touched by EC2 pilot work: ingest, tRPC wire contract, deploy/SSM, RDS, IndexedDB cache, auth.

## Capture a learning

After a non-trivial fix is verified:

```
/ce-compound [brief context]
```

Or headless (automations):

```
/ce-compound mode:headless EC2 deploy SSM charmap crash
```

Plugin: Compound Engineering (`.cursor/settings.json`). Skills live in `.cursor/compound-engineering/skills/`.
