/**
 * Read-only access to a staff quote run's audit screenshots.
 *
 * fetch-quote.mjs writes each run to `<outputDir>/<ISO time with : and . as ->-<8 hex>/`
 * with PNGs under `screenshots/`. Callers pass a run id and a screenshot name, never
 * a path. Both are matched against strict patterns, the name must be a regular PNG
 * that exists in that run's screenshots directory, and symlinks are refused.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';

export const QUOTE_RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
export const QUOTE_SCREENSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.png$/;
export const QUOTE_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export type QuoteRunScreenshot =
  | { status: 'ready'; name: string; mimeType: 'image/png'; sizeBytes: number; dataUrl: string }
  | { status: 'unavailable'; reason: 'invalid_request' | 'not_found' | 'too_large' | 'unreadable' };

function screenshotsDirectory(outputDir: string, runId: string): string {
  return join(resolve(outputDir), runId, 'screenshots');
}

/** The run id for an evidence directory the capture tool created directly under outputDir. */
export function quoteRunIdFromEvidenceDirectory(
  outputDir: string,
  evidenceDirectory: string,
): string | null {
  const root = resolve(outputDir);
  const directory = resolve(evidenceDirectory);
  if (dirname(directory) !== root) return null;
  const runId = basename(directory);
  return QUOTE_RUN_ID_PATTERN.test(runId) ? runId : null;
}

/** Names of the regular PNG files that exist for one run. Empty when the run is missing. */
export async function listQuoteRunScreenshots(outputDir: string, runId: string): Promise<string[]> {
  if (!QUOTE_RUN_ID_PATTERN.test(runId)) return [];
  const directory = screenshotsDirectory(outputDir, runId);
  try {
    const runInfo = await lstat(dirname(directory));
    const shotsInfo = await lstat(directory);
    if (!runInfo.isDirectory() || !shotsInfo.isDirectory()) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && QUOTE_SCREENSHOT_NAME_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function readQuoteRunScreenshot(input: {
  outputDir: string;
  runId: string;
  name: string;
}): Promise<QuoteRunScreenshot> {
  if (!QUOTE_RUN_ID_PATTERN.test(input.runId) || !QUOTE_SCREENSHOT_NAME_PATTERN.test(input.name))
    return { status: 'unavailable', reason: 'invalid_request' };
  const names = await listQuoteRunScreenshots(input.outputDir, input.runId);
  if (!names.includes(input.name)) return { status: 'unavailable', reason: 'not_found' };
  const path = join(screenshotsDirectory(input.outputDir, input.runId), input.name);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { status: 'unavailable', reason: 'not_found' };
    if (info.size > QUOTE_SCREENSHOT_MAX_BYTES)
      return { status: 'unavailable', reason: 'too_large' };
    const bytes = await readFile(path);
    if (bytes.length > QUOTE_SCREENSHOT_MAX_BYTES)
      return { status: 'unavailable', reason: 'too_large' };
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
      return { status: 'unavailable', reason: 'unreadable' };
    return {
      status: 'ready',
      name: input.name,
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    };
  } catch {
    return { status: 'unavailable', reason: 'not_found' };
  }
}
