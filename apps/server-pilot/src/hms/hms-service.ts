import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { message } from '../db/schema/mail.js';
import { getDb, type DB } from '../db/client.js';
import { approveHmsWrite, prepareHmsWrite, publicHmsPreparedSummary } from '../ai/hms-approval.js';
import type { AiRunFence } from '../ai/run-ledger.js';
import { propertyConfigurationForScope } from './rate-catalogue.js';
import { resolvePropertyScope, propertySwitchSchema, type PropertySwitch, type ResolvedPropertyScope } from './property-registry.js';
import { readResultSchema, readFolioDataSchema } from './read-service-contracts.js';
import { quoteStayReadDataSchema } from './quote-stay-contract.js';
import type { ReadRequest } from './read-service.js';
import { reservationFindResultSchema, reservationContextReadResultSchema } from './reservation-context-contract.js';
import { staffSessionSchema, loadHmsPreparation, type StaffSession } from './hms-preparation.js';
import { verifyStaffGoForRun, type VerifiedStaffGo } from './staff-go-authority.js';
import { hmsPropertyReadEnabled } from './mailbox-hms-origin-bind.js';

async function executeVerifiedRun(db: DB, go: VerifiedStaffGo, request: { runId: string; fence: AiRunFence; signal?: AbortSignal }) {
  if (go.preparation.workflowContext) {
    const { executePreparedReservationV2Run } = await import('../ai/reservation-workflow-v2-tools.js');
    return executePreparedReservationV2Run({ db, go, fence: request.fence, signal: request.signal });
  }
  if (go.grant.operation === 'create') {
    const { executePreparedPaneCreateRun } = await import('../ai/pane-cloud-preview.js');
    return executePreparedPaneCreateRun({ db, go, fence: request.fence, signal: request.signal });
  }
  if (go.grant.operation === 'amend') {
    const { runCloudPaneAmendOnce } = await import('../ai/pane-cloud-amend-runner.js');
    return runCloudPaneAmendOnce({ ...request, db, go });
  }
  if (go.grant.operation === 'cancel' || go.grant.operation === 'attach_document') {
    const { runPaneHmsWriteOnce } = await import('../ai/pane-hms-write.js');
    return runPaneHmsWriteOnce({ runId: request.runId, fence: request.fence, db, signal: request.signal, go });
  }
  throw new Error('hms_write_adapter_unavailable');
}

/** The worker has no caller-supplied property or staff claims. Its durable receipt resolves them. */
export async function executeHmsWorkerRun(input: { db: DB; fence: AiRunFence; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const go = await input.db.transaction((tx) => verifyStaffGoForRun(tx, input.fence));
  return executeVerifiedRun(input.db, go, { runId: input.fence.runId, fence: input.fence, signal: input.signal });
}

export type HmsReadQuery = ReadRequest;
export type ReadResult<Q extends HmsReadQuery> =
  Q extends { toolId: 'hms_find_reservation' } ? z.infer<typeof reservationFindResultSchema> :
  Q extends { toolId: 'hms_read_reservation' } ? z.infer<typeof reservationContextReadResultSchema> :
  Omit<z.infer<typeof readResultSchema>, 'toolId' | 'data'> & { toolId: Q['toolId']; data:
    Q extends { toolId: 'hms_quote_stay' } ? z.infer<typeof quoteStayReadDataSchema> | null :
    Q extends { toolId: 'hms_read_folio' } ? z.infer<typeof readFolioDataSchema> | null : unknown };

/** Native read adapters are supplied by the existing proof-authorized runtime, never RPC payloads. */
export interface HmsReadAdapter {
  read<Q extends HmsReadQuery>(scope: ResolvedPropertyScope, query: Q, signal?: AbortSignal): Promise<ReadResult<Q>>;
}

export async function nativeReadCapabilityAvailable(input: {
  propertyCode: string; transportId?: string; capability?: 'reads' | 'quote';
}): Promise<boolean> {
  if (input.propertyCode === 'HRCEN') return true;
  if (!input.transportId) return false;
  try {
    const configuration = await createHmsService({ transportId: input.transportId,
      propertySwitch: propertySwitchSchema.parse(input.propertyCode) }).configuration();
    return configuration.propertyCode === input.propertyCode &&
      configuration.capabilities[input.capability ?? 'reads'].status !== 'unavailable';
  } catch { return false; }
}

/** Application entry point. The authenticated mailbox owns the scope throughout the operation. */
export function createHmsService(input: {
  transportId: string; propertySwitch?: PropertySwitch; db?: DB; readAdapter?: HmsReadAdapter;
}) {
  const scope = resolvePropertyScope(input);
  const database = () => input.db ?? getDb();
  return {
    propertyCode: scope.propertyCode,
    configuration: async () => propertyConfigurationForScope(scope, process.env),
    read<Q extends HmsReadQuery>(query: Q, signal?: AbortSignal): Promise<ReadResult<Q>> {
      if (!input.readAdapter || !hmsPropertyReadEnabled({ propertyCode: scope.propertyCode, toolId: query.toolId })) {
        throw new Error('hms_read_capability_unavailable');
      }
      return input.readAdapter.read(scope, query, signal);
    },
    async prepare(request: Omit<Parameters<typeof prepareHmsWrite>[0], 'db' | 'transportId' | 'propertySwitch'>) {
      const prepared = await prepareHmsWrite({ ...request, db: database(), transportId: scope.transportId,
        propertySwitch: input.propertySwitch });
      return publicHmsPreparedSummary(prepared);
    },
    async approveAndEnqueue(request: {
      preparedRef: string; workItemId: string; expectedRevision: number; session: StaffSession;
      source: { threadId: string; messageId: string; sourceHash: string };
      formDigest: string;
    }) {
      const session = staffSessionSchema.parse(request.session);
      const db = database();
      const prepared = await db.transaction((tx) => loadHmsPreparation(tx, request.preparedRef, request.workItemId));
      const [mail] = await db.select({ header: message.messageIdHeader }).from(message).where(and(
        eq(message.id, prepared.source.sourceMessageId), eq(message.transportId, scope.transportId))).limit(1);
      return approveHmsWrite({ db, transportId: scope.transportId, propertySwitch: input.propertySwitch,
        preparedRef: request.preparedRef, workItemId: request.workItemId, expectedRevision: request.expectedRevision,
        ...session, selectedSource: request.source, selectedInternetMessageId: mail?.header ?? undefined,
        ...(!prepared.workflowContext && prepared.operation === 'cancel' ? { cloudCancelSelection: request.source } : {}),
        ...(!prepared.workflowContext && prepared.operation === 'amend' ? { cloudSelection: request.source } : {}),
        formDigest: request.formDigest });
    },
    async executeApprovedRun(request: { runId: string; fence: AiRunFence; signal?: AbortSignal }) {
      if (request.runId !== request.fence.runId || request.signal?.aborted) throw new Error('hms_write_run_refused');
      const db = database();
      const go = await db.transaction((tx) => verifyStaffGoForRun(tx, request.fence));
      if (go.grant.transportId !== scope.transportId || go.grant.propertyCode !== scope.propertyCode ||
          go.grant.tenantId !== scope.tenantId) {
        throw new Error('hms_write_capability_unavailable');
      }
      return executeVerifiedRun(db, go, request);
    },
  };
}
