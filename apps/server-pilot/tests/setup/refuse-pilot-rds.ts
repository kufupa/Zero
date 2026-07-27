/**
 * Vitest setupFiles entry: refuse pilot DATABASE_URL even when a suite
 * never imports withTestDb / test-db.ts (those suites wiped prod Jul 27).
 */
import { assertNotPilotProdDatabase } from '../helpers/pilot-rds-guard.js';

assertNotPilotProdDatabase(process.env.DATABASE_URL);
