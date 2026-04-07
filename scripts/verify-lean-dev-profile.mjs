#!/usr/bin/env node
import process from 'node:process';

const required = {
  ZERO_DISABLE_OXLINT: '1',
  ZERO_DISABLE_REACT_COMPILER: '1',
  ZERO_DISABLE_VITE_WARMUP: '1',
};

for (const [k, v] of Object.entries(required)) {
  if (process.env[k] !== v) {
    console.error(`${k} expected ${v}, got ${process.env[k] ?? '<unset>'}`);
    process.exit(1);
  }
}

console.log('verify-lean-dev-profile passed');
