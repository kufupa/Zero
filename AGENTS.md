# AGENTS.md

## Cursor Cloud specific instructions

### Overview
Zero is an open-source AI email client (pnpm monorepo with Turborepo). Two main apps: `apps/mail` (React Router + Vite frontend, port 3000) and `apps/server` (Hono + tRPC on Cloudflare Workers, port 8787).

### Prerequisites
- **Node.js v22** (see `.nvmrc`)
- **pnpm v10.15.0** (declared in root `package.json` `packageManager` field)
- **Docker** (required for PostgreSQL, Valkey/Redis, and Upstash proxy containers)

### Key commands
| Task | Command |
|---|---|
| Install deps | `pnpm install` (also runs `postinstall` → `pnpm nizzy sync` which copies `.env` and generates types) |
| Start DB containers | `pnpm docker:db:up` |
| Push DB schema | `pnpm db:push` |
| Run dev servers | `pnpm dev` (starts both frontend and backend via turbo) |
| All-in-one start | `pnpm go` (DB containers + dev servers) |
| Lint | `pnpm dlx oxlint@1.9.0 --deny-warnings` (also the pre-commit hook in `.husky/pre-commit`) |
| Tests | `pnpm test` (routes to `@zero/testing`; mainly E2E via Playwright) |
| DB studio | `pnpm db:studio` |

### Non-obvious gotchas
- The `bitnami/valkey:8.0` Docker image referenced in `docker-compose.db.yaml` has been removed from Docker Hub. Use `docker pull valkey/valkey:8.0 && docker tag valkey/valkey:8.0 docker.io/bitnami/valkey:8.0` to alias the official image before running `pnpm docker:db:up`.
- Docker in Cloud Agent VMs requires `fuse-overlayfs` storage driver and `iptables-legacy`. After installing Docker, configure `/etc/docker/daemon.json` with `{"storage-driver": "fuse-overlayfs"}` and run `update-alternatives --set iptables /usr/sbin/iptables-legacy`.
- After `dockerd` starts, you may need `chmod 666 /var/run/docker.sock` for the non-root user to access Docker.
- The `.env` file must exist at the project root; copy from `.env.example` and set `BETTER_AUTH_SECRET` (use `openssl rand -hex 32`). The `postinstall` script (`pnpm nizzy sync`) copies `.env` to `apps/mail/.dev.vars`, `apps/mail/.env`, and `apps/server/.dev.vars`.
- **DATABASE_URL override**: If a `DATABASE_URL` env var is injected by the platform (e.g. via Cursor Cloud secrets), it overrides the `.env` value. For `db:push` and other Drizzle commands that use `dotenv-cli`, you must explicitly set the local URL: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/zerodotemail" pnpm db:push`. The wrangler dev server uses `.dev.vars` which is correctly synced by `pnpm nizzy sync`, and the Hyperdrive `localConnectionString` in `wrangler.jsonc` also points to localhost, so the running app is unaffected.
- **Twilio dummy values required**: The `createAuth()` function (called on every request) eagerly instantiates a Twilio client which throws if `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, or `TWILIO_PHONE_NUMBER` are empty. Set dummy values in `.env` (e.g. `TWILIO_ACCOUNT_SID=AC_dummy`, `TWILIO_AUTH_TOKEN=dummy`, `TWILIO_PHONE_NUMBER=+10000000000`) and re-run `pnpm nizzy sync` to avoid 500 errors on all API routes.
- Google OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) are required for the login flow to work. Without them, the `/login` page shows an error. The landing page at `/` still loads fine.
- The backend dev server uses `wrangler dev --env local` with Cloudflare Workers emulation. Warnings about Workers AI and Vectorize remote bindings are expected and harmless for local dev.
- The turbo TUI (`turbo run dev`) shows an interactive terminal; both `@zero/mail#dev` and `@zero/server#dev` run concurrently.
- The pre-commit hook (`.husky/pre-commit`) runs `pnpm dlx oxlint@1.9.0 --deny-warnings`. The existing codebase has 22 pre-existing warnings in `apps/server/src/`, so commits may require `--no-verify` until those are resolved upstream.
