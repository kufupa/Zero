import { TRACK_LABELS } from '../playwright-quote/create-request.mjs';

// A requested lookup code is useful only when the current HMS form shows the
// corresponding label. The native Save fence separately binds that form value.
export function normalizeCreateTrack(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) return null;
  const matches = Object.entries(TRACK_LABELS).filter(([display, code]) => value === display || value === code);
  if (matches.length !== 1) return null;
  const [display, lookupCode] = matches[0];
  return { lookupCode, display };
}
