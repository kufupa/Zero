import { TRACK_LABELS } from '../playwright-quote/create-request.mjs';

// The requested code is an interpretation; prepare also checks the current form label.
export function normalizeCreateTrack(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) return null;
  const matches = Object.entries(TRACK_LABELS).filter(([display, code]) => value === display || value === code);
  if (matches.length !== 1) return null;
  const [display, lookupCode] = matches[0];
  return { lookupCode, display };
}
