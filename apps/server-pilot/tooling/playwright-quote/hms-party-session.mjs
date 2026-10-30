#!/usr/bin/env node
// Compatibility entry point for callers using the former tooling path.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../hms-cloud/booking-lookup-session.mjs';

export * from '../hms-cloud/booking-lookup-session.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
