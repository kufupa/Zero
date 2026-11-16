import { bigint, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { aiWorkflowRun } from './mail.js';

export const hmsCredentialAdmission = pgTable('hms_credential_admission', {
  operationKey: text('operation_key').primaryKey(),
  position: bigint('position', { mode: 'bigint' }).notNull().default(0n),
  credentialKey: bigint('credential_key', { mode: 'bigint' }),
  runId: text('run_id').unique().references(() => aiWorkflowRun.id, { onDelete: 'cascade' }),
  ownerPid: integer('owner_pid'),
  ownerStartedAt: timestamp('owner_started_at', { withTimezone: true }),
}, table => [index('hms_credential_admission_order_idx').on(table.position)]);
