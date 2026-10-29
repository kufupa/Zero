# Agent Configuration for Zero Email

On-demand repository map and development commands. The Nava pilot has separate production, test and database safeguards in `PRODUCT.md` and `AGENTS.md`; these examples do not authorize a deployment or database write.

## Project Structure

This is a pnpm workspace monorepo with the following structure:
- `apps/mail/` - Next.js frontend email client
- `apps/server/` - Upstream backend server
- `apps/server-pilot/` - Nava pilot backend and HMS tooling
- `packages/cli/` - CLI tools (`nizzy` command)
- `packages/eslint-config/` - Shared ESLint configuration
- `packages/tsconfig/` - Shared TypeScript configuration
- `docs/solutions/` - Documented fixes and workflow gotchas (YAML frontmatter: `module`, `tags`, `problem_type`); search before debugging in documented areas
- `CONCEPTS.md` - Shared domain vocabulary for mail-pilot terms

## Frequently Used Commands

### Development
- `pnpm go` - Quick start: starts database and dev servers
- `pnpm dev` - Start all development servers (uses Turbo)
- `pnpm docker:db:up` - Start PostgreSQL database in Docker
- `pnpm docker:db:down` - Stop and remove database container
- `pnpm docker:db:clean` - Stop and remove database with volumes; destructive, do not run without explicit authorization

### Build & Deploy
- `pnpm build` - Build all packages (uses Turbo)
- `pnpm build:frontend` - Build only the mail frontend
- Pilot production deploys use the path and approval rules in `PRODUCT.md`; generic deploy scripts are not pilot deployment instructions.

### Code Quality
- Use targeted linting and formatting on specific files only when necessary. Do not run repository-wide `pnpm check`, `pnpm lint`, `pnpm format`, or `pnpm check:format`; `pnpm format` writes files and `pnpm check:format` checks them.
- Follow `AGENTS.md` for approved test and type-check locations.

### Database
- `pnpm db:push` - Push schema changes to the configured database; never run automatically, and verify target and authorization first
- `pnpm db:generate` - Generate migration files
- `pnpm db:migrate` - Apply database migrations
- `pnpm db:studio` - Open Drizzle Studio

### Testing & Evaluation
- `pnpm test:ai` - Run AI tests
- `pnpm eval` - Run evaluation suite
- `pnpm eval:dev` - Run evaluation in dev mode
- `pnpm eval:ci` - Run evaluation in CI mode

### Utilities
- `pnpm nizzy env` - Setup environment variables
- `pnpm nizzy sync` - Sync environment variables and types
- `pnpm scripts` - Run custom scripts

## Tech Stack

- **Frontend**: Next.js, React 19, TypeScript, TailwindCSS, Shadcn UI
- **Backend**: Node.js, tRPC, Drizzle ORM
- **Database**: PostgreSQL
- **Authentication**: Better Auth, Google OAuth
- **Package Manager**: pnpm (v10+)
- **Build Tool**: Turbo
- **Linting**: ESLint, Oxlint, Prettier

## Code Style & Conventions

### Formatting
- 2-space indentation
- Single quotes
- 100 character line width
- Semicolons required
- Uses Prettier with sort-imports and Tailwind plugins

### File Organization
- TypeScript strict mode enabled
- Workspace packages use catalog versioning for shared dependencies
- Monorepo managed with pnpm workspaces

### Important Environment Variables
- `BETTER_AUTH_SECRET` - Auth secret key
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` - Gmail integration
- `TWILIO_*` - SMS integration
- `DATABASE_URL` - PostgreSQL connection string

## Development Setup

1. Install dependencies: `pnpm install`
2. Setup environment: `pnpm nizzy env`
3. Sync environment: `pnpm nizzy sync`
4. Start database: `pnpm docker:db:up`
5. Initialize a disposable development database only after verifying the target and authorization
6. Start development: `pnpm dev`

## Common Workflow

1. Use targeted lint and the approved tests in `AGENTS.md`; never run repository-wide lint or formatting
2. Use `pnpm nizzy sync` after environment variable changes
3. For schema changes, verify the target and explicit authorization before any database write
4. Use `pnpm go` for quick development startup

## Notes

- Uses Husky for git hooks
- Integrates with Sentry for error tracking
- Uses Cloudflare Workers for backend deployment
- CLI tool `nizzy` helps manage environment and sync operations
