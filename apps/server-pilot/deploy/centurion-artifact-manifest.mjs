import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const names = { catalog: 'catalogs.json', observations: 'observations.jsonl', pms: 'pms.json',
  outbound: 'outbound.jsonl', party: 'party-index.json' };
const required = ['catalog', 'observations', 'pms'];
const sha = (data) => createHash('sha256').update(data).digest('hex');
const regular = (file) => {
  if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) throw Error('unsafe artifact');
  return readFileSync(file);
};
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validate(kind, data) {
  const text = data.toString('utf8');
  if (kind === 'catalog') {
    const value = JSON.parse(text);
    if (value.schemaVersion !== 'hms-native-catalogs/v1' || value.propertyCode !== 'HRCEN' ||
      !validDate(value.capturedAt) || !value.catalogs || typeof value.catalogs !== 'object' || Array.isArray(value.catalogs)) throw Error('invalid catalog');
  } else if (kind === 'observations') {
    for (const line of text.split('\n').filter(Boolean)) {
      const value = JSON.parse(line);
      if (value.schemaVersion !== 'hms-stay-observation/v1' || value.propertyCode !== 'HRCEN' ||
        !validDate(value.capturedAt) || !value.source || !value.result || typeof value.result !== 'object') throw Error('invalid observation');
    }
  } else if (kind === 'outbound') {
    for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
  } else JSON.parse(text);
}
function verify(dir) {
  const manifest = JSON.parse(regular(join(dir, 'manifest.json')));
  if (manifest.schemaVersion !== 'centurion-runtime-artifacts/v1' || manifest.propertyCode !== 'HRCEN' ||
    !manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) throw Error('invalid manifest');
  const keys = Object.keys(manifest.artifacts);
  if (required.some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(names, k))) throw Error('invalid inventory');
  for (const kind of keys) {
    const item = manifest.artifacts[kind];
    if (!item || item.file !== names[kind] || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw Error('invalid entry');
    const data = regular(join(dir, item.file));
    if (data.length !== item.bytes || sha(data) !== item.sha256) throw Error('checksum mismatch');
    validate(kind, data);
  }
  return manifest;
}
try {
  const [mode, dir, ...args] = process.argv.slice(2);
  if (mode === 'prepare' && dir) {
    const paths = new Map();
    for (let i = 0; i < args.length; i += 2) {
      const kind = args[i]?.replace(/^--/, '');
      if (!Object.hasOwn(names, kind) || paths.has(kind) || !args[i + 1]) throw Error('invalid arguments');
      paths.set(kind, args[i + 1]);
    }
    if (required.some(k => !paths.has(k))) throw Error('missing required artifact');
    const artifacts = {};
    for (const kind of Object.keys(names)) {
      if (!paths.has(kind)) continue;
      const data = regular(paths.get(kind)); validate(kind, data);
      const file = names[kind];
      copyFileSync(paths.get(kind), join(dir, file));
      const copied = regular(join(dir, file));
      if (sha(copied) !== sha(data)) throw Error('source changed while copying');
      artifacts[kind] = { file, bytes: data.length, sha256: sha(data) };
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 'centurion-runtime-artifacts/v1', propertyCode: 'HRCEN', artifacts }) + '\n', {mode: 0o600});
    verify(dir);
    console.log(sha(regular(join(dir, 'manifest.json'))));
  } else if (mode === 'verify' && dir && !args.length) {
    const manifest = verify(dir);
    for (const [kind, value] of Object.entries(manifest.artifacts)) console.log(`${kind} ${value.sha256} ${value.bytes}`);
  } else throw Error('usage');
} catch (error) {
  console.error(`artifact manifest error: ${error.message}`); process.exit(2);
}
