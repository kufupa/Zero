import { createAgentReadTools } from '../src/hms/agent-read-tools.js';
import { describe, expect, it } from 'vitest';

describe('model-facing read tool exclusions', () => {
  it('does not expose permanently excluded property or mail-artifact tools', () => {
    const tools = createAgentReadTools({} as never);
    expect(Object.keys(tools)).toEqual([
      'hms_find_reservation',
      'hms_read_reservation',
      'hms_quote_stay',
    ]);
    expect(tools).not.toHaveProperty('property_read_knowledge');
    expect(tools).not.toHaveProperty('mail_read_artifact');
  });
});
