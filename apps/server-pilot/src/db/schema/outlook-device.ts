import { pgTable, text, timestamp, primaryKey, index, integer, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';
import { mailboxTransport } from './mail.js';

export const outlookEnrollment = pgTable('outlook_enrollment', {
  codeHash: text('code_hash').primaryKey(),
  storeId: text('store_id').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const outlookEnrollmentGrant = pgTable('outlook_enrollment_grant', {
  codeHash: text('code_hash').notNull().references(() => outlookEnrollment.codeHash, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.codeHash, t.userId, t.transportId] })]);

export const outlookDevice = pgTable('outlook_device', {
  deviceId: text('device_id').primaryKey(),
  version: text('version').notNull(),
  storeId: text('store_id').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  enrolledAt: timestamp('enrolled_at').notNull().defaultNow(),
  lastHandshakeAt: timestamp('last_handshake_at'),
  revokedAt: timestamp('revoked_at'),
});

export const outlookDeviceGrant = pgTable('outlook_device_grant', {
  deviceId: text('device_id').notNull().references(() => outlookDevice.deviceId, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.deviceId, t.userId, t.transportId] })]);

export const outlookDeviceNonce = pgTable('outlook_device_nonce', {
  nonceHash: text('nonce_hash').primaryKey(),
  deviceId: text('device_id').notNull().references(() => outlookDevice.deviceId, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
}, (t) => [index('outlook_device_nonce_device_idx').on(t.deviceId), index('outlook_device_nonce_expiry_idx').on(t.expiresAt)]);

/** Read-only approval: deliberately separate from exact mutation folder grants. */
export const outlookDeviceReadRoot = pgTable('outlook_device_read_root', {
  deviceId: text('device_id').notNull(),
  userId: text('user_id').notNull(),
  transportId: text('transport_id').notNull(),
  storeId: text('store_id').notNull(),
  rootEntryId: text('root_entry_id').notNull(),
  policyVersion: integer('policy_version').notNull().default(1),
  policyGeneration: integer('policy_generation').notNull().default(1),
  revokedAt: timestamp('revoked_at'),
  approvedAt: timestamp('approved_at').notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.deviceId, t.userId, t.transportId, t.storeId, t.rootEntryId] }),
  foreignKey({ columns: [t.deviceId, t.userId, t.transportId], foreignColumns: [outlookDeviceGrant.deviceId, outlookDeviceGrant.userId, outlookDeviceGrant.transportId] }).onDelete('cascade'),
  check('outlook_read_root_policy_version', sql`${t.policyVersion} = 1`),
  check('outlook_read_root_generation', sql`${t.policyGeneration} > 0`),
]);
