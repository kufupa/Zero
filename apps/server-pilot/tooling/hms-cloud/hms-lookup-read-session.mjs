import { withCloudReadSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { openNewGuestStay, searchPrimaryBookingAgency, searchOrganization, searchArAccount,
  closeGuestStayPartyPicker } from './lookup.mjs';
import { searchGuestProfiles, inspectGuestProfileCandidates, closeGuestProfilePicker } from './guest-profile.mjs';
import { listGuestStayDropdown, listCmsMessageIds, closeCmsMessageIdPicker } from './guest-stay-form.mjs';
import { searchGuestStaySourceBusiness, inspectGuestStaySourceBusiness,
  closeGuestStaySourceBusinessPicker } from './guest-stay-source-business.mjs';
import { searchRoomTypes, searchRoomTypesForCharge, searchRatePlans } from './guest-stay-room-rate.mjs';

/** Pure lookup tools share one verified, guarded blank stay and never select a record. */
export function createCloudLookupReadTools(page, propertyCode, signal) {
  if (!getPropertyRegistration(propertyCode)?.active) throw new Error('HMS_PROPERTY_REQUIRED');
  let tail = Promise.resolve();
  return (request = {}) => {
    const run = async () => {
      signal?.throwIfAborted();
      const { tool, id } = request;
      if (request.propertyCode !== undefined && request.propertyCode !== propertyCode) {
        return { id, tool, outcome: 'input_gap', issue: 'PROPERTY_MISMATCH' };
      }
      let result;
      switch (tool) {
        case 'searchGuestProfiles': result = await searchGuestProfiles(page, request, { propertyCode }); break;
        case 'inspectGuestProfileCandidates': result = await inspectGuestProfileCandidates(page, request); break;
        case 'closeGuestProfilePicker': result = await closeGuestProfilePicker(page, { propertyCode }); break;
        case 'searchPrimaryBookingAgency': result = await searchPrimaryBookingAgency(page, request.query, { propertyCode }); break;
        case 'searchOrganization': result = await searchOrganization(page, request.query, { propertyCode }); break;
        case 'searchArAccount': result = await searchArAccount(page, request.query, { propertyCode }); break;
        case 'closeGuestStayPartyPicker': result = await closeGuestStayPartyPicker(page, { propertyCode }); break;
        case 'listGuestStayDropdown': result = await listGuestStayDropdown(page, { propertyCode, field: request.field }); break;
        case 'listCmsMessageIds': result = await listCmsMessageIds(page, { propertyCode }); break;
        case 'closeCmsMessageIdPicker': result = await closeCmsMessageIdPicker(page, { propertyCode }); break;
        case 'searchGuestStaySourceBusiness': result = await searchGuestStaySourceBusiness(page,
          { field: request.field, query: request.query }, { propertyCode }); break;
        case 'inspectGuestStaySourceBusiness': result = await inspectGuestStaySourceBusiness(page, request); break;
        case 'closeGuestStaySourceBusinessPicker': result = await closeGuestStaySourceBusinessPicker(page); break;
        default: return { id, tool, outcome: 'input_gap', issue: 'unknown_tool' };
      }
      signal?.throwIfAborted();
      return { id, tool, ...result };
    };
    const pending = tail.then(run);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
}

export async function withCloudLookupReadSession(operation, { propertyCode, signal, transportId, credentialLease } = {}) {
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active || typeof operation !== 'function') throw new Error('HMS_PROPERTY_REQUIRED');
  return withCloudReadSession(async (page, identity) => {
    if (!identity || identity.propertyCode !== propertyCode || identity.tenantId !== property.expectedTenant ||
        identity.landingPropertyCode !== property.landingPropertyCode || identity.origin !== property.origin) {
      throw new Error('HMS_PROPERTY_MISMATCH');
    }
    await openNewGuestStay(page, { propertyCode });
    return operation({ page, runTool: createCloudLookupReadTools(page, propertyCode, signal) });
  }, { propertyCode, signal, credentialLease, startScreen: 'OSRESV', ...(transportId !== undefined && { transportId }) });
}

// Rate Shop cannot be cancelled by a read-only session. Isolate each catalogue
// in its own browser and publish the callback result only after that browser closes.
export async function withCloudRoomRateReadSession(tool, operation, { propertyCode, signal, transportId, credentialLease } = {}) {
  const searches = { searchRoomTypes, searchRoomTypesForCharge, searchRatePlans };
  const search = Object.hasOwn(searches, tool) ? searches[tool] : null;
  const property = getPropertyRegistration(propertyCode);
  if (!search || typeof operation !== 'function') throw new Error('ROOM_RATE_LOOKUP_REQUIRED');
  if (!property?.active) throw new Error('HMS_PROPERTY_REQUIRED');
  return withCloudReadSession(async (page, identity) => {
    if (!identity || identity.propertyCode !== propertyCode || identity.tenantId !== property.expectedTenant ||
        identity.landingPropertyCode !== property.landingPropertyCode || identity.origin !== property.origin) {
      throw new Error('HMS_PROPERTY_MISMATCH');
    }
    await openNewGuestStay(page, { propertyCode });
    let accepting = true, tail = Promise.resolve();
    const runTool = request => {
      let input;
      try { input = structuredClone(request); } catch { return Promise.resolve({ outcome: 'input_gap', issue: 'INVALID_REQUEST' }); }
      if (!accepting) return Promise.resolve({ id: input?.id, tool: input?.tool, outcome: 'refused', issue: 'SESSION_CLOSED' });
      const pending = tail.then(async () => {
        signal?.throwIfAborted();
        if (!input || typeof input !== 'object' || Array.isArray(input) || input.tool !== tool) {
          return { id: input?.id, tool: input?.tool, outcome: 'input_gap', issue: 'unknown_tool' };
        }
        if (input.propertyCode !== undefined && input.propertyCode !== propertyCode) {
          return { id: input.id, tool, outcome: 'input_gap', issue: 'PROPERTY_MISMATCH' };
        }
        const result = await search(page, input);
        signal?.throwIfAborted();
        return { id: input.id, tool, ...result };
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    };
    try { return await operation({ runTool }); }
    finally { accepting = false; await tail; }
  }, { propertyCode, signal, credentialLease, startScreen: 'OSRESV', ...(transportId !== undefined && { transportId }) });
}
