import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { READ_TOOL_IDS } from './read-tools.js';
import { hmsBrowserArtifactReceiptV2Schema } from './release-kernel.js';
import { resolveExclusiveReceiptFile } from './receipt-exclusivity.js';

export {
  ExclusiveReceiptError,
  resolveExclusiveReceiptFile,
  resolveExclusiveReceiptFileSync,
  type ExclusiveReceiptFile,
} from './receipt-exclusivity.js';

const uuid = z.string().uuid();

export const hmsProtectedArtifactIndexEntryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: uuid,
    toolId: z.enum(READ_TOOL_IDS),
    toolVersion: z.string().min(1).max(64),
    releaseId: uuid.optional(),
    kinds: z
      .array(
        z.enum([
          'receipt',
          'trace',
          'video',
          'role_proof',
          'discovery',
          'live_proof',
          'shadow',
          'negative_certificate',
        ]),
      )
      .min(1),
    receiptSchema: z.enum(['v1', 'v2']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const hmsProtectedArtifactIndexV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(hmsProtectedArtifactIndexEntryV1Schema),
  })
  .strict();

export type HmsProtectedArtifactIndexEntryV1 = z.infer<
  typeof hmsProtectedArtifactIndexEntryV1Schema
>;

async function atomicProtectedWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: 'w',
  });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function writeProtectedArtifactIndex(
  path: string,
  entries: readonly HmsProtectedArtifactIndexEntryV1[],
): Promise<void> {
  const index = hmsProtectedArtifactIndexV1Schema.parse({
    schemaVersion: 1,
    entries,
  });
  await atomicProtectedWrite(path, index);
}

export type ExclusiveReceipt =
  | { schema: 'v1'; path: string; receipt: Record<string, unknown> }
  | {
      schema: 'v2';
      path: string;
      receipt: z.infer<typeof hmsBrowserArtifactReceiptV2Schema>;
    };

export async function loadExclusiveReceipt(dir: string): Promise<ExclusiveReceipt> {
  const selected = await resolveExclusiveReceiptFile(dir);
  const raw = JSON.parse(await readFile(selected.path, 'utf8')) as unknown;
  if (selected.schema === 'v2') {
    return {
      schema: 'v2',
      path: selected.path,
      receipt: hmsBrowserArtifactReceiptV2Schema.parse(raw),
    };
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).schemaVersion !== 1
  ) {
    throw new Error('receipt.v1.json schemaVersion mismatch');
  }
  return {
    schema: 'v1',
    path: selected.path,
    receipt: raw as Record<string, unknown>,
  };
}
