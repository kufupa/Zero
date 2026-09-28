import { describe, expect, it } from 'vitest';
import { selectConnectedProbeTools } from '../src/hms/connected-tool-selection.js';

describe('connected proof tool selection', () => {
  it('keeps the default find/detail baseline and adds only explicitly named tools', () => {
    expect(selectConnectedProbeTools(undefined, false)).toEqual(['hms_find_reservation', 'hms_read_reservation']);
    expect(selectConnectedProbeTools('hms_read_folio,hms_read_notes_traces', false)).toEqual([
      'hms_find_reservation', 'hms_read_reservation', 'hms_read_folio', 'hms_read_notes_traces',
    ]);
  });
  it('an explicit subset overrides all-tools mode; invalid or empty selections fail closed', () => {
    expect(selectConnectedProbeTools('hms_read_folio', true)).not.toContain('hms_sent_email_audit');
    expect(() => selectConnectedProbeTools('hms_cancel_reservation', true)).toThrow('CONNECTED_TOOL_SELECTION');
    expect(() => selectConnectedProbeTools('', true)).toThrow('CONNECTED_TOOL_SELECTION');
  });
  it('preserves full-suite mode and deduplicates named tools', () => {
    expect(selectConnectedProbeTools(undefined, true)).toContain('hms_sent_email_audit');
    expect(selectConnectedProbeTools(' hms_read_folio,hms_read_folio ', false))
      .toEqual(['hms_find_reservation', 'hms_read_reservation', 'hms_read_folio']);
  });
});
