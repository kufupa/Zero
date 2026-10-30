import { readFileSync } from 'node:fs';
import { normalizeLookupOptions } from './stay360-confirmation.mjs';

// Guest details can be supplied through stdin instead of process arguments.
export function readLookupInput(args) {
  let input;
  let options;
  if (args.length === 2 && args[0] === '--confirmation') {
    input = { confirmation: args[1] };
  } else if (args.length === 1 && args[0] === '--json-stdin') {
    try { input = JSON.parse(readFileSync(0, 'utf8')); }
    catch { throw new Error('INVALID_LOOKUP_INPUT'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_LOOKUP_INPUT');
    options = { guestName: input.guestName, arrivalDate: input.arrivalDate };
  } else {
    throw new Error('INVALID_LOOKUP_INPUT');
  }
  if (typeof input.confirmation !== 'string' || !input.confirmation.trim() ||
      input.confirmation.length > 128 || /[\r\n]/.test(input.confirmation)) {
    throw new Error('INVALID_CONFIRMATION');
  }
  if (options) normalizeLookupOptions(options);
  return { confirmation: input.confirmation.trim(), options };
}

export function lookupFailure(error, started) {
  const message = String(error?.message || error).split('\n')[0];
  const result = {
    ok: false,
    phase: error?.phase || 'startup',
    elapsedMs: Date.now() - started,
    error: /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'PLAYWRIGHT_OPERATION_FAILED',
  };
  if (Array.isArray(error?.candidates)) result.candidates = error.candidates;
  if (Object.hasOwn(error ?? {}, 'searchedDateRange')) result.searchedDateRange = error.searchedDateRange;
  if (error?.searchResults) result.searchResults = error.searchResults;
  return result;
}
