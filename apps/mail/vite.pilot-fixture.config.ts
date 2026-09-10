import {
  createExistingDocumentService,
  type ExistingDocumentRecord,
  type ExistingDocumentSource,
} from '../server-pilot/src/mail/artifacts/existing-document-service.js';
import type { ArtifactReadResult } from '../server-pilot/src/mail/artifacts/read-artifact.js';
import { defineConfig as defineViteConfig, type Plugin, type UserConfig } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlaywrightTestConfig } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import tailwindcss from '@tailwindcss/vite';

export const pilotFixtureContract = {
  mode: 'fixture',
  envFiles: false,
  liveBindings: false,
  externalSockets: false,
  networkPolicy: 'loopback-only',
  transport: 'fake',
  allowedOrigins: ['http://127.0.0.1:4179'],
  publicOrigin: 'http://127.0.0.1:4179',
} as const;

const DOCUMENT_SCOPE = {
  scopeRef: 'scope:fixture-documents',
  propertyRef: 'fixture-property',
  guestRef: 'guest:fixture-authorized',
  stayStart: '2026-09-10',
  stayEnd: '2026-09-12',
  payerRef: 'payer:fixture',
  requestedKind: 'tax_invoice' as const,
  requestedPriceVisibility: 'allowed' as const,
};
const DOCUMENT_FIXTURE_ORIGIN = 'http://127.0.0.1:4179';
const DOCUMENT_LIST_PATH = '/api/trpc/documents.listExisting';
const DOCUMENT_READ_PATH = '/api/trpc/documents.readExisting';
const DOCUMENT_MAX_REQUEST_BYTES = 64 * 1024;
const DOCUMENT_MAX_TEXT_BYTES = 256 * 1024;

function fixtureSha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function fixtureDocumentRecord(input: {
  sourceRecordId: string;
  source?: ExistingDocumentRecord['source'];
  propertyRef: string;
  guestRef: string | null;
  body: Buffer | null;
  attachmentId?: string;
  messageId?: string;
}): ExistingDocumentRecord {
  const bodyHash = input.body ? fixtureSha256(input.body) : null;
  const attachmentId = input.attachmentId ?? input.sourceRecordId;
  const messageId = input.messageId ?? `fixture-message-${input.sourceRecordId}`;
  return {
    sourceRecordId: input.sourceRecordId,
    scopeRef: DOCUMENT_SCOPE.scopeRef,
    source: input.source ?? 'mail_attachment',
    kind: 'tax_invoice',
    version: input.body ? 'v2' : 'metadata-only',
    issuedAt: '2026-09-08T12:00:00.000Z',
    status: input.body ? 'final' : 'unknown',
    parentRef: input.body ? `parent:${input.sourceRecordId}` : null,
    payerRef: input.body ? 'payer:fixture' : null,
    displayName: input.body ? `${input.sourceRecordId}.txt` : 'pms-finalized-metadata.txt',
    mime: input.body ? 'text/plain' : 'text/plain',
    sizeBytes: input.body?.byteLength ?? null,
    sha256: bodyHash,
    priceVisibility: input.body ? 'hidden' : 'unknown',
    propertyRef: input.propertyRef,
    guestRef: input.guestRef,
    stayStart: input.body ? '2026-09-10' : null,
    stayEnd: input.body ? '2026-09-12' : null,
    currentVersion: input.body !== null,
    ...(input.body
      ? {
          attachment: {
            attachmentId,
            authorizedAttachmentIds: new Set([attachmentId]),
            locator: {
              s3Key: `attachments/${messageId}/${input.sourceRecordId}.txt`,
              mimeType: 'text/plain',
              sizeBytes: input.body.byteLength,
              messageId,
            },
          },
        }
      : {}),
  };
}

function fixtureArtifactResult(
  attachmentId: string,
  body: Buffer | null,
  now: Date,
): ArtifactReadResult {
  const sourceHash = body ? fixtureSha256(body) : null;
  const evidence = {
    kind: 'mail_attachment' as const,
    id: randomUUID(),
    toolId: 'mail_read_artifact' as const,
    toolVersion: 'fixture-bridge',
    attachmentId,
    observedAt: now.toISOString(),
    sourceHash,
    claimKeys: [],
  };
  if (!body || body.byteLength > DOCUMENT_MAX_TEXT_BYTES) {
    return {
      status: 'manual_required',
      draftReady: false,
      data: {
        mimeType: 'text/plain',
        text: null,
        pageCount: null,
        reason: body ? 'too_large' : 'malformed',
      },
      unresolvedFields: ['attachment.text'],
      evidence,
    };
  }
  return {
    status: 'ok',
    draftReady: false,
    data: {
      mimeType: 'text/plain',
      text: body.toString('utf8'),
      pageCount: null,
      reason: 'text',
    },
    unresolvedFields: [],
    evidence,
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > DOCUMENT_MAX_REQUEST_BYTES) {
        reject(new Error('DOCUMENT_REQUEST_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseDocumentProcedureBody(body: string): unknown {
  const parsed = JSON.parse(body) as unknown;
  const envelope = Array.isArray(parsed)
    ? parsed.length === 1
      ? parsed[0]
      : undefined
    : parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 1 &&
        '0' in parsed
      ? (parsed as Record<string, unknown>)['0']
      : undefined;
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    !('json' in envelope) ||
    !envelope.json ||
    typeof envelope.json !== 'object' ||
    Array.isArray(envelope.json) ||
    Object.keys(envelope).some((key) => key !== 'json')
  ) {
    throw new Error('INVALID_DOCUMENT_REQUEST_ENVELOPE');
  }
  return envelope.json;
}

function writeDocumentResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function documentServiceFixturePlugin(): Plugin {
  return {
    name: 'reservation-tools-pilot-document-service-fixture',
    configureServer(server) {
      const authorizedBody = Buffer.from(
        'Authorized fixture invoice — synthetic bytes only.\nProperty fixture-property\nGuest guest:fixture-authorized\n',
        'utf8',
      );
      const reviewBody = Buffer.from(
        'Review-only fixture text — identity remains unverified.\nProperty other-property\n',
        'utf8',
      );
      const bodyByAttachment = new Map([
        ['fixture-authorized-invoice', authorizedBody],
        ['fixture-identity-review', reviewBody],
      ]);
      const records = [
        fixtureDocumentRecord({
          sourceRecordId: 'fixture-authorized-invoice',
          propertyRef: 'fixture-property',
          guestRef: 'guest:fixture-authorized',
          body: authorizedBody,
          attachmentId: 'fixture-authorized-invoice',
          messageId: 'fixture-message-authorized',
        }),
        fixtureDocumentRecord({
          sourceRecordId: 'fixture-identity-review',
          propertyRef: 'other-property',
          guestRef: 'guest:fixture-authorized',
          body: reviewBody,
          attachmentId: 'fixture-identity-review',
          messageId: 'fixture-message-review',
        }),
      ];
      const pmsMetadataRecord = fixtureDocumentRecord({
        sourceRecordId: 'fixture-pms-metadata-only',
        source: 'hms_finalized_document',
        propertyRef: 'fixture-property',
        guestRef: null,
        body: null,
      });
      const source = (
        sourceName: ExistingDocumentRecord['source'],
        sourceRecords: ExistingDocumentRecord[],
        blocker?: string,
      ): ExistingDocumentSource => ({
        source: sourceName,
        list: async () => ({
          records: sourceRecords,
          inventoryComplete: true,
          ...(blocker ? { blocker } : {}),
        }),
      });
      const documentService = createExistingDocumentService({
        now: () => new Date('2026-09-08T12:00:00.000Z'),
        resolveScope: async (scopeRef) =>
          scopeRef === DOCUMENT_SCOPE.scopeRef ? DOCUMENT_SCOPE : null,
        sources: {
          mail_attachment: source('mail_attachment', records),
          hms_finalized_document: source(
            'hms_finalized_document',
            [pmsMetadataRecord],
            'SURFACE_UNPROVEN',
          ),
        },
        readArtifact: async (attachment) =>
          fixtureArtifactResult(
            attachment.attachmentId,
            bodyByAttachment.get(attachment.attachmentId) ?? null,
            new Date('2026-09-08T12:00:00.000Z'),
          ),
      });

      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', DOCUMENT_FIXTURE_ORIGIN);
        if (
          requestUrl.pathname !== DOCUMENT_LIST_PATH &&
          requestUrl.pathname !== DOCUMENT_READ_PATH
        ) {
          next();
          return;
        }
        if (
          req.method !== 'POST' ||
          req.headers.host !== '127.0.0.1:4179' ||
          req.headers.origin !== DOCUMENT_FIXTURE_ORIGIN ||
          !String(req.headers['content-type'] ?? '')
            .toLowerCase()
            .startsWith('application/json')
        ) {
          writeDocumentResponse(res, 400, { error: { code: 'BAD_REQUEST' } });
          return;
        }
        try {
          const input = parseDocumentProcedureBody(await readRequestBody(req));
          const result =
            requestUrl.pathname === DOCUMENT_LIST_PATH
              ? await documentService.documents_list_existing(input as never)
              : await documentService.documents_read_existing(input as never);
          writeDocumentResponse(res, 200, [{ result: { data: { json: result } } }]);
        } catch {
          writeDocumentResponse(res, 400, { error: { code: 'BAD_REQUEST' } });
        }
      });
    },
  };
}

function defineConfig<T extends UserConfig & PlaywrightTestConfig>(config: T): T {
  return Object.assign(defineViteConfig(config), config);
}

export default defineConfig({
  envDir: '/dev/null',
  root: 'tests/e2e/fixture',
  plugins: [tailwindcss(), documentServiceFixturePlugin()],
  resolve: {
    alias: {
      '@': '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/apps/mail',
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4179,
    strictPort: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  expect: {
    timeout: 20_000,
  },
  outputDir:
    '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-dashboard-tools-execution/u11a-browser-artifacts',
  use: {
    trace: 'on',
    video: 'on',
    screenshot: 'on',
  },
  testDir: 'tests/e2e',
  webServer: {
    command: 'pnpm exec vite --config vite.pilot-fixture.config.ts',
    port: 4179,
    timeout: 30_000,
    reuseExistingServer: false,
  },
} satisfies UserConfig & PlaywrightTestConfig);
