/** Cookie-session GET for the Centurion lab index. File stays off public nginx. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Auth } from '../lib/auth.js';

export const DEFAULT_CENTURION_LAB_INDEX_PATH = '/var/lib/nava-pilot/lab-centurion-index.json';

export type CenturionLabIndexDeps = {
  getSession: (req: Request) => Promise<{ user: { id: string } } | null>;
  readIndex: () => Promise<Buffer | null>;
};

export function resolveCenturionLabIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CENTURION_LAB_INDEX_PATH?.trim() || DEFAULT_CENTURION_LAB_INDEX_PATH;
  if (!path.isAbsolute(raw)) {
    throw new Error('CENTURION_LAB_INDEX_PATH must be absolute');
  }
  return path.resolve(raw);
}

export async function readCenturionLabIndexFile(indexPath: string): Promise<Buffer | null> {
  const resolved = path.resolve(indexPath);
  const expected = path.resolve(resolveCenturionLabIndexPath());
  if (resolved !== expected) return null;
  try {
    const st = await fs.lstat(resolved);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return await fs.readFile(resolved);
  } catch {
    return null;
  }
}

export function createCenturionLabIndexHandler(deps: CenturionLabIndexDeps) {
  return async (req: Request): Promise<Response> => {
    const session = await deps.getSession(req);
    if (!session?.user?.id) return new Response(null, { status: 401 });
    const body = await deps.readIndex();
    if (!body) return new Response(null, { status: 404 });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  };
}

export function createWiredCenturionLabIndexHandler(auth: Auth) {
  const indexPath = resolveCenturionLabIndexPath();
  return createCenturionLabIndexHandler({
    getSession: async (req) => {
      const session = await auth.api.getSession({ headers: req.headers });
      const user = session?.user;
      if (!user?.id) return null;
      return { user: { id: user.id } };
    },
    readIndex: () => readCenturionLabIndexFile(indexPath),
  });
}
