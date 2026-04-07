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
- The `bitnami/valkey:8.0` Docker image referenced in `docker-compose.db.yaml` has been removed from Docker Hub. Use `docker tag valkey/valkey:8.0 docker.io/bitnami/valkey:8.0` to alias the official image before running `pnpm docker:db:up`.
- Docker in Cloud Agent VMs requires `fuse-overlayfs` storage driver and `iptables-legacy`. After installing Docker, configure `/etc/docker/daemon.json` with `{"storage-driver": "fuse-overlayfs"}` and run `update-alternatives --set iptables /usr/sbin/iptables-legacy`.
- After `dockerd` starts, you may need `chmod 666 /var/run/docker.sock` for the non-root user to access Docker.
- The `.env` file must exist at the project root; copy from `.env.example` and set `BETTER_AUTH_SECRET` (use `openssl rand -hex 32`). The `postinstall` script (`pnpm nizzy sync`) copies `.env` to `apps/mail/.dev.vars`, `apps/mail/.env`, and `apps/server/.dev.vars`.
- Google OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) are required for the login flow to work. Without them, the `/login` page shows an error. The landing page at `/` still loads fine.
- The backend dev server uses `wrangler dev --env local` with Cloudflare Workers emulation. Warnings about Workers AI and Vectorize remote bindings are expected and harmless for local dev.
- The turbo TUI (`turbo run dev`) shows an interactive terminal; both `@zero/mail#dev` and `@zero/server#dev` run concurrently.
