import { describe, expect, it, vi } from 'vitest';
import { withCloudReadSession, type CloudCredentialLease } from '../tooling/hms-cloud/cloud-session.mjs';
import { fetchQuote } from '../tooling/hms-cloud/fetch-quote.mjs';
import { resolvePropertyScope, propertySwitchSchema } from '../src/hms/property-registry.js';

// Scope and lease refusals run before credentials, browser startup or database acquisition.
describe('Cloud read session lease', () => {
  it('requires an active explicit property and a transport belonging to that property', async () => {
    const read = vi.fn();
    await expect(withCloudReadSession(read, { propertyCode: '' })).rejects.toThrow('HMS_PROPERTY_REQUIRED');
    await expect(withCloudReadSession(read, { propertyCode: 'HTLZZ' })).rejects.toThrow('HMS_PROPERTY_REQUIRED');
    await expect(withCloudReadSession(read, { propertyCode: 'HRDAV', transportId: 'transport-centurion' })).rejects.toThrow('HMS_SESSION_OPTIONS_INVALID');
    await expect(fetchQuote({ propertyCode: '', request: {} })).rejects.toThrow('CLOUD_QUOTE_SCOPE_REQUIRED');
    await expect(fetchQuote({ propertyCode: 'HRDAV', transportId: 'transport-centurion', request: {} })).rejects.toThrow('CLOUD_QUOTE_SCOPE_REQUIRED');
    expect(resolvePropertyScope({ transportId: 'transport-davinci', propertySwitch: propertySwitchSchema.parse('HRDAVS') }).propertyCode).toBe('HRDAVS');
    expect(() => resolvePropertyScope({ transportId: 'transport-centurion', propertySwitch: 'HRDAV' })).toThrow('hms_property_switch_unauthorized');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a transferred caller token and an aborted scope before reading credentials', async () => {
    const read = vi.fn(), loadSecret = vi.fn(), release = vi.fn();
    // An attacker can supply the public shape; only the session owner can mint the private lease brand.
    const forged = { signal: new AbortController().signal, release } as unknown as CloudCredentialLease;
    await expect(withCloudReadSession(read, { propertyCode: 'HRDAV', transportId: 'transport-davinci',
      credentialLease: forged, loadSecret })).rejects.toThrow('HMS_CREDENTIAL_LEASE_INVALID');
    const abort = new AbortController(); abort.abort(new Error('selected_scope_lost'));
    await expect(withCloudReadSession(read, { propertyCode: 'HRDAV', transportId: 'transport-davinci',
      signal: abort.signal, loadSecret })).rejects.toThrow('selected_scope_lost');
    expect(read).not.toHaveBeenCalled(); expect(loadSecret).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  });
});
