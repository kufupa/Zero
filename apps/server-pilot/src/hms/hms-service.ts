import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { message } from '../db/schema/mail.js';
import { getDb, type DB } from '../db/client.js';
import { approveHmsWrite, prepareHmsWrite, publicHmsPreparedSummary } from '../ai/hms-approval.js';
import type { AiRunFence } from '../ai/run-ledger.js';
import { propertyConfigurationForScope } from './rate-catalogue.js';
import { resolvePropertyScope, type PropertySwitch, type ResolvedPropertyScope } from './property-registry.js';
import { readResultSchema, readFolioDataSchema } from './read-service-contracts.js';
import { quoteStayReadDataSchema } from './quote-stay-contract.js';
import type { ReadRequest } from './read-service.js';
import { reservationFindResultSchema, reservationContextReadResultSchema } from './reservation-context-contract.js';
import { staffSessionSchema, loadHmsPreparation, type StaffSession } from './hms-preparation.js';
import { verifyStaffGoForRun } from './staff-go-authority.js';
import { hmsPropertyReadEnabled } from './mailbox-hms-origin-bind.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWorkerActiveReadSet } from './active-read-runtime.js';
import { loadHmsReadRoleProofV2ForTool } from './release-kernel.js';
import { runtimeFingerprintSha256 } from './evidence-runtime.js';
import { READ_TOOLS } from './read-tools.js';

async function validatedReadCapabilities(scope: ResolvedPropertyScope) {
  const unavailable = { reads: false, quote: false };
  const sourceRevision = process.env.NAVA_BUILD_COMMIT?.trim();
  const credentialDigest = process.env[`HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_${scope.propertyCode}`];
  const keyVersion = process.env.HMS_EVIDENCE_HMAC_KEY_VERSION?.trim();
  if (!sourceRevision || !keyVersion || !/^[a-f0-9]{64}$/.test(credentialDigest ?? '')) return unavailable;
  const root = process.env.HMS_READ_ROLE_PROOF_V2_ROOT?.trim() || '/etc/nava/hms-read-role-proofs/v2';
  const runtimeFingerprint = runtimeFingerprintSha256({ sourceRevision, playwrightRevision: '1.63.0', chromiumRevision: '1243' });
  try {
    const active = await loadWorkerActiveReadSet({ propertyCode: scope.propertyCode,
      registryPath: join(root, scope.propertyCode, 'active-registry.v2.json'),
      releaseRoot: join(root, scope.propertyCode, 'releases'), runtimeFingerprintSha256: runtimeFingerprint });
    const valid = async (toolId: 'hms_find_reservation' | 'hms_quote_stay') => {
      const release = active.releases.get(toolId);
      if (!release || release.evidenceKind !== 'hms' || release.sourceRevision !== sourceRevision ||
          release.privateDigestKeyVersion !== keyVersion || release.credentialVersionHmacSha256 !== credentialDigest) return false;
      const proof = await loadHmsReadRoleProofV2ForTool(root, READ_TOOLS[toolId], new Date(), scope.propertyCode);
      const bytes = await readFile(join(root, scope.propertyCode, `${toolId}.v2.json`));
      return createHash('sha256').update(bytes).digest('hex') === release.roleProofSha256 &&
        proof.observerSourceRevision === sourceRevision && proof.privateDigestKeyVersion === keyVersion &&
        proof.runtimeFingerprintSha256 === runtimeFingerprint && proof.credentialVersionHmacSha256 === credentialDigest;
    };
    const reads = await valid('hms_find_reservation');
    return { reads, quote: reads && await valid('hms_quote_stay') };
  } catch { return unavailable; }
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

/** Application entry point. The authenticated mailbox owns the scope throughout the operation. */
export function createHmsService(input: {
  transportId: string; propertySwitch?: PropertySwitch; db?: DB; readAdapter?: HmsReadAdapter;
}) {
  const scope = resolvePropertyScope(input);
  const database = () => input.db ?? getDb();
  return {
    propertyCode: scope.propertyCode,
    configuration: async () => propertyConfigurationForScope(scope, process.env,
      scope.group === 'davinci' ? await validatedReadCapabilities(scope) : undefined),
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
        ...(prepared.operation === 'cancel' ? { cloudCancelSelection: request.source } : {}),
        ...(prepared.operation === 'amend' ? { cloudSelection: request.source } : {}),
        formDigest: request.formDigest });
    },
    async executeApprovedRun(request: { runId: string; fence: AiRunFence; signal?: AbortSignal }) {
      if (request.runId !== request.fence.runId || request.signal?.aborted) throw new Error('hms_write_run_refused');
      const db = database();
      const go = await db.transaction((tx) => verifyStaffGoForRun(tx, request.fence));
      if (go.grant.transportId !== scope.transportId || go.grant.propertyCode !== scope.propertyCode ||
          go.grant.tenantId !== scope.tenantId || scope.propertyCode !== 'HRCEN') {
        throw new Error('hms_write_capability_unavailable');
      }
      if (go.grant.operation === 'amend') {
        const { runCloudPaneAmendOnce } = await import('../ai/pane-cloud-amend-runner.js');
        return runCloudPaneAmendOnce({ ...request, db });
      }
      if (go.grant.operation === 'cancel' || go.grant.operation === 'attach_document') {
        const { runPaneHmsWriteOnce } = await import('../ai/pane-hms-write.js');
        return runPaneHmsWriteOnce({ runId: request.runId, fence: request.fence, db });
      }
      throw new Error('hms_write_adapter_unavailable');
    },
  };
}
