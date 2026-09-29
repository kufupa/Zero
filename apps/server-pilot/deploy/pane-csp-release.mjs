#!/usr/bin/env node
// Render and verify one Nginx candidate against the exact staged SPA bytes.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

function indexId(html) {
  return createHash('sha256').update(html).digest('hex');
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
  const html = readFileSync(indexPath);
  const id = indexId(html);
  if (resolve(indexPath) !== resolve(join(webRoot, 'releases', id, 'index.html'))) {
    throw new Error('staged index does not match its content-addressed release path');
  }
  if (
    !lstatSync(indexPath).isFile() ||
    realpathSync(dirname(indexPath)) !== resolve(join(webRoot, 'releases', id))
  ) {
    throw new Error('staged index must be a regular file, not a symlink or redirected release');
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
  if (
    !panePolicy.includes("script-src 'self' __NAVA_PANE_SCRIPT_HASHES__;") ||
    !panePolicy.includes("script-src-attr 'none';") ||
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
    process.stdout.write(`${indexId(readFileSync(indexPath))}\n`);
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
      'usage: pane-csp-release.mjs id INDEX | render|verify INDEX TEMPLATE CANDIDATE WEB_ROOT',
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
