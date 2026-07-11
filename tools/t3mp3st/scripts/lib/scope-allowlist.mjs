/**
 * EC2-pilot audit scope — read-only paths for xAI swarm tools.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const EXCLUDE_PARTS = [
  '/node_modules/',
  '/dist/',
  '/.next/',
  '/drizzle/',
  '/tests/',
  '/deploy/',
  '/src/ai/',
  '/ai/',
];

export const DEFAULT_SCOPE_ROOTS = ['apps/server-pilot/src', 'apps/mail'];

export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i);
    const v = t.slice(i + 1).replace(/^["']|["']$/g, '');
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

export function relPosix(repoRoot, absPath) {
  return relative(repoRoot, absPath).replace(/\\/g, '/');
}

export function isPathInScope(repoRoot, candidatePath, scopeRoots = DEFAULT_SCOPE_ROOTS) {
  const abs = resolve(repoRoot, candidatePath);
  const rel = relPosix(repoRoot, abs);
  if (!rel || rel.startsWith('..')) return false;
  const norm = `/${rel}/`;
  if (EXCLUDE_PARTS.some((x) => norm.includes(x))) return false;
  if (norm.includes('/apps/server-pilot/src/ai/')) return false;
  return scopeRoots.some((root) => rel === root || rel.startsWith(`${root}/`));
}

export function walkTsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

export function collectScopedFiles(repoRoot, scopeRoots = DEFAULT_SCOPE_ROOTS) {
  const files = [];
  for (const root of scopeRoots) {
    const abs = join(repoRoot, root);
    for (const f of walkTsFiles(abs)) {
      if (isPathInScope(repoRoot, f, scopeRoots)) files.push(f);
    }
  }
  return [...new Set(files)];
}
