/**
 * Bounded notes/traces contract. Notes are observations, never instructions;
 * customer disclosure is decided from the source audience/printability facts.
 */
import {
  filterNotesForAudience,
  notesTraceItemSchema,
  notesTracesContextDataSchema,
  notesTracesListDataSchema,
  type NotesTraceItem,
  type NotesTracesContextData,
} from './context-read-contracts.js';
import { z } from 'zod';

export const NOTES_TRACES_READ_MAX_ROWS = 50;
export const NOTES_TRACES_READ_MAX_BYTES = 32 * 1024;
export const NOTES_TRACES_READ_MAX_DURATION_MS = 5_000;
export const NOTES_TRACES_READ_SURFACE_BLOCKER = 'BLOCKED_NOTES_TRACE_SOURCE_UNAVAILABLE';

export const NOTES_TRACES_READ_PRIVACY_POLICY = {
  allowedSurfaces: ['bounded_notes_trace_observation'],
  deniedActions: ['complete', 'submit', 'send', 'update', 'create', 'checkout_lock'],
  untrustedText: 'evidence_only',
} as const;

export const notesTracesReadDataSchema = notesTracesContextDataSchema;
export const notesTracesItemSchema = notesTraceItemSchema;
export const notesTracesListSchema = notesTracesListDataSchema;
export type NotesTracesReadData = NotesTracesContextData;
export type NotesTracesReadItem = NotesTraceItem;
export { filterNotesForAudience };

export const notesTraceAudienceSchema = z.enum(['staff', 'customer']);
export const notesTraceStateSchema = z.enum(['open', 'completed']);
