import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { READ_TOOL_IDS, type ReadToolId } from './read-tools.js';
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
    operationId: uuid.optional(),
    sourceRevision: z.string().min(1).max(256).optional(),
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
    complete: z.boolean().optional(),
    digestValid: z.boolean().optional(),
    sensitiveMediaExpiresAt: z.string().datetime().optional(),
    accessAudit: z
      .object({
        lastFetchAt: z.string().datetime().nullable(),
        fetchCount: z.number().int().nonnegative(),
        confirmSensitiveCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
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

/** Sync load for status/operator — missing/invalid → empty (never invent IDs). */
export function loadProtectedArtifactIndexSync(
  path: string,
): HmsProtectedArtifactIndexEntryV1[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return hmsProtectedArtifactIndexV1Schema.parse(raw).entries;
  } catch {
    return [];
  }
}

/**
 * Usable private artifact UUIDs for a tool (optionally scoped to release).
 * IDs only — no guest/mail/credential values.
 */
export function privateArtifactIdsForTool(
  entries: readonly HmsProtectedArtifactIndexEntryV1[],
  toolId: ReadToolId,
  options: { releaseId?: string | null; now?: Date } = {},
): string[] {
  const nowMs = (options.now ?? new Date()).getTime();
  const releaseId = options.releaseId ?? null;
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.toolId !== toolId) continue;
    if (releaseId && entry.releaseId && entry.releaseId !== releaseId) continue;
    if (entry.complete === false || entry.digestValid === false) continue;
    const expires = Date.parse(entry.expiresAt);
    if (Number.isFinite(expires) && expires <= nowMs) continue;
    ids.push(entry.artifactId);
  }
  return [...new Set(ids)];
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
