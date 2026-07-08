#!/usr/bin/env node
/**
 * Set T3MP3ST Conf defaults for xAI / grok-4.3 without interactive wizard.
 * Runs inside the vendored T3MP3ST tree so Conf resolves the same store as the CLI.
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vendorRoot = join(__dirname, '..', '.vendor', 'T3MP3ST');
const provider = process.argv[2] || 'xai';
const model = process.argv[3] || 'grok-4.3';

const configUrl = pathToFileURL(join(vendorRoot, 'dist', 'config', 'index.js')).href;
const { config } = await import(configUrl);

config.set('defaultProvider', provider);
config.set('defaultModel', model);

if (provider === 'xai') {
  config.set('xai', { ...config.get('xai'), defaultModel: model });
}

console.log(
  JSON.stringify({
    defaultProvider: config.get('defaultProvider'),
    defaultModel: config.get('defaultModel'),
    xaiDefault: config.get('xai').defaultModel,
    configPath: config.getConfigPath(),
  }),
);
