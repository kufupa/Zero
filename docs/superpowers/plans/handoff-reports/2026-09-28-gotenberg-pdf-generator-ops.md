# Handoff: Loopback quote PDF generator on pilot EC2

- **Date:** 2026-09-28
- **Plan:** `~/.cursor/plans/Gotenberg sidecar ops-f1b88c86.plan.md`
- **Git:** Gotenberg code was already on `origin/main` via [PR #20](https://github.com/kufupa/Zero/pull/20); this handoff records the ops run.
- **EC2 at ops:** `i-008f737974a9ba9b3` (`af-south-1`) HEAD `bb256219bc23cdb48a20ad3214fdc3f7206a439f`
- **Operator worktree used for bundle:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` with `GIT_BRANCH=main` (checkout branch ignored).

## Goal

Ship the already-merged LibreOffice converter to the pilot box so Outlook Insert Draft attaches a server-made PDF. Do not change the downloaded VSTO add-in.

## Architecture (true)

Outlook installer stays. Served pane JS already calls `workstation.quoteProposalPdf`. PM2 `http` (`nava.legacyhotels.co.za`) POSTs XLSX to loopback Gotenberg at `http://127.0.0.1:3000`. No new bus. `remote-http` does not convert quotes.

Compose `restart: unless-stopped` plus `systemctl enable docker` keep the generator up across PM2 bounce and box reboot. Bind is `127.0.0.1:3000` only. Never ALB / public SG.

## Code already on GitHub (before this ops)

| SHA | Message |
|-----|---------|
| `7e7080b3` | `feat(deploy): persist loopback Gotenberg sidecar for quote PDFs` |
| `d339a19f` | `fix(deploy): install Gotenberg compose when Docker already exists` |

PR #20 merged 2026-09-27 23:21 UTC (rebase rewrote PR SHAs `a52a7cf` / `72f34ce`). This ops session did **not** commit or push.

Files: `apps/server-pilot/deploy/gotenberg.compose.yaml`, `install-gotenberg.sh`, `ops-gotenberg.sh`, `write-ec2-env.sh` (`GOTENBERG_URL` default), `tests/deploy-config.test.ts`.

## Greptile (already ran before merge)

Do not re-review unless asked. CLI history on `feat/gotenberg-sidecar` vs `origin/main`:

| When (UTC) | Head | Result |
|------------|------|--------|
| 2026-09-27 15:19 | `172e0165` | 3 comments, confidence 2 |
| 2026-09-27 15:25 | `0a855a3c` | 1 comment after P1 fixes, confidence 2 |

P1s fixed in-tree: Compose install if `docker compose` missing; SSM fail if remote `install-gotenberg.sh` absent. Rejected: putting `GOTENBERG_URL` on remote-admin env (Outlook uses legacy `http`).

`greptile review status` on today’s `7e7080b3` / `d339a19f` is empty because rebase changed SHAs. Same tree, already reviewed.

## Ops executed 2026-09-28 (U1–U4)

Sequence: `ops-deploy.sh` (no `--migrate`) → `ops-gotenberg.sh` → `ops-restart.sh` → fixture convert.

| Unit | Evidence |
|------|----------|
| U1 | Local `main` = `origin/main` at `bb256219`. AWS STS account `845242190536`. |
| U2 | Bundle sync + on-box build. Installer present on EC2. `http` `:8788` / `:8789` `{ok:true,service:server-pilot}`. Wrapper still exited 1 on `launch-readiness` (see leftovers). |
| U3 | First-time `docker.io` + `docker-compose-v2`. Image `gotenberg/gotenberg:8.36.0-libreoffice`. `gotenberg install ok http://127.0.0.1:3000`. |
| U4 | `.env.production` has `GOTENBERG_URL='http://127.0.0.1:3000'`. PM2 `http` has that env. `/health` LibreOffice `up`. Listener `127.0.0.1:3000` only. Fixture POST `/forms/libreoffice/convert` → PDF 1.7. Generator still up after PM2 bounce. `docker.service` enabled+active. |

Convert used on-box `apps/server-pilot/fixtures/centurion-quotation-template.xlsx` only. No mail PII in SSM.

## Divergence

- `ops-deploy.sh` / `launch-readiness`: `NOT_READY` on `pm2AiWorkerOnline` and `outboundBacklogEmpty`. Pre-existing. Not a converter blocker. `http` was healthy.
- `ai-worker` errored: Postgres `column "read_request" does not exist`. Needs migrate. This run forbade `--migrate`.
- `ops-restart.sh` SSM health curl raced (`8788` not listening at 0s). Processes came up on retry. Script still exit 70. Converter proof taken after.
- `remote-http` has no `GOTENBERG_URL`. Expected.

## Not done (U5) — human Outlook

Linux cannot click VSTO. Next operator:

1. Outlook desktop, add-in protocol v3 (`ADD_ATTACHMENT_TO_DRAFT`).
2. Nava pane login email equals Outlook mailbox.
3. Hard-refresh pane. Non-restricted rate. ≥1 room.
4. Click **Draft Quotation into Email Reply**.
5. Pass: reply draft body has “Please see attached quotation”; attachment `Quote - <agency> <dates>.pdf`; PDF opens. Do not send unless wanted.

Fail map: `GOTENBERG_URL missing` → env not on `http`. Convert 502 → generator down. Identity toast → mailbox mismatch. Protocol v3 toast → old add-in.

## Next (optional, not this run)

- Human U5 Insert Draft.
- Separate: `ops-deploy.sh --migrate` if `ai-worker` must come back (`read_request`).
- Separate: retry/backoff in `ops-restart.sh` health curl (race).
- Do not rewrite full `.env.production` via `write-ec2-env.sh` unless every mail env is exported. Installer only appends the URL if missing.

## Rollback

SSM as root-capable: `docker compose -f /opt/nava/gotenberg/gotenberg.compose.yaml down`. Leaving `GOTENBERG_URL` in env after down makes Insert Draft fail until restart + URL rewrite.
