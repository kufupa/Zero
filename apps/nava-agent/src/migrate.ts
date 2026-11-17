import { readFile } from 'node:fs/promises';
import { sql } from './db.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
await sql.unsafe(await readFile(new URL('../migrations/001_init.sql',import.meta.url),'utf8'));
await sql.end();
