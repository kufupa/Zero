# Nava agent deployment

Build alongside the pilot. Do not deploy or start staging until the integrated app, runtime, native tools and DB have been proved together. No pilot process, checkout, port, DB or volume is replaced by these scripts.

## Build

From a clean, committed checkout with Node 22 and npm:

```sh
bash apps/nava-agent/deploy/bundle.sh /tmp/nava-agent-<sha>.tar.gz
```

The bundle contains the committed app, its production dependencies, deterministic HMS Cloud tools, their native dependencies, and required trace/request helpers. It records `COMMIT_SHA` and prints the archive SHA-256. Build on the same Linux architecture as the destination; npm selects platform-specific dependencies at build time. Browser binaries and secrets are not included. The separate legacy `tooling/playwright-quote` tree is included only if present at the committed revision. Copy the archive and verify its SHA-256 before extracting into a **new** private directory on each box. Never extract over a live checkout. Rebuild and verify on the integrated commit; unit-branch proof is not integrated proof.

For developer use, `npm ci --prefix apps/nava-agent` and `bash apps/nava-agent/run.sh migrate|start|worker|import-train` run from the repo root. Do not use pilot DB for local work or tests. Approved remote typecheck: `bash /home/orca/bin/remote-typecheck.sh <worktree> --app nava-agent` (state archive, not necessarily committed SHA); coordinate the run with other heavy checks.

## Staging prerequisites

- Existing prod EC2 `i-008f737974a9ba9b3` and London EC2 `i-0a804a8b80e252bf9`: Node 22, private release/work dirs, matching Playwright 1.63 Chromium plus OS libraries, AWS access and native HMS credentials. No new paid infrastructure. Both workers use the same dedicated rewrite PostgreSQL 16+ DB; API listens on a separate loopback port, e.g. `NAVA_HOST=127.0.0.1`, `NAVA_PORT=3107` only after confirming it is free. Private host proxy/access must be configured separately.
- Rewrite DB must be separate from pilot RDS. **cma-server must always have its own PostgreSQL 16+ instance and storage volume**, separate from both pilot and rewrite app DB. cma archive entitlement, sandbox host, server bootstrap and API/environment keys are outstanding. Do not subscribe to Claude Platform on AWS.
- Native HMS uses PostgreSQL advisory locks in `DATABASE_URL`. Separate rewrite and pilot databases do not share those locks. Do not run against an HMS login used by pilot or another uncoordinated deployment: use a verified distinct login or implement/prove common admission first. Property-bound native credentials are registry-pinned; a different secret override may be rejected, so a distinct login needs verified native support. Never bypass the smaller native read cap (currently 8) or exclusive Save lease. Configured worker count is not proven throughput.
- Interim inference uses AWS Bedrock `eu-west-1`; operator-provided AWS credentials and config must be readable by the service account. Existing native secret client also takes `AWS_REGION` (default `af-south-1`): confirm the integrated native secret-region wiring before any HMS call. Do not assume one `AWS_REGION` reaches both services correctly.

## Server-only environment

Provision a separate, service-account-owned `0600` dotenv file outside the release directory on each box. Do not put credentials in the bundle, shell history, client, logs or Git. Set `NAVA_ENV_FILE` to its absolute path; launcher loads it with Node, checks owner/mode and starts with a clean inherited environment. Dotenv values are literal; do not use shell substitutions. Set paths separately on each host.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated rewrite DB connection; same DB for both rewrite boxes. |
| `NAVA_API_TOKEN` | Server-only service token; never in browser. |
| `NAVA_STAFF_JWT_SECRET` | Server-only host/backend signing secret; staff bridge must be integrated and verified before real-guest Go. |
| `NAVA_HOST`, `NAVA_PORT` | Isolated API bind address and free port. |
| `NAVA_HMS_SLOTS`, `HMS_CREDENTIAL_SESSION_CAP` | Worker concurrency and native admission cap; never exceed actual cap. |
| `NAVA_SKILLS_DIR`, `NAVA_WORK_DIR` | Absolute paths to integrated skills and private writable work directory. |
| `AWS_REGION`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` | Bedrock region `eu-west-1` and local AWS default credential-chain paths; resolve native region issue above first. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_ENVIRONMENT_KEY` | Future cma-server local endpoint and bootstrap keys only; never an Anthropic hosted API key. Omit for interim Bedrock. |

`NAVA_ENV_FILE` itself is passed to the launcher, not stored in the dotenv file. On integrated proof only, after separately provisioning the isolated DB, deploy release directories and env files, run migration once and start API/worker as separate processes under a dedicated supervisor identity. Example from the extracted release root:

```sh
export NAVA_ENV_FILE=/absolute/private/nava-agent.env
bash apps/nava-agent/run.sh migrate
bash apps/nava-agent/run.sh start   # API box, own supervisor process
bash apps/nava-agent/run.sh worker  # each worker box, own supervisor process
```

Do not run migration twice concurrently. No commands here provision infrastructure, modify pilot, or authorize an HMS Save. Integrated proof must cover isolated DB, API, both workers, real tool trace, exact installed native dependencies and the selected runtime before deployment. Archive-gated cma proof remains separate.
