import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { skillNames, skillReadDefinition } from './schema.js';
import type { SkillName } from './schema.js';

export type ToolContext = {
  sessionId: string;
  mode: 'live' | 'labtest' | 'historical';
  signal?: AbortSignal;
  // Server-owned, session-persisted config; never supplied by the model.
  skillConfig?: SkillConfig;
};
export type ToolResult = {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' } | null;
};
export type SkillPin = { version: string; files: Record<string, string> };
export type SkillConfig = { root: string; pin: SkillPin };

type SkillRequest = { skill_name: SkillName; path?: string };
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const pinVersion = (files: Record<string, string>) => sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const filePath = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`;

// Linux dirfd traversal prevents a renamed directory or symlink from escaping the root.
async function withRoot<T>(root: string, fn: (dir: FileHandle) => Promise<T>): Promise<T> {
  if (!isAbsolute(root)) throw new Error('Root must be absolute');
  const canonical = await realpath(root);
  const dir = await open(canonical, dirFlags);
  try { return await fn(dir); } finally { await dir.close(); }
}

async function readAt(root: FileHandle, path: string): Promise<Buffer> {
  const parts = path.split('/');
  let current = root;
  const opened: FileHandle[] = [];
  try {
    for (const [index, part] of parts.entries()) {
      const child = await open(filePath(current, part), index === parts.length - 1 ? fileFlags : dirFlags);
      opened.push(child);
      current = child;
    }
    if (!(await current.stat()).isFile()) throw new Error('Not a regular file');
    return await current.readFile();
  } finally {
    for (const handle of opened.reverse()) await handle.close();
  }
}

async function collect(dir: FileHandle, prefix: string, files: Record<string, string>): Promise<void> {
  const entries = await readdir(`/proc/self/fd/${dir.fd}`, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in skill trees');
    if (entry.isDirectory()) {
      const child = await open(filePath(dir, entry.name), dirFlags);
      try { await collect(child, path, files); } finally { await child.close(); }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const child = await open(filePath(dir, entry.name), fileFlags);
      try {
        if (!(await child.stat()).isFile()) throw new Error('Not a regular file');
        files[path] = sha256(await child.readFile());
      } finally { await child.close(); }
    }
  }
}

/** Pin at session creation; persist this result and supply it unchanged on every read. */
export async function pinSkills(root: string): Promise<SkillPin> {
  return withRoot(root, async dir => {
    const files: Record<string, string> = {};
    for (const name of skillNames) {
      const skill = await open(filePath(dir, name), dirFlags);
      try {
        files[`${name}/SKILL.md`] = sha256(await readAt(skill, 'SKILL.md'));
        const references = await open(filePath(skill, 'references'), dirFlags);
        try { await collect(references, `${name}/references`, files); } finally { await references.close(); }
      } finally { await skill.close(); }
    }
    const shared = await open(filePath(dir, 'references'), dirFlags);
    try { await collect(shared, 'references', files); } finally { await shared.close(); }
    return { version: pinVersion(files), files };
  });
}

function parseRequest(input: unknown): SkillRequest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const obj = Object.fromEntries(Object.entries(input));
  if (Object.keys(obj).some(key => key !== 'skill_name' && key !== 'path')) return null;
  const name = skillNames.find(value => value === obj.skill_name);
  if (!name || (obj.path !== undefined && typeof obj.path !== 'string')) return null;
  return { skill_name: name, ...(obj.path === undefined ? {} : { path: obj.path }) };
}

function requestedPath(request: SkillRequest): string | null {
  const relative = request.path ?? 'SKILL.md';
  if (!relative || relative.includes('\0') || relative.includes('\\') || posix.isAbsolute(relative)) return null;
  const path = posix.normalize(`${request.skill_name}/${relative}`);
  if (path !== `${request.skill_name}/SKILL.md` && !path.startsWith(`${request.skill_name}/references/`) && !path.startsWith('references/')) return null;
  return path.endsWith('.md') ? path : null;
}

function failure(code: string, message: string): ToolResult {
  return { ok: false, data: null, error: { code, message, retryable: false, outcome: 'known' } };
}

/** Context is server controlled; untrusted input contains only skill_name and path. */
export async function skillRead(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context.signal?.aborted) return failure('ABORTED', 'Skill read aborted.');
  const request = parseRequest(input);
  if (!request) return failure('INVALID_INPUT', 'Expected skill_name and optional relative path.');
  const path = requestedPath(request);
  if (!path) return failure('SKILL_REFERENCE_UNAVAILABLE', 'Skill reference unavailable in pinned tree.');
  const config = context.skillConfig;
  if (!config || !config.pin || !config.pin.files || typeof config.pin.version !== 'string') return failure('SKILL_CONFIG_UNAVAILABLE', 'Pinned skill configuration unavailable.');
  try {
    if (!/^[a-f0-9]{64}$/.test(config.pin.version) || pinVersion(config.pin.files) !== config.pin.version) return failure('SKILL_PIN_INVALID', 'Pinned skill configuration is invalid.');
    if (!Object.hasOwn(config.pin.files, path) || !/^[a-f0-9]{64}$/.test(config.pin.files[path])) return failure('SKILL_REFERENCE_UNAVAILABLE', 'Skill reference unavailable in pinned tree.');
    const bytes = await withRoot(config.root, dir => readAt(dir, path));
    if (context.signal?.aborted) return failure('ABORTED', 'Skill read aborted.');
    if (sha256(bytes) !== config.pin.files[path]) return failure('SKILL_CONTENT_CHANGED', 'Skill content differs from the pinned version.');
    return { ok: true, data: { skill_name: request.skill_name, path, version: config.pin.version, text: bytes.toString('utf8') }, error: null };
  } catch {
    return failure('SKILL_REFERENCE_UNAVAILABLE', 'Skill reference unavailable in pinned tree.');
  }
}

export const tools = [{ ...skillReadDefinition, run: skillRead }];

/** Bind trusted, session-specific configuration without extending the runtime's tool context. */
export function createSkillTools(config: SkillConfig) {
  return [{ ...skillReadDefinition, run: (input: unknown, context: ToolContext) =>
    skillRead(input, { ...context, skillConfig: config }) }];
}
