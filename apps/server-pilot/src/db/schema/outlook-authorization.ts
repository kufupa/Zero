import { pgTable, text, timestamp, integer, index, primaryKey } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { mailboxTransport } from './mail.js';
import { outlookDevice } from './outlook-device.js';

export const outlookNavigation = pgTable('outlook_navigation', {
  deviceId: text('device_id').primaryKey().references(() => outlookDevice.deviceId, { onDelete: 'cascade' }),
  challengeHash: text('challenge_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const outlookBridgeTicket = pgTable('outlook_bridge_ticket', {
  ticketHash: text('ticket_hash').primaryKey(),
  deviceId: text('device_id').notNull().references(() => outlookDevice.deviceId, { onDelete: 'cascade' }),
  challengeHash: text('challenge_hash').notNull(),
  sessionId: text('session_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id, { onDelete: 'cascade' }),
  storeId: text('store_id').notNull(),
  action: text('action').notNull(),
  operationId: text('operation_id'),
  declaredScope: text('declared_scope'),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
}, (t) => [index('outlook_bridge_ticket_expiry_idx').on(t.expiresAt),
  index('outlook_bridge_ticket_navigation_idx').on(t.deviceId, t.challengeHash)]);

export const outlookApprovedFolder = pgTable('outlook_approved_folder', {
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id, { onDelete: 'cascade' }),
  storeId: text('store_id').notNull(),
  folderId: text('folder_id').notNull(),
  kind: text('kind').notNull(),
  approvedAt: timestamp('approved_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.transportId, t.storeId, t.folderId] })]);

export const outlookMoveReceipt = pgTable('outlook_move_receipt', {
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => outlookDevice.deviceId, { onDelete: 'cascade' }),
  operationId: text('operation_id').notNull(),
  scopeHash: text('scope_hash').notNull(),
  count: integer('count').notNull(),
  approvedAt: timestamp('approved_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.transportId, t.deviceId, t.operationId] }), index('outlook_move_receipt_budget_idx').on(t.transportId, t.approvedAt)]);
