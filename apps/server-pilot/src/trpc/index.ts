import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

/**
 * Pilot tRPC root. Minimal stub router so `AppRouter` type resolves and
 * `apps/mail` typechecks. Task 7 will expand this into the full mail router
 * surface (mail, settings, user, categories, connections, drafts, labels,
 * notes, brain, ai, bimi, shortcut, templates, meet, logging, cookiePreferences).
 */

const t = initTRPC.create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Stub router: empty for pilot. Mail frontend currently uses a Proxy-based
 * demo client for any procedure path, so an empty AppRouter type is sufficient
 * for `apps/mail` typecheck. Real procedures land in Task 7.
 */
export const appRouter = t.router({
  // TODO(task-7): add mail, settings, user, categories, connections, drafts,
  // labels, notes, brain, ai, bimi, shortcut, templates, meet, logging,
  // cookiePreferences sub-routers.
});

export type AppRouter = typeof appRouter;
export type Inputs = Record<string, never>;
export type Outputs = Record<string, never>;
