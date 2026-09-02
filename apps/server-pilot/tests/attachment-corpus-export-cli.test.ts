import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCenturionThreadCorpusLiveExportCommand } from '../scripts/export-centurion-thread-corpus-live.js';

function dependencies(
  args: readonly string[],
  seen: { retain?: boolean; retainRawMime?: boolean; errors: string[]; output: string[] },
  malformedAttachmentDescriptorCount?: number,
) {
  return {
    args: () => args,
    platform: () => 'linux',
    scriptPath: () =>
      path.resolve(
        process.cwd(),
        'scripts/export-centurion-thread-corpus-live.ts',
      ),
    attestImdsV2: async () => true,
    preflightOutputDestination: async () => undefined,
    uuid: () => '00000000-0000-4000-8000-000000000001',
    environment: () => ({
      DATABASE_URL: 'fixture://non-production',
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'fixture-bucket',
    }),
    createReader: () => {
      throw new Error('reader should not be constructed by this seam');
    },
    createRealStorage: () => ({
      kind: 'real' as const,
      getObjectBounded: async () => null,
    }),
    createExporter:
      () =>
      async (request: {
        hydration: {
          retainAttachmentBytes?: boolean;
          retainRawMime?: boolean;
          attachmentConcurrency?: number;
        };
        outDir: string;
      }) => {
        seen.retain = request.hydration.retainAttachmentBytes;
        seen.retainRawMime = request.hydration.retainRawMime;
        seen.concurrency = request.hydration.attachmentConcurrency;
        return {
          outDir: request.outDir,
          summary: {
            asOf: '2026-08-31T12:00:00.000Z',
            includedMessageCount: 1,
            sourceRowCount: 1,
            threadCount: 1,
            ...(malformedAttachmentDescriptorCount === undefined
              ? {}
              : { malformedAttachmentDescriptorCount }),
          },
        };
      },
    validateAllocatedDir: () => undefined,
    writeStdout: (value: string) => seen.output.push(value),
    writeStderr: (value: string) => seen.errors.push(value),
  };
}

describe('attachment-inclusive live exporter CLI', () => {
  it('accepts attachment mode and requests bounded original bytes', async () => {
    const seen = { errors: [], output: [] } as {
      retain?: boolean;
      retainRawMime?: boolean;
      concurrency?: number;
      errors: string[];
      output: string[];
    };
    const code = await createCenturionThreadCorpusLiveExportCommand(
      dependencies(['--mode', 'attachment-inclusive'], seen),
    )();
    expect(code).toBe(0);
    expect(seen.retain).toBe(true);
    expect(seen.retainRawMime).toBe(false);
    expect(seen.concurrency).toBe(4);
    expect(seen.errors).toEqual([]);
  });

  it('rejects unknown modes before host or storage preflight', async () => {
    const seen = { errors: [], output: [] } as {
      retain?: boolean;
      retainRawMime?: boolean;
      errors: string[];
      output: string[];
    };
    const code = await createCenturionThreadCorpusLiveExportCommand(
      dependencies(['--mode', 'production'], seen),
    )();
    expect(code).toBe(1);
    expect(seen.errors.join('')).toContain('invalid_arguments');
    expect(seen.retain).toBeUndefined();
  });

  it('keeps the opaque malformed-descriptor count in the safe summary', async () => {
    const seen = { errors: [], output: [] } as {
      retain?: boolean;
      retainRawMime?: boolean;
      concurrency?: number;
      errors: string[];
      output: string[];
    };
    const code = await createCenturionThreadCorpusLiveExportCommand(
      dependencies([], seen, 2),
    )();

    expect(code).toBe(0);
    expect(seen.output).toEqual([
      `${JSON.stringify({
        includedMessageCount: 1,
        sourceRowCount: 1,
        threadCount: 1,
        malformedAttachmentDescriptorCount: 2,
      })}\n`,
    ]);
  });
});
