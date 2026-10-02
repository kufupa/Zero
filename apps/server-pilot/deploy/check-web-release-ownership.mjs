import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nginx permits same-origin scripts, so the release and any old hashed asset
 * fallback must not be mutable by the non-root application user. The CLI
 * always requires root ownership; optional parameters only make fixtures
 * possible without creating root-owned files on a development machine.
 */
export function verifyWebReleaseOwnership(webRoot, {
  trustedUid = 0,
  top = path.parse(path.resolve(webRoot)).root,
  ancestorsOnly = false,
} = {}) {
  if (!path.isAbsolute(webRoot)) throw new Error('Web release root must be absolute');
  const root = path.resolve(webRoot);
  const trustedTop = path.resolve(top);
  const relative = path.relative(trustedTop, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Web release root must be inside its trusted ancestor');

  const inspect = (target, expectedUid = trustedUid) => {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) throw new Error(`Web release symlink is forbidden: ${target}`);
    if (metadata.uid !== expectedUid) throw new Error(`Untrusted web release owner: ${target}`);
    if ((metadata.mode & 0o022) !== 0) throw new Error(`Writable web release path: ${target}`);
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error(`Unsupported web release file: ${target}`);
    return metadata;
  };

  // Include /var/www (or every configured ancestor) so an app-owned parent
  // cannot replace an otherwise root-owned `releases` directory after publish.
  for (let current = ancestorsOnly ? path.dirname(root) : root; ; current = path.dirname(current)) {
    if (!inspect(current).isDirectory()) throw new Error(`Web release parent is not a directory: ${current}`);
    if (current === trustedTop) break;
  }
  if (ancestorsOnly) return;

  const visit = (target) => {
    const metadata = inspect(target);
    if (!metadata.isDirectory()) return;
    for (const name of readdirSync(target)) {
      const child = path.join(target, name);
      if (target === root && name === 'downloads') {
        // The installer-download directory is managed separately by www-data;
        // never allow it to be a symlink or group/world writable. Its EXE
        // checksum and publisher trust are separate, supervised release gates.
        const download = lstatSync(child);
        if (download.isSymbolicLink() || !download.isDirectory())
          throw new Error(`Web release symlink or invalid downloads directory: ${child}`);
        if ((download.mode & 0o022) !== 0) throw new Error(`Writable web release downloads directory: ${child}`);
      } else {
        visit(child);
      }
    }
  };
  visit(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, webRoot] = process.argv.slice(2);
  if (!webRoot || !['ancestors', 'release'].includes(mode)) {
    console.error('usage: check-web-release-ownership.mjs ancestors|release /absolute/web/root');
    process.exitCode = 2;
  } else {
    try {
      verifyWebReleaseOwnership(webRoot, { ancestorsOnly: mode === 'ancestors' });
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Web release ownership validation failed');
      process.exitCode = 1;
    }
  }
}
