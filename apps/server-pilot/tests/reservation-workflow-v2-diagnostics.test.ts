import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logReservationWorkflowFailure } from '../src/trpc/reservation-workflow-v2-diagnostics.js';

const previousDirectory = process.env.NAVA_WORKFLOW_REPRO_DIR;
const previousBuild = process.env.NAVA_BUILD_COMMIT;
let root = '';

afterEach(async () => {
  if (previousDirectory === undefined) delete process.env.NAVA_WORKFLOW_REPRO_DIR;
  else process.env.NAVA_WORKFLOW_REPRO_DIR = previousDirectory;
  if (previousBuild === undefined) delete process.env.NAVA_BUILD_COMMIT;
  else process.env.NAVA_BUILD_COMMIT = previousBuild;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('reservation workflow failure repro bundle', () => {
  it('writes bounded prepare metadata without source content or secrets', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-repro-'));
    process.env.NAVA_WORKFLOW_REPRO_DIR = root;
    process.env.NAVA_BUILD_COMMIT = 'a'.repeat(40);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await logReservationWorkflowFailure({
      path: 'reservationWorkflowV2.prepare',
      rawInput: {
        workItemId: 'work-1', requestId: 'request-1', expectedRevision: 12, expectedSeq: 34,
        source: { sourceHash: 'b'.repeat(64), body: 'Guest Jane secret mail body' },
        databaseUrl: 'postgres://secret.example.invalid/prod',
      },
      result: {
        status: 'needs_input', issue: 'guest_name_required',
        fields: ['/proposal/content/requests/request-1/body/guest/name:required'],
        observationRef: 'observation-1',
      },
      userId: 'user-1', transportId: 'mailbox-1', correlationId: null, elapsedMs: 10,
    });

    expect(info).toHaveBeenCalledWith('reservation_workflow_failure', expect.any(String));
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    const path = join(root, files[0]!);
    const text = await readFile(path, 'utf8');
    expect(text).not.toMatch(/Jane|postgres|secret\.example|user-1|mailbox-1/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1, action: 'reservationWorkflowV2.prepare', status: 'needs_input',
      workItemId: 'work-1', revision: 12, seq: 34, requestId: 'request-1',
      sourceHash: 'b'.repeat(64), serverBuild: 'a'.repeat(40),
      blockerCodes: ['guest_name_required'],
      blockerFields: ['/proposal/content/requests/request-1/body/guest/name:required'],
      missingControls: [{
        path: '/proposal/content/requests/request-1/body/guest/name',
        segments: ['proposal', 'content', 'requests', 'request-1', 'body', 'guest', 'name'],
        code: 'required',
      }],
      observationRefs: ['observation-1'],
    });
  });

  it('does not write when the repro directory is unset', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-repro-unset-'));
    delete process.env.NAVA_WORKFLOW_REPRO_DIR;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await logReservationWorkflowFailure({
      path: 'reservationWorkflowV2.prepare', rawInput: {}, result: { status: 'failed', issue: 'prepare_failed' },
      userId: 'user-1', transportId: 'mailbox-1', correlationId: null, elapsedMs: 1,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('does not write for a non-repro action', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-repro-other-'));
    process.env.NAVA_WORKFLOW_REPRO_DIR = root;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await logReservationWorkflowFailure({
      path: 'reservationWorkflowV2.get', rawInput: {}, result: { status: 'failed', issue: 'read_failed' },
      userId: 'user-1', transportId: 'mailbox-1', correlationId: null, elapsedMs: 1,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('writes execute transport failures with request-scoped IDs', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-repro-execute-'));
    process.env.NAVA_WORKFLOW_REPRO_DIR = root;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await logReservationWorkflowFailure({
      path: 'reservationWorkflowV2.executeServices',
      rawInput: {
        requestId: 'request-1', allocationId: 'allocation-1', serviceId: 'service-1',
        targetRef: { kind: 'saved_target', requestId: 'request-1', hintId: 'hint-1' },
        expectedRevision: 7, expectedSeq: 9,
      },
      error: { code: 'INTERNAL_SERVER_ERROR' },
      userId: 'user-1', transportId: 'mailbox-1', correlationId: null, elapsedMs: 1,
    });
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, files[0]!), 'utf8'))).toMatchObject({
      action: 'reservationWorkflowV2.executeServices', status: 'failed',
      requestId: 'request-1', allocationId: 'allocation-1', serviceId: 'service-1',
      targetRef: { kind: 'saved_target', requestId: 'request-1', hintId: 'hint-1' },
      revision: 7, seq: 9, blockerCodes: ['INTERNAL_SERVER_ERROR'],
      offlineReload: { mode: 'metadata_only', limitation: 'draft_and_overrides_not_captured' },
    });
  });

  it('keeps encoded JSON-pointer segments in missing controls', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-repro-pointer-'));
    process.env.NAVA_WORKFLOW_REPRO_DIR = root;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const field = '/proposal/requests/client~1vip%20desk/name~0suffix:required';
    await logReservationWorkflowFailure({
      path: 'reservationWorkflowV2.prepare', rawInput: {},
      result: { status: 'needs_input', issue: 'field_required', fields: [field] },
      userId: 'user-1', transportId: 'mailbox-1', correlationId: null, elapsedMs: 1,
    });
    const files = await readdir(root);
    const bundle = JSON.parse(await readFile(join(root, files[0]!), 'utf8'));
    expect(bundle.blockerFields).toEqual([field]);
    expect(bundle.missingControls).toEqual([{
      path: '/proposal/requests/client~1vip%20desk/name~0suffix',
      segments: ['proposal', 'requests', 'client/vip%20desk', 'name~suffix'],
      code: 'required',
    }]);
  });

  it('captures nested prepareServices blockers from a partial result', async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-repro-services-'));
    process.env.NAVA_WORKFLOW_REPRO_DIR = root;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await logReservationWorkflowFailure({
      path: 'reservationWorkflowV2.prepareServices',
      rawInput: { requestId: 'request-1', allocationId: 'allocation-1', serviceId: 'service-1' },
      result: {
        status: 'partial',
        services: [{
          status: 'needs_input', issue: 'service_dates_required',
          fields: ['/proposal/content/services/service-1/startDate:required'],
          observationRef: 'observation-1',
        }],
      },
      userId: 'user-1', transportId: 'mailbox-1', correlationId: null, elapsedMs: 1,
    });
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, files[0]!), 'utf8'))).toMatchObject({
      status: 'partial', allocationId: 'allocation-1', serviceId: 'service-1',
      blockerCodes: ['service_dates_required'],
      blockerFields: ['/proposal/content/services/service-1/startDate:required'],
      observationRefs: ['observation-1'],
    });
  });
});
