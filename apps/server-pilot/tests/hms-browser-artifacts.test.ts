import {
  createHmsBrowserArtifactStore as createRawHmsBrowserArtifactStore,
  ensureHmsBrowserArtifactRoot,
  HmsBrowserArtifactError,
  HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES,
  HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES,
  purgeExpiredHmsBrowserArtifacts,
  validatePlaywrightTraceFile,
  validateWebmFile,
  type HmsBrowserAuditSpec,
} from '../src/hms/browser-artifacts.js';
import { mkdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const createHmsBrowserArtifactStore = (
  input: Parameters<typeof createRawHmsBrowserArtifactStore>[0],
) =>
  createRawHmsBrowserArtifactStore({
    ...input,
    validateTraceFile: input.validateTraceFile ?? (async () => true),
    validateVideoFile: input.validateVideoFile ?? (async () => true),
  });

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `hms-browser-artifacts-${randomUUID()}`);
  await ensureHmsBrowserArtifactRoot(root);
  return root;
}

function baseSpec(overrides: Partial<HmsBrowserAuditSpec> = {}): HmsBrowserAuditSpec {
  return {
    operationId: randomUUID(),
    toolId: 'hms_find_reservation',
    toolVersion: '1.2.0',
    dependencyRevision: 'playwright-1.52.0-chromium-1169',
    executionClass: 'normal',
    inputClass: 'authorized_exact',
    roleProofSha256: 'a'.repeat(64),
    roleProofExpiresAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const validTraceZip = () =>
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(26),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18),
  ]);

const crc32 = (input: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const traceZip = (entries: Record<string, string>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(value);
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralBody = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBody, end]);
};

const ebmlElement = (id: number[], payload: Buffer) => {
  if (payload.length >= 0x3fff) throw new Error('test EBML payload too large');
  const size =
    payload.length < 0x7f
      ? Buffer.from([0x80 | payload.length])
      : Buffer.from([0x40 | (payload.length >> 8), payload.length & 0xff]);
  return Buffer.concat([Buffer.from(id), size, payload]);
};

const validWebm = (options: { includeCues?: boolean; unknownSegmentSize?: boolean } = {}) => {
  const header = ebmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebmlElement([0x42, 0x82], Buffer.from('webm')),
  );
  const info = ebmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    ebmlElement([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])),
  );
  const video = ebmlElement(
    [0xe0],
    Buffer.concat([
      ebmlElement([0xb0], Buffer.from([0x00, 0x01])),
      ebmlElement([0xba], Buffer.from([0x00, 0x01])),
    ]),
  );
  const trackEntry = ebmlElement(
    [0xae],
    Buffer.concat([
      ebmlElement([0xd7], Buffer.from([0x01])),
      ebmlElement([0x73, 0xc5], Buffer.from([0x01])),
      ebmlElement([0x83], Buffer.from([0x01])),
      ebmlElement([0x86], Buffer.from('V_VP8')),
      video,
    ]),
  );
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const vp8Keyframe = Buffer.from([
    0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const cluster = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    Buffer.concat([
      ebmlElement([0xe7], Buffer.from([0x00])),
      ebmlElement([0xa3], Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), vp8Keyframe])),
      ebmlElement(
        [0xa3],
        Buffer.concat([
          Buffer.from([0x81, 0x00, 0x64, 0x00]),
          Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        ]),
      ),
    ]),
  );
  const cues = ebmlElement(
    [0x1c, 0x53, 0xbb, 0x6b],
    ebmlElement(
      [0xbb],
      Buffer.concat([
        ebmlElement([0xb3], Buffer.from([0x00])),
        ebmlElement(
          [0xb7],
          Buffer.concat([
            ebmlElement([0xf7], Buffer.from([0x01])),
            ebmlElement([0xf1], Buffer.from([0x00])),
          ]),
        ),
      ]),
    ),
  );
  const segmentPayload = Buffer.concat([
    info,
    tracks,
    cluster,
    ...(options.includeCues === false ? [] : [cues]),
  ]);
  const segment = options.unknownSegmentSize
    ? Buffer.concat([
        Buffer.from([0x18, 0x53, 0x80, 0x67]),
        Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        segmentPayload,
      ])
    : ebmlElement([0x18, 0x53, 0x80, 0x67], segmentPayload);
  return Buffer.concat([header, segment]);
};

describe('hms browser artifacts store', () => {
  it('requires nonempty parseable Playwright trace event streams', async () => {
    const root = await tempRoot();
    const path = join(root, 'trace.zip');
    const trace = `${JSON.stringify({ type: 'context-options' })}\n`;
    const network = `${JSON.stringify({ type: 'resource-snapshot' })}\n`;
    await writeFile(path, traceZip({ 'trace.trace': trace, 'trace.network': network }));
    await expect(validatePlaywrightTraceFile(path)).resolves.toBe(true);

    await writeFile(path, traceZip({ 'trace.trace': trace, 'trace.network': '' }));
    await expect(validatePlaywrightTraceFile(path)).resolves.toBe(false);

    await writeFile(path, traceZip({ 'trace.trace': trace, 'trace.network': '{not-json}\n' }));
    await expect(validatePlaywrightTraceFile(path)).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('accepts structured WebM media and rejects marker-only or truncated files', async () => {
    const root = await tempRoot();
    const path = join(root, 'video.webm');
    const complete = validWebm();
    await writeFile(path, complete);
    await expect(validateWebmFile(path)).resolves.toBe(true);
    await writeFile(
      path,
      Buffer.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x18, 0x53, 0x80, 0x67, 0x16, 0x54, 0xae, 0x6b, 0x1f, 0x43, 0xb6,
        0x75, 0xa3,
      ]),
    );
    await expect(validateWebmFile(path)).resolves.toBe(false);
    await writeFile(path, validWebm({ includeCues: false }));
    await expect(validateWebmFile(path)).resolves.toBe(false);
    await writeFile(path, validWebm({ unknownSegmentSize: true }));
    await expect(validateWebmFile(path)).resolves.toBe(false);
    await writeFile(path, complete.subarray(0, complete.length - 1));
    await expect(validateWebmFile(path)).resolves.toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects symlink artifact roots', async () => {
    const real = await tempRoot();
    const link = join(tmpdir(), `hms-artifacts-link-${randomUUID()}`);
    try {
      await symlink(real, link, 'junction');
    } catch {
      // Some Windows environments disallow junctions — skip.
      await rm(real, { recursive: true, force: true });
      return;
    }
    await expect(createHmsBrowserArtifactStore({ root: link })).rejects.toMatchObject({
      code: 'TRACE_STORAGE_UNAVAILABLE',
    });
    await rm(real, { recursive: true, force: true });
    await rm(link, { recursive: true, force: true });
  });

  it('rejects lexical ancestor symlinks before resolving the artifact root', async () => {
    const base = join(tmpdir(), `hms-artifacts-parent-${randomUUID()}`);
    const realParent = join(base, 'real');
    const realRoot = join(realParent, 'artifacts');
    const linkedParent = join(base, 'linked');
    await mkdir(realParent, { recursive: true, mode: 0o700 });
    await ensureHmsBrowserArtifactRoot(realRoot);
    try {
      await symlink(realParent, linkedParent, 'junction');
    } catch {
      await rm(base, { recursive: true, force: true });
      return;
    }
    await expect(
      createHmsBrowserArtifactStore({ root: join(linkedParent, 'artifacts') }),
    ).rejects.toMatchObject({ code: 'TRACE_STORAGE_UNAVAILABLE' });
    await rm(linkedParent, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  it('accepts the registered quote audit shape and rejects invalid/write shapes', async () => {
    const root = await tempRoot();
    const store = await createRawHmsBrowserArtifactStore({ root });
    await expect(
      store.beginCapture(baseSpec({ operationId: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(HmsBrowserArtifactError);

    const quoteHandle = await store.beginCapture(
      baseSpec({
        toolId: 'hms_quote_stay' as HmsBrowserAuditSpec['toolId'],
        toolVersion: '2.0.0',
      }),
    );
    await writeFile(
      join(quoteHandle.stagingDir, 'trace.zip'),
      traceZip({
        'trace.trace': `${JSON.stringify({ type: 'context-options' })}\n`,
        'trace.network': `${JSON.stringify({ type: 'resource-snapshot' })}\n`,
      }),
    );
    const quoteReceipt = await quoteHandle.finalize({
      outcome: 'succeeded',
      terminalCode: 'OK',
      terminalStage: 'receipt_finalize',
      sourceRevision: 'quote-source',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      requestRules: [{ ruleId: 'quote-read-post', count: 1 }],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: true,
    });
    expect(quoteReceipt.toolId).toBe('hms_quote_stay');
    expect(quoteReceipt.credentialMode).toBe('view_only');
    expect(quoteReceipt.inputClass).toBe('authorized_exact');
    expect(quoteReceipt.mutationRequests).toBe(0);
    expect(Date.parse(quoteReceipt.expiresAt)).toBeGreaterThan(Date.now());

    const folioHandle = await store.beginCapture(
      baseSpec({
        toolId: 'hms_read_folio',
        requestBranchId: 'folio_summary',
      }),
    );
    await writeFile(
      join(folioHandle.stagingDir, 'trace.zip'),
      traceZip({
        'trace.trace': `${JSON.stringify({ type: 'context-options' })}\n`,
        'trace.network': `${JSON.stringify({ type: 'resource-snapshot' })}\n`,
      }),
    );
    const folioReceipt = await folioHandle.finalize({
      outcome: 'succeeded',
      terminalCode: 'OK',
      terminalStage: 'receipt_finalize',
      sourceRevision: 'folio-source',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      requestRules: [{ ruleId: 'folio-read-post', count: 1 }],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: true,
    });
    expect(folioReceipt.toolId).toBe('hms_read_folio');
    expect(folioReceipt.requestBranchId).toBe('folio_summary');
    await expect(
      store.beginCapture(
        baseSpec({
          toolId: 'hms_write_reservation' as HmsBrowserAuditSpec['toolId'],
        }),
      ),
    ).rejects.toBeInstanceOf(HmsBrowserArtifactError);
    await expect(
      store.beginCapture(
        baseSpec({
          executionClass: 'write' as HmsBrowserAuditSpec['executionClass'],
        }),
      ),
    ).rejects.toBeInstanceOf(HmsBrowserArtifactError);
    await rm(root, { recursive: true, force: true });
  });

  it('fails preflight below 2 GiB free', async () => {
    const root = await tempRoot();
    await expect(
      createHmsBrowserArtifactStore({
        root,
        getFreeBytes: async () => HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES - 1,
      }),
    ).rejects.toMatchObject({ code: 'CAPTURE_CAPACITY_EXCEEDED' });
    await rm(root, { recursive: true, force: true });
  });

  it('rechecks free space before every capture', async () => {
    const root = await tempRoot();
    let checks = 0;
    try {
      const store = await createHmsBrowserArtifactStore({
        root,
        getFreeBytes: async () => {
          checks += 1;
          return checks === 1
            ? HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES
            : HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES - 1;
        },
      });
      await expect(store.beginCapture(baseSpec())).rejects.toMatchObject({
        code: 'CAPTURE_CAPACITY_EXCEEDED',
      });
      expect(checks).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked Playwright intermediate directory', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const intermediate = join(root, '.playwright-intermediate');
    try {
      await symlink(outside, intermediate, 'junction');
    } catch {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      return;
    }
    await expect(createHmsBrowserArtifactStore({ root })).rejects.toMatchObject({
      code: 'TRACE_STORAGE_UNAVAILABLE',
    });
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('stages under .partial-<uuid> and finalizes complete receipt with digests', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const handle = await store.beginCapture(baseSpec());
    expect(handle.stagingDir).toContain(`.partial-${handle.artifactId}`);
    expect(handle.videoDir).toBeNull();

    const zip = validTraceZip();
    await writeFile(join(handle.stagingDir, 'trace.zip'), zip);
    handle.markMilestone('traceStartedAt', new Date('2026-08-05T00:00:00.000Z'));
    handle.markMilestone('traceStoppedAt', new Date('2026-08-05T00:00:01.000Z'));

    const receipt = await handle.finalize({
      outcome: 'succeeded',
      terminalCode: 'OK',
      terminalStage: 'receipt_finalize',
      sourceRevision: 'src-rev-1',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      requestRules: [{ ruleId: 'live-login-post', count: 1 }],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: true,
    });

    expect(receipt.artifactState).toBe('complete');
    expect(receipt.trace.bytes).toBe(zip.byteLength);
    expect(receipt.trace.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.video).toBeNull();
    expect(receipt.milestones.traceStartedAt).toBe('2026-08-05T00:00:00.000Z');

    const finalReceipt = JSON.parse(
      await readFile(join(root, handle.artifactId, 'receipt.v1.json'), 'utf8'),
    );
    expect(finalReceipt.artifactId).toBe(handle.artifactId);
    expect(finalReceipt).not.toHaveProperty('password');
    expect(finalReceipt).not.toHaveProperty('candidateId');

    await rm(root, { recursive: true, force: true });
  });

  it('live_proof requires video for complete receipt', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const handle = await store.beginCapture(baseSpec({ executionClass: 'live_proof' }));
    expect(handle.videoDir).toContain('video-raw');
    await writeFile(join(handle.stagingDir, 'trace.zip'), validTraceZip());

    await expect(
      handle.finalize({
        outcome: 'succeeded',
        terminalCode: 'OK',
        terminalStage: 'receipt_finalize',
        sourceRevision: 'src',
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
        requestRules: [],
        blockedRequests: 0,
        mutationRequests: 0,
        popupCount: 0,
        downloadCount: 0,
        webSocketCount: 0,
        complete: true,
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_FINALIZE_FAILED' });

    await writeFile(join(handle.stagingDir, 'video.webm'), validWebm());
    const receipt = await handle.finalize({
      outcome: 'succeeded',
      terminalCode: 'OK',
      terminalStage: 'receipt_finalize',
      sourceRevision: 'src',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      requestRules: [],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: true,
    });
    expect(receipt.artifactState).toBe('complete');
    expect(receipt.video?.sha256).toMatch(/^[a-f0-9]{64}$/);

    await rm(root, { recursive: true, force: true });
  });

  it('live_proof rejects empty or non-WebM video bytes', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not-webm')]) {
      const root = await tempRoot();
      const store = await createHmsBrowserArtifactStore({ root });
      const handle = await store.beginCapture(baseSpec({ executionClass: 'live_proof' }));
      await writeFile(join(handle.stagingDir, 'trace.zip'), validTraceZip());
      await writeFile(join(handle.stagingDir, 'video.webm'), bytes);
      await expect(
        handle.finalize({
          outcome: 'succeeded',
          terminalCode: 'OK',
          terminalStage: 'receipt_finalize',
          sourceRevision: 'src',
          playwrightRevision: '1.52.0',
          chromiumRevision: '1169',
          requestRules: [],
          blockedRequests: 0,
          mutationRequests: 0,
          popupCount: 0,
          downloadCount: 0,
          webSocketCount: 0,
          complete: true,
        }),
      ).rejects.toMatchObject({ code: 'VIDEO_FINALIZE_FAILED' });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires full ZIP integrity and decodable live-proof video', async () => {
    const traceRoot = await tempRoot();
    const traceStore = await createHmsBrowserArtifactStore({
      root: traceRoot,
      validateTraceFile: async () => false,
    });
    const traceHandle = await traceStore.beginCapture(baseSpec());
    await writeFile(join(traceHandle.stagingDir, 'trace.zip'), validTraceZip());
    await expect(
      traceHandle.finalize({
        outcome: 'succeeded',
        terminalCode: 'OK',
        terminalStage: 'receipt_finalize',
        sourceRevision: 'src',
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
        requestRules: [],
        blockedRequests: 0,
        mutationRequests: 0,
        popupCount: 0,
        downloadCount: 0,
        webSocketCount: 0,
        complete: true,
      }),
    ).rejects.toMatchObject({ code: 'TRACE_FINALIZE_FAILED' });
    await rm(traceRoot, { recursive: true, force: true });

    const videoRoot = await tempRoot();
    const videoStore = await createHmsBrowserArtifactStore({
      root: videoRoot,
      validateVideoFile: async () => false,
    });
    const videoHandle = await videoStore.beginCapture(baseSpec({ executionClass: 'live_proof' }));
    await writeFile(join(videoHandle.stagingDir, 'trace.zip'), validTraceZip());
    await writeFile(join(videoHandle.stagingDir, 'video.webm'), validWebm());
    await expect(
      videoHandle.finalize({
        outcome: 'succeeded',
        terminalCode: 'OK',
        terminalStage: 'receipt_finalize',
        sourceRevision: 'src',
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
        requestRules: [],
        blockedRequests: 0,
        mutationRequests: 0,
        popupCount: 0,
        downloadCount: 0,
        webSocketCount: 0,
        complete: true,
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_FINALIZE_FAILED' });
    await rm(videoRoot, { recursive: true, force: true });
  });

  it('rejects oversized finalized capture', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const handle = await store.beginCapture(baseSpec());
    const tracePath = join(handle.stagingDir, 'trace.zip');
    await writeFile(tracePath, Buffer.from([1]));
    await truncate(tracePath, HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES + 1);
    await expect(
      handle.finalize({
        outcome: 'succeeded',
        terminalCode: 'OK',
        terminalStage: 'receipt_finalize',
        sourceRevision: 'src',
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
        requestRules: [],
        blockedRequests: 0,
        mutationRequests: 0,
        popupCount: 0,
        downloadCount: 0,
        webSocketCount: 0,
        complete: true,
      }),
    ).rejects.toMatchObject({ code: 'CAPTURE_CAPACITY_EXCEEDED' });
    await rm(root, { recursive: true, force: true });
  });

  it('ignores stale shared Playwright intermediates in active capture capacity', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const staleTrace = join(store.intermediateDir, 'stale.trace');
    await writeFile(staleTrace, Buffer.from([1]));
    await truncate(staleTrace, HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES + 1);
    const handle = await store.beginCapture(baseSpec());
    await writeFile(join(handle.stagingDir, 'trace.zip'), Buffer.from('1234'));

    expect(await handle.observeStagedBytes()).toBe(4);

    await writeFile(join(store.intermediateDir, 'current.trace'), Buffer.from('1234567'));
    expect(await handle.observeStagedBytes()).toBe(11);
    await rm(root, { recursive: true, force: true });
  });

  it('counts new intermediate bytes when baseline files disappear', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const stale = join(store.intermediateDir, 'stale.trace');
    await writeFile(stale, Buffer.alloc(20, 1));
    const handle = await store.beginCapture(baseSpec());
    await rm(stale);
    await writeFile(join(store.intermediateDir, 'current.trace'), Buffer.alloc(12, 2));
    expect(await handle.observeStagedBytes()).toBe(12);
    await rm(root, { recursive: true, force: true });
  });

  it('keeps operationOutcome separate from artifactState on incomplete finalize', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const handle = await store.beginCapture(baseSpec());
    const receipt = await handle.finalize({
      outcome: 'failed',
      terminalCode: 'TOOL_ERROR',
      terminalStage: 'tool',
      sourceRevision: 'src',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      requestRules: [],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: false,
    });
    expect(receipt.artifactState).toBe('incomplete');
    expect(receipt.operationOutcome).toBe('failed');
    expect(receipt.trace).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  it('purges expired complete artifacts only', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const handle = await store.beginCapture(baseSpec());
    await writeFile(join(handle.stagingDir, 'trace.zip'), validTraceZip());
    await handle.finalize({
      outcome: 'succeeded',
      terminalCode: 'OK',
      terminalStage: 'receipt_finalize',
      sourceRevision: 'src',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      requestRules: [],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: true,
    });
    const receiptPath = join(root, handle.artifactId, 'receipt.v1.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.expiresAt = '2000-01-01T00:00:00.000Z';
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    const removed = await store.purgeExpired(new Date('2026-08-05T00:00:00Z'));
    expect(removed).toBe(1);
    await expect(readFile(receiptPath)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('purges stale partial, incomplete, and intermediate entries after 24h', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const oldPartial = join(root, `.partial-${randomUUID()}`);
    const oldIncomplete = join(root, `.incomplete-${randomUUID()}`);
    const oldIntermediate = join(store.intermediateDir, 'old.trace');
    const recentPartial = join(root, `.partial-${randomUUID()}`);
    await mkdir(oldPartial);
    await mkdir(oldIncomplete);
    await writeFile(oldIntermediate, Buffer.from('old'));
    await mkdir(recentPartial);
    const old = new Date('2026-08-01T00:00:00Z');
    await utimes(oldPartial, old, old);
    await utimes(oldIncomplete, old, old);
    await utimes(oldIntermediate, old, old);

    const removed = await store.purgeExpired(new Date('2026-08-05T00:00:00Z'));
    expect(removed).toBe(3);
    await expect(readFile(oldIntermediate)).rejects.toThrow();
    await expect(stat(oldPartial)).rejects.toThrow();
    await expect(stat(oldIncomplete)).rejects.toThrow();
    await expect(stat(recentPartial)).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it('purges stale unreadable finalized artifact directories', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    const artifact = join(root, randomUUID());
    await mkdir(artifact);
    await writeFile(join(artifact, 'receipt.v1.json'), '{broken');
    const old = new Date('2026-08-01T00:00:00Z');
    await utimes(join(artifact, 'receipt.v1.json'), old, old);
    await utimes(artifact, old, old);

    const removed = await store.purgeExpired(new Date('2026-08-05T00:00:00Z'));
    expect(removed).toBe(1);
    await expect(stat(artifact)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('purges stale finalized artifacts despite invalid future receipt expiry', async () => {
    const root = await tempRoot();
    const artifact = join(root, randomUUID());
    await mkdir(artifact);
    await writeFile(
      join(artifact, 'receipt.v1.json'),
      `${JSON.stringify({ expiresAt: '2999-01-01T00:00:00.000Z' })}\n`,
    );
    const old = new Date('2026-08-01T00:00:00Z');
    await utimes(join(artifact, 'receipt.v1.json'), old, old);
    await utimes(artifact, old, old);

    const removed = await purgeExpiredHmsBrowserArtifacts(root, new Date('2026-08-05T00:00:00Z'));
    expect(removed).toBe(1);
    await expect(stat(artifact)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('never purges artifact directories holding ambiguous dual receipts', async () => {
    const root = await tempRoot();
    const artifact = join(root, randomUUID());
    await mkdir(artifact);
    await writeFile(
      join(artifact, 'receipt.v1.json'),
      `${JSON.stringify({ schemaVersion: 1, expiresAt: '2000-01-01T00:00:00.000Z' })}\n`,
    );
    await writeFile(
      join(artifact, 'receipt.v2.json'),
      `${JSON.stringify({ schemaVersion: 2, expiresAt: '2000-01-01T00:00:00.000Z' })}\n`,
    );
    const old = new Date('2026-08-01T00:00:00Z');
    await utimes(artifact, old, old);

    await expect(
      purgeExpiredHmsBrowserArtifacts(root, new Date('2026-08-05T00:00:00Z')),
    ).resolves.toBe(0);
    await expect(stat(artifact)).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it('purges without capture free-space preflight', async () => {
    const root = await tempRoot();
    const artifact = join(root, randomUUID());
    await mkdir(artifact);
    await writeFile(
      join(artifact, 'receipt.v1.json'),
      `${JSON.stringify({ expiresAt: '2000-01-01T00:00:00.000Z' })}\n`,
    );

    await expect(
      purgeExpiredHmsBrowserArtifacts(root, new Date('2026-08-05T00:00:00.000Z')),
    ).resolves.toBe(1);
    await expect(stat(artifact)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('exposes protected intermediate tracesDir under root', async () => {
    const root = await tempRoot();
    const store = await createHmsBrowserArtifactStore({ root });
    expect(store.intermediateDir).toBe(join(root, '.playwright-intermediate'));
    await mkdir(store.intermediateDir, { recursive: true });
    await rm(root, { recursive: true, force: true });
  });

  it('builds discovery|proof receipt v2 helpers without breaking find v1 writers', async () => {
    const { buildDiscoveryReceiptV2, buildProofReceiptV2, writeBrowserArtifactReceiptV2 } =
      await import('../src/hms/browser-artifacts.js');
    const { loadExclusiveReceipt } = await import('../src/hms/artifact-index.js');
    const h = (c: string) => c.repeat(64);
    const common = {
      artifactId: randomUUID(),
      operationId: randomUUID(),
      toolId: 'hms_quote_stay' as const,
      discoveryOperationId: 'quote_availability_search' as const,
      toolVersion: '1.0.0',
      sourceRevision: 'rev-11c',
      credentialVersionHmacSha256: h('a'),
      runtimeFingerprintSha256: h('b'),
      privateDigestKeyVersion: 'evidence-key-v1',
      traceSha256: h('c'),
      videoSha256: null,
      operationOutcome: 'succeeded' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const discovery = buildDiscoveryReceiptV2({
      ...common,
      structuralSignatureSha256: h('d'),
      candidateSnapshotSha256: null,
    });
    expect(discovery.executionClass).toBe('discovery');
    expect('roleProofSha256' in discovery).toBe(false);

    const proof = buildProofReceiptV2({
      ...common,
      requestBranchId: 'quote_availability_search',
      candidateSnapshotSha256: h('e'),
      candidateHmacSha256: h('f'),
      scopeHmacSha256: h('1'),
      resultHmacSha256: h('2'),
      sourceRefHmacSha256: h('3'),
      roleProofSha256: h('4'),
      discoveryReceiptSha256: h('5'),
      oracleArtifactSha256: h('6'),
    });
    expect(proof.executionClass).toBe('proof');

    const root = await tempRoot();
    const artifact = join(root, randomUUID());
    await mkdir(artifact, { recursive: true });
    await writeBrowserArtifactReceiptV2(artifact, discovery);
    const loaded = await loadExclusiveReceipt(artifact);
    expect(loaded.schema).toBe('v2');
    expect(loaded.receipt).toMatchObject({ executionClass: 'discovery' });

    // v1 find path still works
    const store = await createHmsBrowserArtifactStore({ root });
    const handle = await store.beginCapture(baseSpec());
    await writeFile(join(handle.stagingDir, 'trace.zip'), validTraceZip());
    const receipt = await handle.finalize({
      sourceRevision: 'rev',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      outcome: 'succeeded',
      terminalCode: 'OK',
      terminalStage: 'receipt_finalize',
      requestRules: [],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      complete: true,
    });
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.executionClass).toBe('normal');
    await rm(root, { recursive: true, force: true });
  });

  it('writeBrowserArtifactReceiptV2 refuses when v1 receipt already present', async () => {
    const { writeBrowserArtifactReceiptV2, buildDiscoveryReceiptV2 } = await import(
      '../src/hms/browser-artifacts.js'
    );
    const { ExclusiveReceiptError } = await import('../src/hms/receipt-exclusivity.js');
    const h = (c: string) => c.repeat(64);
    const root = await tempRoot();
    const artifact = join(root, randomUUID());
    await mkdir(artifact, { recursive: true });
    await writeFile(
      join(artifact, 'receipt.v1.json'),
      `${JSON.stringify({ schemaVersion: 1, expiresAt: '2099-01-01T00:00:00.000Z' })}\n`,
    );

    const discovery = buildDiscoveryReceiptV2({
      artifactId: randomUUID(),
      operationId: randomUUID(),
      toolId: 'hms_quote_stay',
      discoveryOperationId: 'quote_availability_search',
      toolVersion: '1.0.0',
      sourceRevision: 'rev-11c-fix',
      credentialVersionHmacSha256: h('a'),
      runtimeFingerprintSha256: h('b'),
      privateDigestKeyVersion: 'evidence-key-v1',
      traceSha256: h('c'),
      videoSha256: null,
      operationOutcome: 'succeeded',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      structuralSignatureSha256: h('d'),
      candidateSnapshotSha256: null,
    });

    await expect(writeBrowserArtifactReceiptV2(artifact, discovery)).rejects.toBeInstanceOf(
      ExclusiveReceiptError,
    );
    await expect(writeBrowserArtifactReceiptV2(artifact, discovery)).rejects.toMatchObject({
      reason: 'dual',
    });
    await expect(stat(join(artifact, 'receipt.v2.json'))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
});
