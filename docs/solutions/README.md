# Documented solutions (Compound Engineering)

Searchable learnings from solved problems on this repo. Written by `/ce-compound` after verified fixes.

## Index (EC2-pilot, 2026-07-02)

| Doc | Topic |
|-----|-------|
| [workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) | EC2 deploy, bundle sync, SSM — prefer `ops-deploy.sh` |
| [workflow-issues/ec2-pilot-safe-reboot-and-prod-restart.md](workflow-issues/ec2-pilot-safe-reboot-and-prod-restart.md) | Soft reboot + EIP; primary ops: `ops-reboot.sh` / `ops-restart.sh` |
| [integration-issues/fe-pilot-trpc-wire-contract-drift.md](integration-issues/fe-pilot-trpc-wire-contract-drift.md) | tRPC 405, FE/pilot payload drift, load gate false positives |
| [security-issues/ec2-pilot-pre-real-ingest-security-gate.md](security-issues/ec2-pilot-pre-real-ingest-security-gate.md) | Security hardening wave before real mail |
| [architecture-patterns/mail-transport-mode-fixture-vs-real.md](architecture-patterns/mail-transport-mode-fixture-vs-real.md) | MAIL_TRANSPORT_MODE fixture vs real handoff |
| [architecture-patterns/nava-fixture-loopback-e2e-harness.md](architecture-patterns/nava-fixture-loopback-e2e-harness.md) | Fixture loopback bridge, Nava E2E scenarios, EC2 gate |

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
