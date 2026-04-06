import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';

const DEFAULT_LOCAL_PG = 'postgresql://postgres:postgres@localhost:5432/zerodotemail';

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Full copy of `wrangler.jsonc` with Hyperdrive `localConnectionString` set from DATABASE_URL.
 * Using a merged second config broke `wrangler dev` (two Workers / missing entry). Dev uses only this file when present.
 */
export async function writeWranglerLocalHyperdrive(root: string, envFileContent: string) {
  const vars = parseDotEnv(envFileContent);
  const databaseUrl = vars.DATABASE_URL?.trim() || DEFAULT_LOCAL_PG;
  const wranglerPath = join(root, 'apps/server/wrangler.jsonc');
  let text = await readFile(wranglerPath, 'utf8');
  if (!/"localConnectionString"\s*:/.test(text)) {
    throw new Error('apps/server/wrangler.jsonc: expected a localConnectionString field for Hyperdrive');
  }
  const replacement = `"localConnectionString": ${JSON.stringify(databaseUrl)}`;
  text = text.replace(/"localConnectionString"\s*:\s*"[^"]*"/, replacement);
  const target = join(root, 'apps/server/wrangler.local.jsonc');
  await writeFile(target, text, 'utf8');
}
