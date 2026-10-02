import { pgTable, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
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
