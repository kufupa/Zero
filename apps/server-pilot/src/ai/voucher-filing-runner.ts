import { createHash } from 'node:crypto';
import type { DB } from '../db/client.js';
import { isPropertyReadConnectionHeld, propertyReadLockKey, type PropertyReadConnection } from '../hms/property-read-lock.js';
import { assertHmsUnchangedBeforeSave, consumeHmsWriteApproval, endHmsWriteRun } from './hms-approval.js';
import { FilingRunnerInputSchema, type FilingRunner, type NavaToolResult } from './nava-tool-result.js';
import type { AiRunFence } from './run-ledger.js';

type ApprovedForm = Record<string, unknown>;
type SourceRead = { status: 'ready'; bytes: Buffer } | { status: 'refused'; reason?: string };
type NativeOutcome = { outcome?: string; issue?: string; marker?: string;
  possiblyDispatched?: boolean; dispatched?: boolean; saveDispatched?: boolean | 'unknown' };
type FileData = { documentCode: string; documentId?: string };
type FilingContext = { _options?: { serviceWorkers?: string }; serviceWorkers(): unknown[];
  pages(): unknown[]; routeWebSocket?: (url: string, handler: (socket: { close(): Promise<void> | void }) => void) => Promise<void> | void };
type Page = { context(): FilingContext };

const preparedContexts = new WeakSet<object>();
const setupAttemptedContexts = new WeakSet<object>();

/** The caller must supply a newly created dedicated context before exposing it or creating any page. */
export async function prepareFilingContext(context: FilingContext): Promise<void> {
  if (!context || setupAttemptedContexts.has(context) || context._options?.serviceWorkers !== 'block' ||
      typeof context.serviceWorkers !== 'function' ||
      context.serviceWorkers().length !== 0 || typeof context.pages !== 'function' || context.pages().length !== 0 ||
      typeof context.routeWebSocket !== 'function') throw new Error('FILING_CONTEXT_UNSAFE');
  setupAttemptedContexts.add(context);
  await context.routeWebSocket('**/*', (socket) => { void Promise.resolve(socket.close()).catch(() => {}); });
  if (context.serviceWorkers().length !== 0 || context.pages().length !== 0) throw new Error('FILING_CONTEXT_UNSAFE');
  preparedContexts.add(context);
}

export type FilingRunnerDependencies = {
  /** All dependencies are supplied by trusted server composition, never by the pane. */
  db: DB;
  fence: AiRunFence;
  serverGrantId: string;
  /** The trusted property lock must be held around this entire run. */
  propertyLock: { connection: PropertyReadConnection; tenantId: string; propertyCode: string };
  /** Dedicated context must be prepared before its first page and no later socket route may override the fence. */
  page: Page;
  readApprovedSource(form: ApprovedForm): Promise<SourceRead>;
  /** Must return the exact same canonical snapshot shape used at Prepare. */
  readApprovedSnapshot(form: ApprovedForm): Promise<unknown>;
  /** Fresh independent HMS read, never on the paused upload page; no cached snapshot. */
  readIndependentSnapshot(form: ApprovedForm): Promise<unknown>;
  /** Rejects mismatched source/stay, stale evidence and incomplete or unrefreshed Documents coverage. */
  isEligibleSnapshot(snapshot: unknown, form: ApprovedForm): boolean;
  /** The implementation must append the preimage durably under this same fenced run. */
  persistPreimage(input: { fence: AiRunFence; grantId: string; preimage: unknown }): Promise<boolean>;
  /** The native adapter must check the supplied deadline immediately before dispatch. */
  fileLabtestVoucher(input: { page: Page; form: ApprovedForm; bytes: Buffer;
    checkAuthority: () => Promise<boolean>; deadlineAt: Date;
    persistPreimage: (preimage: unknown) => Promise<boolean> }): Promise<NativeOutcome>;
  consume?: typeof consumeHmsWriteApproval;
  /** Must check the fenced approval and HMS digest without ending a consumed run as NEEDS_CHECK. */
  checkBeforeSave: typeof assertHmsUnchangedBeforeSave;
  endRun?: typeof endHmsWriteRun;
};

function sourceHash(form: ApprovedForm): string | null {
  const payload = form.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const source = (payload as Record<string, unknown>).source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const hash = (source as Record<string, unknown>).sha256;
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function safePage(page: Page): boolean {
  try {
    const context = page.context();
    const pages = context.pages();
    return preparedContexts.has(context) && context._options?.serviceWorkers === 'block' &&
      context.serviceWorkers().length === 0 && pages.length === 1 && pages[0] === page &&
      typeof context.routeWebSocket === 'function';
  } catch { return false; }
}

function result(outcome: NavaToolResult<FileData>['outcome'], reason: string, marker?: string): NavaToolResult<FileData> {
  return { schema: 'nava.tool/v1', outcome, reason,
    ...(/^NAVA[A-F0-9]{32}$/.test(marker ?? '') ? { data: { documentCode: marker! } } : {}) };
}

/** A single server-owned claimed run. The grant reference in input cannot supply authority. */
export function createFilingRunner(deps: FilingRunnerDependencies): FilingRunner {
  const { db, serverGrantId, page, propertyLock } = deps;
  const fence = structuredClone(deps.fence);
  const consume = deps.consume ?? consumeHmsWriteApproval;
  // The shared helper can end a consumed run as nonblocking NEEDS_CHECK; do not default to it.
  const checkBeforeSave = deps.checkBeforeSave;
  const endRun = deps.endRun ?? endHmsWriteRun;
  let invoked = false;
  const withinDeadline = () => fence?.deadlineAt instanceof Date &&
    Number.isFinite(fence.deadlineAt.getTime()) && Date.now() < fence.deadlineAt.getTime();
  const lockHeld = () => Boolean(propertyLock?.tenantId && propertyLock.propertyCode &&
    isPropertyReadConnectionHeld(propertyLock.connection, propertyReadLockKey(propertyLock.tenantId, propertyLock.propertyCode)));
  const finish = async (reason: string, marker?: string) => {
    try {
      const ended = await endRun({ db, fence, failureClass: 'UNKNOWN', reason });
      if (!ended) return result('uncertain', 'filing_needs_check', marker);
    } catch { return result('uncertain', 'filing_needs_check', marker); }
    return result('uncertain', reason, marker);
  };
  return {
    async run(input) {
      if (invoked) return result('uncertain', 'filing_run_already_invoked');
      invoked = true;
      if (!fence?.runId || !fence.claimOwner || !fence.claimToken) return result('uncertain', 'filing_authority_unavailable');
      // Another invocation with this fence may already have consumed the grant. UNKNOWN blocks
      // reapproval if consumed, while the approval layer permits it if no consume exists.
      const parsed = FilingRunnerInputSchema.safeParse(input);
      if (!parsed.success) return finish('filing_input_invalid');
      if (!serverGrantId || parsed.data.grantRef !== serverGrantId || (typeof checkBeforeSave !== 'function' || checkBeforeSave === assertHmsUnchangedBeforeSave) ||
          !withinDeadline() || !safePage(page) || !lockHeld()) {
        return finish('filing_authority_unavailable');
      }
      let form: ApprovedForm;
      try {
        const consumed = await consume({ db, runId: fence.runId, fence });
        if (consumed.grantId !== serverGrantId) return finish('filing_grant_mismatch');
        form = structuredClone(consumed.form);
      } catch { return finish('filing_grant_unavailable'); }
      if (!withinDeadline()) return finish('filing_deadline_expired');
      if (form.propertyCode !== propertyLock.propertyCode) return finish('filing_property_mismatch');
      const expectedHash = sourceHash(form);
      if (!expectedHash) return finish('filing_source_unavailable');
      const readBytes = async (): Promise<Buffer | null> => {
        try {
          const source = await deps.readApprovedSource(structuredClone(form));
          if (source.status !== 'ready' || !Buffer.isBuffer(source.bytes) || source.bytes.length < 5 ||
              source.bytes.length > 10 * 1024 * 1024 || source.bytes.subarray(0, 5).toString() !== '%PDF-' ||
              createHash('sha256').update(source.bytes).digest('hex') !== expectedHash) return null;
          return Buffer.from(source.bytes);
        } catch { return null; }
      };
      const bytes = await readBytes();
      if (!bytes) return finish('filing_source_unavailable');
      if (!withinDeadline()) return finish('filing_deadline_expired');
      let preSubmitValidated = false;
      try {
        const checked = await checkBeforeSave({ db, runId: fence.runId, fence,
          readHmsState: async () => {
            const snapshot = await deps.readApprovedSnapshot(structuredClone(form));
            if (!deps.isEligibleSnapshot(snapshot, structuredClone(form))) throw new Error('FILING_SNAPSHOT_INCOMPLETE');
            preSubmitValidated = true;
            return snapshot;
          } });
        if (checked.status !== 'unchanged' || !preSubmitValidated || !withinDeadline() || !lockHeld() || !safePage(page)) {
          return finish('filing_needs_check');
        }
      } catch { return finish('filing_needs_check'); }
      // The upload route can be paused when this runs. Do not touch the HMS page here.
      // Native dispatch remains held until a fresh, complete baseline is independently proven.
      const checkAuthority = async (): Promise<boolean> => {
        if (!withinDeadline() || !safePage(page) || !lockHeld() || !(await readBytes()) || !withinDeadline()) return false;
        try {
          const checked = await checkBeforeSave({ db, runId: fence.runId, fence,
            readHmsState: async () => {
              const snapshot = await deps.readIndependentSnapshot(structuredClone(form));
              if (!deps.isEligibleSnapshot(snapshot, structuredClone(form))) throw new Error('FILING_SNAPSHOT_INCOMPLETE');
              return snapshot;
            } });
          return checked.status === 'unchanged' && withinDeadline() && lockHeld() && safePage(page);
        } catch { return false; }
      };
      // Once the native adapter is invoked, any exception or non-definitive result might follow dispatch.
      try {
        const native = await deps.fileLabtestVoucher({ page, form: structuredClone(form), bytes: Buffer.from(bytes),
          checkAuthority, deadlineAt: new Date(fence.deadlineAt.getTime()),
          persistPreimage: async (preimage) => (await checkAuthority()) &&
            (await deps.persistPreimage({ fence, grantId: serverGrantId, preimage })) && (await checkAuthority()) });
        const possible = native.possiblyDispatched === true || native.dispatched === true ||
          native.saveDispatched === true || native.saveDispatched === 'unknown';
        if (!possible && ['not_dispatched', 'refused', 'input_gap'].includes(native.outcome ?? '')) {
          return finish('filing_needs_check');
        }
        return finish('filing_needs_check', native.marker);
      } catch { return finish('filing_needs_check'); }
    },
  };
}
