#!/usr/bin/env node
// Render and verify one Nginx candidate against the exact staged SPA bytes.
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Hash the entire publishable client tree, including directory names; downloads
// are reserved for the separately managed Windows installer.
function clientTree(root) {
  if (!lstatSync(root).isDirectory())
    throw new Error('client tree must be a directory, not a symlink');
  const records = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const path = relative(root, file);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`client tree contains a symlink: ${path}`);
      if (stat.isDirectory()) {
        if (path === 'downloads') throw new Error('client tree cannot contain managed downloads');
        records.push([`${path}/`, null]);
        visit(file);
      } else if (stat.isFile()) {
        records.push([path, createHash('sha256').update(readFileSync(file)).digest('hex')]);
      } else {
        throw new Error(`client tree contains a non-regular file: ${path}`);
      }
    }
  }
  visit(root);
  const indexHash = records.find(([path]) => path === 'index.html')?.[1];
  if (!indexHash) throw new Error('client tree is missing a regular index.html');
  // JSON-encoded records make filenames unambiguous even with whitespace/newlines.
  const digest = createHash('sha256');
  for (const record of records.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    digest.update(JSON.stringify(record)).update('\n');
  }
  return { id: digest.digest('hex'), indexHash };
}

function hashedAssets(root, publicRoot) {
  if (!lstatSync(root).isDirectory()) throw new Error('assets must be a directory, not a symlink');
  if (!lstatSync(publicRoot).isDirectory())
    throw new Error('public assets must be a directory, not a symlink');
  const paths = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const path = relative(root, file);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`assets contain a symlink: ${path}`);
      if (stat.isDirectory()) visit(file);
      else if (!stat.isFile()) throw new Error(`assets contain a non-regular file: ${path}`);
      else if (/-[\w-]{8}\.(?:js|css|woff2?|svg|png|jpe?g|webp|avif|wasm)$/.test(name)) {
        const publicFile = join(publicRoot, path);
        const publicStat = lstatSync(publicFile, { throwIfNoEntry: false });
        if (publicStat) {
          if (!publicStat.isFile() || !readFileSync(publicFile).equals(readFileSync(file))) {
            throw new Error(`public asset is not the exact staged regular file: ${path}`);
          }
          continue;
        }
        paths.push(path);
      }
    }
  }
  visit(root);
  process.stdout.write(`${paths.join('\0')}${paths.length ? '\0' : ''}`);
}

function scriptHashes(html) {
  const source = html.toString('utf8');
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const opens = [...source.matchAll(/<script\b/gi)];
  if (scripts.length === 0 || scripts.length !== opens.length) {
    throw new Error('staged index has missing or unterminated script tags');
  }
  return scripts
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes))
    .map(([, , body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

function releaseIdentity(indexPath, webRoot) {
  if (!isAbsolute(webRoot) || !/^\/[A-Za-z0-9_./-]+$/.test(webRoot)) {
    throw new Error('web root must be a safe absolute Nginx path');
  }
  const tree = clientTree(dirname(indexPath));
  const { id } = tree;
  if (resolve(indexPath) !== resolve(join(webRoot, 'releases', id, 'index.html'))) {
    throw new Error('staged index does not match its content-addressed release path');
  }
  if (
    !lstatSync(indexPath).isFile() ||
    realpathSync(dirname(indexPath)) !== resolve(join(webRoot, 'releases', id))
  ) {
    throw new Error('staged index must be a regular file, not a symlink or redirected release');
  }
  const html = readFileSync(indexPath);
  if (createHash('sha256').update(html).digest('hex') !== tree.indexHash) {
    throw new Error('staged index changed while hashing the complete release');
  }
  const hashes = scriptHashes(html);
  if (hashes.length === 0) throw new Error('staged index contains no inline scripts');
  return { id, hashes };
}

function candidateFor(indexPath, templatePath, webRoot) {
  const { id, hashes } = releaseIdentity(indexPath, webRoot);
  const template = readFileSync(templatePath, 'utf8');
  const pane = template.match(/location = \/outlook-pane\s*\{([^}]*)\}/)?.[1] ?? '';
  const panePolicy = pane.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1] ?? '';
  const scriptSrcAttr = panePolicy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => /^script-src-attr(?:\s|$)/i.test(directive));
  if (
    !panePolicy.includes("script-src 'self' __NAVA_PANE_SCRIPT_HASHES__;") ||
    scriptSrcAttr.length !== 1 ||
    !/^script-src-attr\s+'none'$/i.test(scriptSrcAttr[0]) ||
    /\bscript-src-elem\b|script-src [^;]*'unsafe-inline'/.test(panePolicy) ||
    (template.match(/__NAVA_RELEASE_ID__/g) ?? []).length < 4 ||
    (template.match(/__NAVA_WEB_ROOT__/g) ?? []).length < 4 ||
    (template.match(/__NAVA_PANE_SCRIPT_HASHES__/g) ?? []).length !== 1
  ) {
    throw new Error('Nginx template pane script policy is unsafe or lacks release placeholders');
  }
  return template
    .replaceAll('__NAVA_RELEASE_ID__', id)
    .replaceAll('__NAVA_WEB_ROOT__', webRoot)
    .replace('__NAVA_PANE_SCRIPT_HASHES__', hashes.join(' '));
}

function main([command, indexPath, templatePath, candidatePath, webRoot]) {
  if (command === 'id' && indexPath && !templatePath) {
    process.stdout.write(`${clientTree(indexPath).id}\n`);
    return;
  }
  if (command === 'hashed-assets' && indexPath && templatePath && !candidatePath) {
    hashedAssets(indexPath, templatePath);
    return;
  }
  if (
    !['render', 'verify'].includes(command) ||
    !indexPath ||
    !templatePath ||
    !candidatePath ||
    !webRoot
  ) {
    throw new Error(
      'usage: pane-csp-release.mjs id CLIENT_DIR | hashed-assets ASSETS_DIR PUBLIC_ASSETS_DIR | render|verify INDEX TEMPLATE CANDIDATE WEB_ROOT',
    );
  }
  const expected = candidateFor(indexPath, templatePath, webRoot);
  if (command === 'render') {
    writeFileSync(candidatePath, expected, { flag: 'wx', mode: 0o600 });
  } else if (readFileSync(candidatePath, 'utf8') !== expected) {
    throw new Error('Nginx candidate/index CSP or release mismatch; refusing publication');
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`pane release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
