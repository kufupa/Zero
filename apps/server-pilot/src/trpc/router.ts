/**
 * tRPC root router — assembles all sub-routers into the `appRouter` exported
 * from `./index.ts`. Frontend (`apps/mail`) imports `AppRouter` from
 * `@zero/server/trpc` for type-safe `trpc.<sub>.<proc>` calls.
 */
import { router } from './trpc.js';
import { mailRouter } from './routes/mail.js';
import { draftsRouter } from './routes/drafts.js';
import { labelsRouter } from './routes/labels.js';
import { settingsRouter } from './routes/settings.js';
import { connectionsRouter } from './routes/connections.js';
import { userRouter } from './routes/user.js';
import { aiRouter } from './routes/ai.js';
import { brainRouter } from './routes/brain.js';
import { notesRouter } from './routes/notes.js';
import { templatesRouter } from './routes/templates.js';
import { bimiRouter } from './routes/bimi.js';
import { categoriesRouter } from './routes/categories.js';
import { adminDashboardRouter } from './routes/admin-dashboard.js';
import { catchupRouter } from './routes/catchup.js';
import { workstationRouter } from './routes/workstation.js';
import { quoteWorkflowRouter } from './routes/quote-workflow.js';
import { paneStayCancelRouter } from './routes/pane-stay-cancel.js';
import { paneStayLookupRouter } from './routes/pane-stay-lookup.js';
import { panePartyLookupRouter } from './routes/pane-party-lookup.js';
import { workItemsRouter } from './routes/work-items.js';
import { ratesRouter } from './routes/rates.js';
import { hmsApprovalRouter } from './routes/hms-approval.js';

export const appRouter = router({
  mail: mailRouter,
  drafts: draftsRouter,
  labels: labelsRouter,
  settings: settingsRouter,
  connections: connectionsRouter,
  user: userRouter,
  ai: aiRouter,
  brain: brainRouter,
  notes: notesRouter,
  templates: templatesRouter,
  bimi: bimiRouter,
  categories: categoriesRouter,
  adminDashboard: adminDashboardRouter,
  catchup: catchupRouter,
  workstation: workstationRouter,
  quoteWorkflow: quoteWorkflowRouter,
  paneStayCancel: paneStayCancelRouter,
  paneStayLookup: paneStayLookupRouter,
  panePartyLookup: panePartyLookupRouter,
  workItems: workItemsRouter,
  rates: ratesRouter,
  hmsApproval: hmsApprovalRouter,
});

export type AppRouter = typeof appRouter;
