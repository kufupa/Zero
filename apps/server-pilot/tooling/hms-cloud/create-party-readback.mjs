// Independently reopen the just-created stay and inspect native party IDs.
import { withCloudReadSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { isCreateDate, isLabtestGuest, validCreateGuest } from './cloud-create-policy.mjs';

// Runs inside the saved record frame; callers still verify the extracted evidence.
export function extractCreatePartySnapshot() {
  const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
  const input = (name) => [...document.querySelectorAll('input,textarea,select')].filter((el) => el.name === name && visible(el));
  const anchors = input('guestid');
  if (anchors.length !== 1) return null;
  const form = globalThis.Ext?.getCmp?.(anchors[0].id.replace(/-inputEl$/, ''))?.up?.('form');
  const data = form?.getRecord?.()?.data, keys = data && Object.keys(data);
  if (!form?.el?.dom || !data || !form.el.dom.contains(anchors[0])) return null;
  const value = (key) => Object.hasOwn(data, key) && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1
    ? (key === 'billingreference' ? (typeof data[key] === 'string' ? data[key] : null) : String(data[key] ?? '').trim()) : null;
  const modelNames = ['propertycode', 'confirmationnumber', 'status', 'guestid', 'firstname', 'lastname', 'taid1', 'ta1',
    'companyid', 'company', 'araccountid', 'araccountname', 'arprofileid', 'billingreference'];
  const names = ['ta1', 'company', 'araccountname', 'billingreference'];
  const visibleValues = Object.fromEntries(names.map((name) => {
    const fields = input(name);
    return [name, fields.length === 1 && form.el.dom.contains(fields[0]) ? (name === 'billingreference' ? fields[0].value : fields[0].value.trim()) : null];
  }));
  return { model: Object.fromEntries(modelNames.map((name) => [name, value(name)])), visible: visibleValues };
}

export function compareCreatePartyRecord(snapshot, expected) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.model || !snapshot.visible) {
    return { outcome: 'unverified', issue: 'PARTY_RECORD_UNVERIFIED' };
  }
  const guest = { firstName: expected.firstName ?? 'Proof', lastName: expected.lastName ?? 'Labtest' };
  const values = { propertycode: expected.propertyCode ?? 'HRCEN', confirmationnumber: expected.confirmation, status: 'Reserved', guestid: expected.guestId,
    firstname: guest.firstName, lastname: guest.lastName,
    taid1: expected.agency?.nativeId ?? '', ta1: expected.agency?.name ?? '',
    companyid: expected.organization?.nativeId ?? '', company: expected.organization?.name ?? '',
    ...((expected.arAccount || isLabtestGuest(guest)) ? {
      araccountid: expected.arAccount?.nativeId ?? '', araccountname: expected.arAccount?.name ?? '',
      arprofileid: expected.arAccount?.profileId ?? '' } : {}) };
  const mismatches = Object.entries(values).filter(([key, wanted]) => snapshot.model[key] !== wanted).map(([key]) => key);
  for (const name of ['ta1', 'company', ...(Object.hasOwn(values, 'araccountname') ? ['araccountname'] : [])]) {
    if (snapshot.visible[name] !== values[name]) mismatches.push(`${name}_visible`);
  }
  if (expected.billingReference !== undefined) {
    if (snapshot.model.billingreference !== expected.billingReference) mismatches.push('billingreference');
    if (snapshot.visible.billingreference !== expected.billingReference) mismatches.push('billingreference_visible');
  }
  return mismatches.length ? { outcome: 'unverified', issue: 'PARTY_READBACK_MISMATCH', fields: mismatches }
    : { outcome: 'verified', verified: ['agency', 'organization', ...(Object.hasOwn(values, 'araccountname') ? ['arAccount'] : []),
      ...(expected.billingReference !== undefined ? ['billingReference'] : [])] };
}

export async function readCreateParties({ confirmation, arrival, guestId, agency, organization, arAccount, billingReference,
  firstName = 'Proof', lastName = 'Labtest', allowRealGuest = false },
  { openSession = withCloudReadSession, propertyCode = 'HRCEN', transportId, signal, credentialLease, cloudTargetKey } = {}) {
  if (!getPropertyRegistration(propertyCode)?.active || !/^\d{6,}-\d+$/.test(confirmation || '') || !/^\d+$/.test(guestId || '') ||
      typeof allowRealGuest !== 'boolean' || !validCreateGuest({ firstName, lastName }) ||
      (!allowRealGuest && (!isLabtestGuest({ firstName, lastName }) || arrival < '2027-01-01')) ||
      !isCreateDate(arrival)) {
    return { outcome: 'unverified', issue: 'PARTY_READBACK_INPUT_INVALID' };
  }
  const validParty = (party) => !party || (typeof party.nativeId === 'string' && /^\d+$/.test(party.nativeId) &&
    typeof party.name === 'string' && party.name.trim() === party.name && party.name.length > 0);
  if (![agency, organization, arAccount].every(validParty) ||
      (arAccount && (typeof arAccount.profileId !== 'string' || !arAccount.profileId.trim())) ||
      (billingReference !== undefined && (!arAccount || typeof billingReference !== 'string' || !billingReference.trim() ||
        billingReference.length > 4000 || [...billingReference].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)))) {
    return { outcome: 'unverified', issue: 'PARTY_READBACK_INPUT_INVALID' };
  }
  try {
    return await openSession(async (page) => {
      const shallow = await readShallow(page, confirmation, { guestName: `${firstName} ${lastName}`, arrivalDate: arrival });
      if (shallow.confirmation !== confirmation) throw new Error('CONFIRMATION_MISMATCH');
      await readRecord(page, confirmation, { nativePropertyCode: propertyCode });
      const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
      if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
      const frame = await (await frames.elementHandle())?.contentFrame();
      if (!frame || new URL(frame.url()).origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com') throw new Error('RECORD_FRAME_UNAVAILABLE');
      const snapshot = await frame.evaluate(extractCreatePartySnapshot);
      return compareCreatePartyRecord(snapshot, { propertyCode, confirmation, guestId, firstName, lastName,
        agency, organization, arAccount, billingReference });
    }, { propertyCode, transportId, signal, credentialLease, startScreen: 'OSRESS', ...(cloudTargetKey ? { cloudTargetKey } : {}),
      prepareContext: (context) => installSavedStayReadGuard(context, { confirmation, propertyCode }) });
  } catch { return { outcome: 'unverified', issue: 'PARTY_READBACK_FAILED' }; }
}
