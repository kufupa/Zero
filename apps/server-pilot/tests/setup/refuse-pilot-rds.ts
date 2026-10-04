/**
 * Vitest setupFiles entry: refuse pilot DATABASE_URL even when a suite
 * never imports withTestDb / test-db.ts (those suites wiped prod Jul 27).
 */
import { assertNotPilotProdDatabase } from '../helpers/pilot-rds-guard.js';

assertNotPilotProdDatabase(process.env.DATABASE_URL);

assertNotPilotProdDatabase(process.env.TEST_DATABASE_URL);
if (process.env.OUTLOOK_SYNC_TEST_REQUIRED === '1') {
  const { assertOutlookSyncTestDatabase } = await import('../../scripts/outlook-sync-test-gate.js');
  await assertOutlookSyncTestDatabase();
}
