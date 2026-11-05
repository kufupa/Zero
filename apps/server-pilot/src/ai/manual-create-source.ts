import { z } from 'zod';
import { mailExtractionPayloadSchema, type MailExtractionPayload } from './extraction/schema.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';

/** Server-owned authority for a staff-started booking after a genuine failed read. */
export const MANUAL_CREATE_KEY = 'staffManualCreate';
const markerSchema = z.object({
  version: z.literal(1), extractionId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  messageId: z.string().min(1), threadId: z.string().min(1), actorId: z.string().min(1),
  stayId: z.string().regex(/^s_m[a-f0-9]{24}$/), rowId: z.string().regex(/^r_m[a-f0-9]{24}$/),
}).strict();
export type ManualCreateMarker = z.infer<typeof markerSchema>;

export function manualCreateMarker(state: Record<string, unknown>): ManualCreateMarker | null {
  const result = markerSchema.safeParse(state[MANUAL_CREATE_KEY]);
  return result.success ? result.data : null;
}

/** No business facts are inferred from an unread email. */
export function manualCreatePayload(input: {
  item: { kind: string; extractionId: string | null; sourceMessageId: string | null; threadId: string | null; state: Record<string, unknown> };
  extraction: { id: string; messageId: string; status: string };
  source: { id: string; threadId: string | null; subject: string | null; textBody: string | null; htmlBody: string | null };
}): MailExtractionPayload | null {
  const marker = manualCreateMarker(input.item.state);
  if (!marker || input.item.kind !== 'booking' || input.extraction.status !== 'failed' ||
      marker.extractionId !== input.extraction.id || input.item.extractionId !== input.extraction.id ||
      input.extraction.messageId !== input.source.id || input.item.sourceMessageId !== input.source.id ||
      marker.messageId !== input.source.id || marker.threadId !== input.source.threadId ||
      input.item.threadId !== input.source.threadId || marker.sourceHash !== staffQuoteSourceHash(input.source)) return null;
  return mailExtractionPayloadSchema.parse({
    needsAction: true, action: 'new_booking', contact: { name: null, email: null, phone: null },
    agency: null, endClient: null, confirmationNumbers: [], missing: [],
    stays: [{ id: marker.stayId, hotel: null, requested: { arrival: null, departure: null }, booked: null,
      totalRooms: null, totalAdults: null, totalChildren: null, action: 'new_booking',
      rows: [{ id: marker.rowId, roomType: null, rooms: null, adultsPerRoom: null, childAges: null, board: null }] }],
  });
}
