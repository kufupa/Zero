import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { matchKey } from './party-match.js';

/**
 * The HMS company and agency list the sweep writes (scripts/party-index-sweep.ts). Staff search it instantly while
 * typing. A pick from it is only a candidate: the quote re-checks the id live in HMS before it binds.
 */

export type PartyIndexKind = 'company' | 'agency';

/** The only HMS properties that have a party index. Unknown codes stay unknown. */
export const PARTY_INDEX_PROPERTIES = ['HRCEN', 'HRDAV'] as const;
export type PartyIndexProperty = (typeof PARTY_INDEX_PROPERTIES)[number];

/** Results per kind. A broad name shows the best ten of each kind, so one kind cannot crowd out the other. */
export const PARTY_INDEX_CAP_PER_KIND = 10;

export function parsePartyIndexProperty(code: string | null | undefined): PartyIndexProperty | null {
  const value = String(code ?? '').trim().toUpperCase();
  return value === 'HRCEN' || value === 'HRDAV' ? value : null;
}

const plainNativeId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

export const partyIndexFileSchema = z
  .object({
    generatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'generatedAt must be a date'),
    entries: z
      .array(
        z
          .object({
            kind: z.enum(['company', 'agency']),
            nativeId: plainNativeId,
            name: z.string().trim().min(1).max(256),
          })
          .strict(),
      )
      .max(200_000),
  })
  .strict();
export type PartyIndexFile = z.infer<typeof partyIndexFileSchema>;
export type PartyIndexEntry = PartyIndexFile['entries'][number];

/** Where the index lives: the private pipeline root, beside the lookup output. One file per property. */
export function partyIndexPath(
  env: NodeJS.ProcessEnv = process.env,
  propertyCode: string = 'HRCEN',
): string {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const property = parsePartyIndexProperty(propertyCode);
  if (property === 'HRDAV') {
    const override = env.PARTY_INDEX_PATH_HRDAV?.trim();
    if (override) return override;
    return join(repoRoot, '.private/pms-pipeline/party-index/party-index-HRDAV.json');
  }
  if (property === 'HRCEN') {
    const override = env.PARTY_INDEX_PATH?.trim();
    if (override) return override;
    return join(repoRoot, '.private/pms-pipeline/party-index/party-index.json');
  }
  return join(repoRoot, '.private/pms-pipeline/party-index/unknown.json');
}

/** Progress beside the index. HRCEN keeps `party-index.progress.json`; HRDAV uses its own file. */
export function partyIndexProgressPath(indexPath: string, propertyCode: string = 'HRCEN'): string {
  if (parsePartyIndexProperty(propertyCode) === 'HRDAV') {
    return indexPath.replace(/\.json$/i, '.progress.json');
  }
  return join(dirname(indexPath), 'party-index.progress.json');
}

/** A private write: the file appears whole, with mode 600, under a 700 directory. Never a partial file. */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

let cache: { path: string; mtimeMs: number; size: number; index: PartyIndexFile } | null = null;

/**
 * The index at `path`, or null when there is no file or it does not parse against the schema. A null index means the
 * typeahead is off, so staff see the current behaviour. The parsed file is cached until its mtime or size changes.
 */
export async function loadPartyIndex(path: string = partyIndexPath()): Promise<PartyIndexFile | null> {
  let info: { mtimeMs: number; size: number };
  try {
    info = await stat(path);
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.path === path && cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.index;
  let parsed: z.SafeParseReturnType<unknown, PartyIndexFile>;
  try {
    parsed = partyIndexFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  cache = { path, mtimeMs: info.mtimeMs, size: info.size, index: parsed.data };
  return parsed.data;
}

/** 0 exact name, 1 starts with the query, 2 a word starts with the query, 3 contains it, 4 no match. */
export function indexRank(query: string, name: string): number {
  const wanted = matchKey(query);
  if (!wanted) return 4;
  const found = matchKey(name);
  if (found === wanted) return 0;
  if (found.startsWith(wanted)) return 1;
  if (` ${found}`.includes(` ${wanted}`)) return 2;
  if (found.includes(wanted)) return 3;
  return 4;
}

/** The best matches of each kind, companies first, ranked by match then name. Empty for an empty query. */
export function searchPartyIndex(
  index: PartyIndexFile,
  query: string,
  capPerKind: number = PARTY_INDEX_CAP_PER_KIND,
): PartyIndexEntry[] {
  if (!matchKey(query)) return [];
  const out: PartyIndexEntry[] = [];
  for (const kind of ['company', 'agency'] as const) {
    const ranked = index.entries
      .map((entry, position) => ({ entry, position, rank: indexRank(query, entry.name) }))
      .filter((row) => row.entry.kind === kind && row.rank < 4)
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.entry.name.localeCompare(right.entry.name, 'en') ||
          left.position - right.position,
      )
      .slice(0, capPerKind)
      .map((row) => ({ kind: row.entry.kind, nativeId: row.entry.nativeId, name: row.entry.name }));
    out.push(...ranked);
  }
  return out;
}

export type PartyIndexReply = {
  source: 'index';
  /** False when there is no index file. The picker then shows only the live search, as before. */
  available: boolean;
  updatedAt: string | null;
  /** Milliseconds since the sweep wrote the index. The picker words it as "updated <age>". */
  ageMs: number | null;
  results: PartyIndexEntry[];
};

const EMPTY_PARTY_INDEX: PartyIndexReply = {
  source: 'index',
  available: false,
  updatedAt: null,
  ageMs: null,
  results: [],
};

/** The typeahead answer for one query. Never reaches HMS: it reads the local file only. */
export async function typeaheadPartyIndex(
  query: string,
  options: { path?: string; now?: number; propertyCode?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PartyIndexReply> {
  let index: PartyIndexFile | null;
  if (options.path) {
    index = await loadPartyIndex(options.path);
  } else {
    const property = parsePartyIndexProperty(options.propertyCode ?? 'HRCEN');
    if (!property) return EMPTY_PARTY_INDEX;
    index = await loadPartyIndex(partyIndexPath(options.env ?? process.env, property));
  }
  if (!index) return EMPTY_PARTY_INDEX;
  const now = options.now ?? Date.now();
  const updated = Date.parse(index.generatedAt);
  return {
    source: 'index',
    available: true,
    updatedAt: index.generatedAt,
    ageMs: Math.max(0, now - updated),
    results: searchPartyIndex(index, query),
  };
}
