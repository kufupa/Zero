/**
 * tRPC package entry. Re-exports the root router + type so `apps/mail` can
 * `import type { AppRouter } from '@zero/server/trpc'` and the Hono adapter
 * can `import { appRouter } from '@zero/server/trpc'`.
 *
 * The real router lives in `./router.ts`; this file keeps the package export
 * surface stable.
 */
export { appRouter, type AppRouter } from './router.js';
export { router, publicProcedure, privateProcedure, mailboxProcedure } from './trpc.js';
export type {
  TrpcSourceContext,
  TrpcPrivateContext,
  TrpcMailboxContext,
} from './trpc.js';
export {
  resolveMailboxContext,
  MailboxForbiddenError,
  type MailboxContext,
  type DB,
} from './context.js';
export type { Inputs, Outputs } from './types.js';
