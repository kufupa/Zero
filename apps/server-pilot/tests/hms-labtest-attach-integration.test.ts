import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';

const stubs = vi.hoisted(() => ({ consume: vi.fn(), unchanged: vi.fn(), authorize: vi.fn(),
  end: vi.fn(), evidence: vi.fn(), running: vi.fn(), heartbeat: vi.fn(), success: vi.fn(),
  readAttachment: vi.fn(), candidate: vi.fn(), cloudRun: vi.fn(), project: vi.fn() }));
vi.mock('../src/ai/hms-approval.js', async (original) => {
  const actual = await original<typeof import('../src/ai/hms-approval.js')>();
  return { ...actual, consumeHmsWriteApproval: stubs.consume, assertHmsUnchangedBeforeSave: stubs.unchanged,
    authorizeConsumedLabtestAttach: async (...args: Parameters<typeof actual.authorizeConsumedLabtestAttach>) => {
      await stubs.authorize(...args);
      return actual.authorizeConsumedLabtestAttach(...args);
    }, endHmsWriteRun: stubs.end, recordHmsWriteEvidence: stubs.evidence };
});
vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...(await original<typeof import('../src/ai/run-ledger.js')>()),
  markAiRunRunning: stubs.running, heartbeatAiRun: stubs.heartbeat, markAiRunSucceeded: stubs.success,
}));
vi.mock('../src/mail/artifacts/pane-pop3-attachment.js', async (original) => ({
  ...(await original<typeof import('../src/mail/artifacts/pane-pop3-attachment.js')>()),
  readPanePop3Attachment: stubs.readAttachment, panePop3AttachmentCandidate: stubs.candidate,
}));
vi.mock('../src/ai/hms-cloud-saved-stay-find.js', () => ({
  runCloudStayFind: stubs.cloudRun, projectCloudStayFind: stubs.project,
}));
vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', async (original) => ({
  ...(await original<typeof import('../tooling/playwright-quote/centurion-stay360.mjs')>()),
  centurionWriterCurrent: () => true,
}));

import { runLabtestAttachOnce } from '../src/ai/hms-labtest-attach-worker.js';
import { approveHmsWrite, formDigest, hmsStateDigest } from '../src/ai/hms-approval.js';
import { paneHmsWriteLoaders } from '../src/ai/pane-hms-write.js';
import { HmsLabtestDispatchError } from '../src/ai/hms-labtest-dispatch.js';
import { HMS_LABTEST_ATTACH_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import { aiWorkflowRun, attachment, mailThread, mailboxAccess, mailboxTransport, message } from '../src/db/schema/mail.js';
import { remoteSession } from '../src/db/schema/auth.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { createDocumentUploadGate } from '../tooling/hms-cloud/stay360-document-attach.mjs';
import { hasUniqueDocumentListing, runCloudPaneAttach } from '../tooling/hms-cloud/pane-attach-session.mjs';

const fieldNames = ['documentcode', 'description', 'organization', 'filename', 'filepath', 'multiorg', 'typecode',
  'uploaddoc', 'pagemode', 'recordid', 'uploadorcreatedoc', 'daeRentity', 'daeType', 'daeCode', 'pages', 'filetype'];
const bytes = Buffer.from('%PDF-synthetic filing');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const enabled = { PANE_HMS_LAB_ATTACH_WORKER: 'on', PANE_WRITE_ATTACH: 'lab' };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
const evidenceRoots = new Set<string>();

/** A synthetic request exercises the actual multipart fence; route.continue never reaches a network. */
function uploadRequest(file: { name: string; documentCode: string; description: string; mimeType: string; bytes: Buffer }) {
  const frame = {}, child = { parentFrame: () => frame, name: () => 'ext-gen1', url: () => 'about:blank' };
  const token = new URLSearchParams({ requestToken: 'synthetic-token', browserTabID: '1' });
  const fields = new Map(fieldNames.map((name) => [name, '']));
  for (const [key, value] of Object.entries({ documentcode: file.documentCode, description: file.description,
    organization: 'HRCEN', filename: `C:\\fakepath\\${file.name}`, typecode: 'U', uploaddoc: 'U',
    uploadorcreatedoc: 'U', daeRentity: 'RESV', daeCode: '123#123456-1#HRCEN' })) fields.set(key, value);
  const boundary = 'synthetic-boundary';
  const parts = fieldNames.map((key) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${fields.get(key)}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${file.name}"\r\nContent-Type: ${file.mimeType}\r\n\r\n${file.bytes.toString('latin1')}\r\n`);
  const body = Buffer.from(parts.join('') + `--${boundary}--\r\n`, 'latin1');
  const query = new URLSearchParams();
  for (const key of fieldNames.filter((key) => key !== 'filetype')) query.set(key, fields.get(key)!);
  query.set('requestToken', token.get('requestToken')!); query.set('browserTabID', '1'); query.set('isPopup', 'true');
  const request = { method: () => 'POST', isNavigationRequest: () => true, frame: () => child,
    url: () => `https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/BSUPLD.upload?${query}`,
    headers: () => ({ 'content-type': `multipart/form-data; boundary=${boundary}` }), postDataBuffer: () => body };
  return { frame, token, fields, request };
}

afterEach(async () => {
  resetS3Storage();
  paneHmsWriteLoaders.lock = null; paneHmsWriteLoaders.spawnAttach = null; paneHmsWriteLoaders.readAttachment = null;
  paneHmsWriteLoaders.readCloudFiling = null;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all([...evidenceRoots].map((dir) => rm(dir, { recursive: true, force: true })));
  evidenceRoots.clear();
});

describe('approved filing worker to Cloud upload fence', () => {
  it.each(['success', 'callback_missing', 'guest_changed', 'authority_refused', 'commit_unacknowledged',
    'pre_native_expiry', 'rollback_unacknowledged', 'refusal_drain_unconfirmed', 'refusal_close_unconfirmed',
    'finish_budget_preclaim', 'finish_budget_during_authority', 'finish_budget_after_claim', 'finish_budget_after_arm',
    'finish_budget_clock_rewind_after_arm',
    'negative_readback', 'after_seal_failed', 'unsafe_evidence_dir', 'intervening_resolved_write',
    'occupied_during_authority', 'occupied_rollback_unacknowledged', 'occupied_drain_unconfirmed', 'occupied_close_unconfirmed',
    'source_changed_at_claim', 'bytes_changed_before_check',
    'bytes_changed_after_check'] as const)(
    '%s: claims the queued job and continues only after an acknowledged durable intent', async (scenario) => {
      const interveningWrite = ['intervening_resolved_write', 'occupied_rollback_unacknowledged',
        'occupied_drain_unconfirmed', 'occupied_close_unconfirmed'].includes(scenario);
      const wallStart = Date.now();
      const steadyStart = performance.now();
      let clockOffset = 0, steadyOffset = 0;
      if (scenario.startsWith('finish_budget_')) vi.spyOn(Date, 'now').mockImplementation(() => wallStart + clockOffset);
      if (scenario === 'finish_budget_clock_rewind_after_arm') {
        vi.spyOn(performance, 'now').mockImplementation(() => steadyStart + steadyOffset);
      }
      const workItemId = randomUUID();
      const fingerprint = 'a'.repeat(64);
      const sourceSnapshotDigest = createHash('sha256').update(`${fingerprint}:${sha256}`).digest('hex');
      const form = { action: 'attach_document', confirmation: '123456-1', arrival: '2027-10-12', lastName: 'Labtest',
        attachmentId: 'att-1', documentName: 'voucher.pdf', pdfSha256: sha256, sourceMessageId: 'mail-1',
        sourceInternetMessageId: 'selected@example.test',
        sourceSnapshotDigest };
      const stay = { confirmation: form.confirmation, firstName: 'Proof', lastName: 'Labtest', status: 'Reserved',
        arrival: form.arrival, departure: '2027-10-13', roomType: 'STQN', ratePlan: 'BAR', organization: null, bookingAgency: null };
      const filingState = { confirmation: stay.confirmation, firstName: stay.firstName, lastName: stay.lastName,
        status: stay.status, arrival: stay.arrival, departure: stay.departure, nativeGuestId: '123', cmsSend: false };
      const item = { id: workItemId, transportId: 'transport-centurion', threadId: 'thread-1', status: 'needs_you',
        sourceMessageId: 'mail-1', state: { ...form, hmsSnapshot: { digest: hmsStateDigest(filingState), readAt: new Date().toISOString() } } };
      const mail = { id: 'mail-1', transportId: item.transportId, threadId: item.threadId,
        messageIdHeader: form.sourceInternetMessageId, direction: 'inbound', fromAddress: 'guest@example.test',
        toAddresses: [], ccAddresses: [] };
      const native = { ...stay, source: 'record_view_ext_model', propertyCode: 'HRCEN', guestId: scenario === 'guest_changed' ? '124' : '123',
        guaranteeCode: 'GTDAGT', roomType: 'DIFFERENT', ratePlan: 'DIFFERENT', reservationStayId: '42', reservationId: '123' };
      const record = { nativePreimage: native, details: { fields: [{ name: 'reservationnote', rawValue: '' },
        { name: 'udfchar13', value: '' }, { name: 'udfchkbox04', value: false }, { name: 'emailaddress', value: '' },
        { name: 'company', value: '' }, { name: 'ta1', value: '' }] } };
      const events: Array<Record<string, unknown>> = [], approvalEvents: Array<Record<string, unknown>> = [];
      const sealed: Array<{ id: string; value: { runId: string; name: string }; evidence: { sha256: string }; actorKind: string }> = [];
      const updates: Record<string, unknown>[] = [];
      let sent = 0, aborted = 0, drained = false, approvalDone = false, evidenceIndex = 0, reads = 0, transactions = 0;
      let storageBytes = bytes;
      let evidenceRoot = '', evidenceDirPath = '', stagedUploadPath = '';
      let queued: Record<string, unknown> | undefined, run: Record<string, unknown> | undefined;
      const selectApproval = () => {
        let table: unknown;
        const query = new Proxy({ from: (value: unknown) => { table = value; return query; }, where: () => query, orderBy: () => query,
          limit: () => query, for: async () => table === workItem ? [item] : table === message
            ? [{ id: item.sourceMessageId, threadId: item.threadId, direction: 'inbound' }] : [] }, {
          get(target, property, receiver) {
            if (property === 'then') return (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve([]));
            return Reflect.get(target, property, receiver);
          },
        });
        return query;
      };
      const approvalTx = { execute: async () => {}, select: selectApproval, insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
        if (table === workEvent) approvalEvents.push(value);
        if (table === aiWorkflowRun) queued = value;
        const chain = Object.assign(Promise.resolve(), {
          onConflictDoNothing() { return this; }, returning: async () => queued ? [queued] : [],
        });
        return chain;
      } }) };
      const tx = { execute: async () => {}, select: (fields: Record<string, unknown> = {}) => {
        let table: unknown;
        const result = () => {
          if (table === message) {
            if ('threadId' in fields) return [{ threadId: mail.threadId }];
            if ('direction' in fields || !Object.keys(fields).length) return [mail];
            return [{ id: mail.id }];
          }
          if (table === mailThread) return [{ id: item.threadId, historyOnly: false, trashedAt: null }];
          if (table === attachment) return [{ id: form.attachmentId, messageId: mail.id }];
          if (table === workItem) return [item];
          if (table === mailboxTransport) return [{ active: true }];
          if (table === mailboxAccess) return [{ userId: 'staff' }];
          if (table === remoteSession) return ['pre_native_expiry', 'rollback_unacknowledged', 'refusal_drain_unconfirmed',
            'refusal_close_unconfirmed'].includes(scenario) ? [] : [{ id: 'session-1' }];
          if (table === aiWorkflowRun) return 'metrics' in fields ? [{ metrics: {}, deadlineAt: fence.deadlineAt }] : [run];
          if (table === workEvent && 'itemId' in fields) return events.filter((event) => event.type === 'write.evidence')
            .map((event) => ({ ...event, itemId: event.workItemId }));
          if (table === workEvent && 'evidence' in fields) return [sealed[evidenceIndex++]];
          if (table === workEvent && 'payloadHash' in fields) return [approvalEvents[0]];
          if (table === workEvent && 'id' in fields) return [{ id: randomUUID() }];
          return [];
        };
        const query = new Proxy({ from: (value: unknown) => { table = value; return query; }, where: () => query,
          limit: () => query, for: async () => result() }, {
          get(target, property, receiver) {
            if (property === 'then') return (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(result()));
            return Reflect.get(target, property, receiver);
          },
        });
        return query;
      }, insert: () => ({ values: async (value: Record<string, unknown>) => { events.push(value); } }),
      update: () => ({ set: (value: Record<string, unknown>) => ({ where: async () => { updates.push(value); } }) }) };
      const db = { select: () => {
        let table: unknown;
        const query = { from: (value: unknown) => { table = value; return query; }, where: () => query,
          limit: async () => table === aiWorkflowRun ? [run] : table === workItem ? [item] : [] };
        return query;
      },
        transaction: async (fn: (value: unknown) => Promise<unknown>) => {
          if (!approvalDone) { const approved = await fn(approvalTx); approvalDone = true; return approved; }
          transactions++;
          let result;
          try { result = await fn(tx); } catch (error) {
            if (transactions > 1 && ['rollback_unacknowledged', 'occupied_rollback_unacknowledged'].includes(scenario)) {
              throw new Error('rollback acknowledgement lost');
            }
            throw error;
          }
          if (transactions > 1 && scenario === 'commit_unacknowledged') throw new Error('commit acknowledgement lost');
          if (transactions > 1 && scenario === 'finish_budget_after_claim') clockOffset = 12 * 60_000;
          return result;
        } } as unknown as DB;
      vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'on'); vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
      const approved = await approveHmsWrite({ db, transportId: item.transportId, workItemId, actorUserId: 'staff',
        selectedInternetMessageId: form.sourceInternetMessageId, sessionId: 'session-1', sessionProfile: 'remote',
        formDigest: formDigest(item.state) });
      expect(approvalEvents).toHaveLength(1);
      expect(approvalEvents[0]).toMatchObject({ type: 'approval.granted', id: approved.grantId });
      expect(queued).toMatchObject({ id: approved.runId, triggerMessageId: 'mail-1',
        promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION });
      const budget = scenario === 'finish_budget_preclaim' ? 13 * 60_000 : 25 * 60_000;
      const fence = { runId: approved.runId, claimOwner: 'worker', claimToken: randomUUID(), deadlineAt: new Date(Date.now() + budget) };
      run = { ...queued, state: 'running', claimOwner: fence.claimOwner, claimToken: fence.claimToken, deadlineAt: fence.deadlineAt };
      setS3Storage(new FakeS3Storage());
      paneHmsWriteLoaders.lock = { withLock: async (fn) => fn() };
      stubs.consume.mockResolvedValue({ form, grantId: approved.grantId, actorUserId: 'staff', sessionId: 'session-1', sessionProfile: 'remote' });
      stubs.unchanged.mockImplementation(async ({ readHmsState }) => {
        expect(await readHmsState()).toEqual(filingState);
        return { status: 'unchanged' };
      });
      stubs.authorize.mockImplementation(async () => {
        if (scenario === 'authority_refused') throw new Error('authorization revoked');
        if (scenario === 'occupied_during_authority') throw new HmsLabtestDispatchError('occupied');
        if (scenario === 'source_changed_at_claim') mail.messageIdHeader = 'different@example.test';
        if (scenario === 'finish_budget_during_authority') clockOffset = 12 * 60_000;
      });
      stubs.running.mockResolvedValue(true); stubs.heartbeat.mockResolvedValue(true);
      stubs.success.mockResolvedValue(true); stubs.end.mockResolvedValue(true);
      stubs.evidence.mockImplementation(async ({ runId, name }) => {
        if (['after_seal_failed', 'unsafe_evidence_dir'].includes(scenario) && name === 'after.png') {
          throw new Error('synthetic storage failure');
        }
        const eventId = randomUUID(), sha = createHash('sha256').update(png).digest('hex');
        sealed.push({ id: eventId, value: { runId, name }, evidence: { sha256: sha }, actorKind: 'system' });
        return { eventId, sha256: sha };
      });
      stubs.candidate.mockResolvedValue({ filename: form.documentName, sha256, fingerprint });
      stubs.readAttachment.mockImplementation(async ({ checkAuthority }) => {
        expect(await checkAuthority()).toBe(true);
        reads += 1;
        if (reads === 2 && scenario === 'bytes_changed_before_check') storageBytes = Buffer.from('%PDF-changed');
        const current = Buffer.from(storageBytes);
        if (reads === 2 && scenario === 'bytes_changed_after_check') storageBytes = Buffer.from('%PDF-changed');
        return { bytes: current };
      });
      stubs.cloudRun.mockResolvedValue({ record: { ...record, nativePreimage: { ...native, guestId: '123' } } });
      stubs.project.mockReturnValue({ outcome: 'found', stay, arrivalMismatch: false, nativePreimage: {
        ...native, guestId: '123' } });
      paneHmsWriteLoaders.spawnAttach = async (input) => {
        stagedUploadPath = input.file;
        if (interveningWrite) {
          const holdId = randomUUID(), otherGrant = randomUUID();
          events.push({ id: holdId, workItemId, type: 'write.evidence', actorKind: 'system', value: {
            version: 1, kind: 'intent', holdId, ownerDigest: 'f'.repeat(64), workItemId, transportId: item.transportId,
            actorUserId: 'other', grantId: otherGrant, propertyCode: 'HRCEN', firstName: 'Proof', lastName: 'Labtest',
            nativeGuestId: '123', operation: 'attach_document', sourceDigest: 'a'.repeat(64), approvedDigest: 'b'.repeat(64),
            requestDigest: 'c'.repeat(64), recovery: { synthetic: true } } });
          events.push({ workItemId, type: 'write.evidence', actorKind: 'system', value: { version: 1, kind: 'resolved',
            holdId, operation: 'attach_document', confirmation: form.confirmation, readbackDigest: 'd'.repeat(64),
            savedShot: { runId: approved.runId, sha256: 'e'.repeat(64) } } });
        }
        return runCloudPaneAttach(input, {
          openSession: async (fn: (page: object) => Promise<unknown>) => {
            const result = await fn({});
            if (['refusal_close_unconfirmed', 'occupied_close_unconfirmed'].includes(scenario)) {
              throw new Error('browser close unconfirmed');
            }
            return result;
          },
          writerIdentity: () => ({ host: 'b'.repeat(64), bootId: randomUUID(), pidNamespace: 'pid:[1]',
            node: { pid: 100, started: '10' }, browser: { pid: 200, started: '20' } }),
          shallow: async () => {}, read: async () => record,
          freshRead: async (_page: unknown, selected: { documentName: string }, code: string,
            setNative: (native: unknown) => void) => {
            setNative(native);
            const listed = scenario !== 'negative_readback' &&
              hasUniqueDocumentListing({ documents: [{ documentCode: code, name: selected.documentName }] }, code, selected.documentName);
            return { listed, ...(listed ? { nativeReadback: { confirmation: native.confirmation,
              nativeStayId: native.reservationStayId, nativeGuestId: native.guestId, documentCode: code,
              documentName: selected.documentName, uniqueFreshListing: true } } : {}), screenshot: listed ? png : null };
          },
          attach: async (_page: unknown, _expected: unknown, file: Parameters<typeof uploadRequest>[0], options: {
            evidenceRoot: string; beforeDispatch(): Promise<boolean>; finalAuthority(): Promise<boolean>;
            continuationAllowed(): boolean;
            dispatchWithAuthority(next: (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown }, digest: string,
              beforeShot: string, intercepted: unknown): Promise<unknown>; onDispatched(): void;
          }) => {
            // The native request always carries the bytes the selected staff form approved.
            expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(sha256);
            const { frame, token, fields, request } = uploadRequest(file);
            evidenceRoot = options.evidenceRoot;
            evidenceRoots.add(evidenceRoot);
            const evidenceDir = await mkdtemp(join(options.evidenceRoot, 'hms-document-'));
            evidenceDirPath = evidenceDir;
            const before = join(evidenceDir, 'before.png'), after = join(evidenceDir, 'after.png');
            await writeFile(before, png);
            const route = { request: () => request, continue: async () => {
              expect(events).toHaveLength(1); sent++; return 'sent'; }, abort: async () => { aborted++; return 'aborted'; } };
            const gate = createDocumentUploadGate({ frame, token, fields, file, evidenceDir,
              confirmation: form.confirmation, onDispatch: scenario === 'callback_missing' ? () => {} : options.onDispatched,
              onIntentError: () => {}, onAuthorityError: () => {},
              beforeDispatch: async () => await options.beforeDispatch() && await options.finalAuthority(),
              continuationAllowed: options.continuationAllowed,
              dispatchWithAuthority: (next: (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown }, digest: string,
                beforeShot: string, intercepted: unknown) => options.dispatchWithAuthority(Object.assign(async () => {
                  if (scenario === 'finish_budget_after_arm') clockOffset = 12 * 60_000;
                  if (scenario === 'finish_budget_clock_rewind_after_arm') {
                    clockOffset = -60_000;
                    steadyOffset = 12 * 60_000;
                  }
                  return next();
                }, { proveNeverDispatched: () => next.proveNeverDispatched?.() }), digest, beforeShot, intercepted) });
            const admitted = gate(route, { candidate: request, armed: true, checkStatus: 200, blocked: 0 });
            expect(admitted).not.toBeNull();
            await admitted!.result;
            gate.disarm(); drained = await gate.drain();
            await writeFile(after, png);
            if (scenario === 'unsafe_evidence_dir') await chmod(evidenceRoot, 0o755);
            return { outcome: sent ? 'awaiting_readback' : 'not_dispatched', evidenceDir,
              screenshots: [before, after], dispatchCallbacksDrained: drained &&
                !['refusal_drain_unconfirmed', 'occupied_drain_unconfirmed'].includes(scenario) };
          },
        });
      };
      const claim = vi.fn(async () => run);
      expect(await runLabtestAttachOnce({ ownerId: 'worker', db, env: enabled, claim: claim as never })).toBe(true);
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION }));
      if (scenario === 'guest_changed') {
        expect(sent).toBe(0); expect(aborted).toBe(0); expect(drained).toBe(false); expect(events).toHaveLength(0);
        return;
      }
      expect(drained).toBe(true);
      if (scenario === 'success' || scenario === 'callback_missing' || scenario === 'bytes_changed_after_check') {
        expect(sent).toBe(1); expect(aborted).toBe(0);
        expect(updates).toContainEqual(expect.objectContaining({ state: 'succeeded', metrics: expect.objectContaining({
          action: 'attach_document', outcome: 'confirmed', listed: true }) }));
        expect(stubs.authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
          confirmation: form.confirmation, arrival: form.arrival, grantId: approved.grantId,
          documentName: form.documentName, pdfSha256: sha256 }));
        expect(stubs.evidence).toHaveBeenCalledTimes(2);
        expect(events[0]?.value).toMatchObject({ operation: 'attach_document', nativeGuestId: '123',
          recovery: { confirmation: form.confirmation, arrival: form.arrival, departure: stay.departure, runId: approved.runId,
            documentName: form.documentName, before: { eventId: expect.any(String), sha256: expect.any(String) },
            writer: expect.objectContaining({ node: { pid: 100, started: '10' }, browser: { pid: 200, started: '20' } }),
            pdfSha256: sha256, documentCode: expect.stringMatching(/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/) },
          requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(events[1]?.value).toMatchObject({ kind: 'resolved', operation: 'attach_document' });
        if (scenario === 'success') await expect(stat(evidenceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      } else if (scenario === 'after_seal_failed' || scenario === 'unsafe_evidence_dir') {
        expect(sent).toBe(1); expect(events).toHaveLength(1);
        expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'UNKNOWN', reason: 'confirmed_hold_unsettled' }));
        if (scenario === 'after_seal_failed') {
          const info = await stat(evidenceRoot);
          expect(info.uid).toBe(process.getuid?.()); expect(info.mode & 0o077).toBe(0);
          expect(await readFile(join(evidenceDirPath, 'after.png'))).toEqual(png);
          await expect(stat(stagedUploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } else await expect(stat(evidenceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      } else if (scenario === 'negative_readback') {
        expect(sent).toBe(1); expect(aborted).toBe(0); expect(updates.filter((row) => row.state === 'succeeded')).toHaveLength(0);
        expect(events).toHaveLength(1);
        expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'UNKNOWN', reason: 'upload_unconfirmed' }));
        expect(await runLabtestAttachOnce({ ownerId: 'worker', db, env: enabled, claim: claim as never })).toBe(true);
        expect(sent).toBe(1); expect(aborted).toBe(0); expect(events).toHaveLength(1);
      } else if (interveningWrite) {
        expect(sent).toBe(0); expect(aborted).toBe(1); expect(events).toHaveLength(2);
        expect(stubs.authorize).not.toHaveBeenCalled();
        expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining(scenario === 'intervening_resolved_write'
          ? { failureClass: 'NEEDS_CHECK', reason: 'filing_authority_refused' }
          : { failureClass: 'UNKNOWN', reason: scenario === 'occupied_close_unconfirmed'
            ? 'target_hold_missing' : 'dispatch_claim_unresolved' }));
      } else {
        expect(sent).toBe(0); expect(aborted).toBe(1); expect(updates.filter((row) => row.state === 'succeeded')).toHaveLength(0);
        const noDispatch = ['finish_budget_after_claim', 'finish_budget_after_arm', 'finish_budget_clock_rewind_after_arm'].includes(scenario);
        expect(events).toHaveLength(noDispatch ? 3 : scenario === 'commit_unacknowledged' ? 1 : 0);
        if (noDispatch) {
          expect(events[2]?.value).toMatchObject({ kind: 'not_dispatched', operation: 'attach_document' });
          expect(updates).toContainEqual(expect.objectContaining({ state: 'dead_letter', failureClass: 'NEEDS_CHECK',
            lastError: 'filing_not_dispatched' }));
          expect(stubs.end).not.toHaveBeenCalled();
        }
        if (scenario === 'pre_native_expiry' || scenario === 'source_changed_at_claim' || scenario === 'finish_budget_during_authority') {
          expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'NEEDS_CHECK', reason: 'filing_authority_refused' }));
        } else if (['authority_refused', 'occupied_during_authority', 'commit_unacknowledged', 'rollback_unacknowledged',
          'refusal_drain_unconfirmed', 'refusal_close_unconfirmed'].includes(scenario)) {
          expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'UNKNOWN' }));
        } else if (scenario === 'finish_budget_preclaim') {
          expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'NEEDS_CHECK' }));
        }
      }
    },
  );
});
