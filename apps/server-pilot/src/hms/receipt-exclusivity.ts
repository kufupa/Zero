/**
 * Exactly-one receipt resolution for HMS browser artifact directories.
 * Dependency-free so purge, transfer, and index readers can share it.
 */
import { lstatSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export type ExclusiveReceiptFile = { schema: 'v1' | 'v2'; path: string };

/**
 * Zero and dual receipts are both refusals, but callers must tell them apart:
 * a missing receipt may be aged out, an ambiguous pair must never be destroyed.
 */
export class ExclusiveReceiptError extends Error {
  constructor(readonly reason: 'missing' | 'dual' | 'irregular_file') {
    super(
      reason === 'irregular_file'
        ? 'receipt must be a regular file'
        : `artifact directory must contain exactly one receipt (${reason})`,
    );
    this.name = 'ExclusiveReceiptError';
  }
}

function receiptCandidates(dir: string): ExclusiveReceiptFile[] {
  return [
    { schema: 'v1', path: join(dir, 'receipt.v1.json') },
    { schema: 'v2', path: join(dir, 'receipt.v2.json') },
  ];
}

function selectExclusive(present: ExclusiveReceiptFile[]): ExclusiveReceiptFile {
  if (present.length === 0) throw new ExclusiveReceiptError('missing');
  if (present.length > 1) throw new ExclusiveReceiptError('dual');
  return present[0]!;
}

/** Resolve the single receipt file without parsing it (purge / transfer paths). */
export async function resolveExclusiveReceiptFile(
  dir: string,
): Promise<ExclusiveReceiptFile> {
  const present: ExclusiveReceiptFile[] = [];
  for (const candidate of receiptCandidates(dir)) {
    const info = await lstat(candidate.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ExclusiveReceiptError('irregular_file');
    }
    present.push(candidate);
  }
  return selectExclusive(present);
}

/** Synchronous resolver for operator CLI paths that cannot await. */
export function resolveExclusiveReceiptFileSync(dir: string): ExclusiveReceiptFile {
  const present: ExclusiveReceiptFile[] = [];
  for (const candidate of receiptCandidates(dir)) {
    let info;
    try {
      info = lstatSync(candidate.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ExclusiveReceiptError('irregular_file');
    }
    present.push(candidate);
  }
  return selectExclusive(present);
}
