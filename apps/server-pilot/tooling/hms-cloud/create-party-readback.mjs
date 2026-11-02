// Independently reopen the just-created fake stay and inspect native party IDs.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';

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
    ? String(data[key] ?? '').trim() : null;
  const modelNames = ['propertycode', 'confirmationnumber', 'status', 'guestid', 'firstname', 'lastname', 'taid1', 'ta1',
    'companyid', 'company', 'araccountid', 'araccountname', 'arprofileid'];
  const names = ['ta1', 'company', 'araccountname'];
  const visibleValues = Object.fromEntries(names.map((name) => {
    const fields = input(name);
    return [name, fields.length === 1 && form.el.dom.contains(fields[0]) ? fields[0].value.trim() : null];
  }));
  return { model: Object.fromEntries(modelNames.map((name) => [name, value(name)])), visible: visibleValues };
}

export function compareCreatePartyRecord(snapshot, expected) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.model || !snapshot.visible) {
    return { outcome: 'unverified', issue: 'PARTY_RECORD_UNVERIFIED' };
  }
  const values = { propertycode: 'HRCEN', confirmationnumber: expected.confirmation, status: 'Reserved', guestid: expected.guestId,
    firstname: 'Proof', lastname: 'Labtest', taid1: expected.agency?.nativeId ?? '', ta1: expected.agency?.name ?? '',
    companyid: expected.organization?.nativeId ?? '', company: expected.organization?.name ?? '',
    araccountid: expected.arAccount?.nativeId ?? '', araccountname: expected.arAccount?.name ?? '',
    arprofileid: expected.arAccount?.profileId ?? '' };
  const mismatches = Object.entries(values).filter(([key, wanted]) => snapshot.model[key] !== wanted).map(([key]) => key);
  for (const name of ['ta1', 'company', 'araccountname']) {
    if (snapshot.visible[name] !== values[name]) mismatches.push(`${name}_visible`);
  }
  return mismatches.length ? { outcome: 'unverified', issue: 'PARTY_READBACK_MISMATCH', fields: mismatches }
    : { outcome: 'verified', verified: ['agency', 'organization', 'arAccount'] };
}

export async function readCreateParties({ confirmation, arrival, guestId, agency, organization, arAccount }) {
  if (!/^\d{6,}-\d+$/.test(confirmation || '') || !/^\d+$/.test(guestId || '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(arrival || '') || arrival < '2027-01-01') {
    return { outcome: 'unverified', issue: 'PARTY_READBACK_INPUT_INVALID' };
  }
  const validParty = (party) => !party || (typeof party.nativeId === 'string' && /^\d+$/.test(party.nativeId) &&
    typeof party.name === 'string' && party.name.trim() === party.name && party.name.length > 0);
  if (![agency, organization, arAccount].every(validParty) ||
      (arAccount && (typeof arAccount.profileId !== 'string' || !arAccount.profileId.trim()))) {
    return { outcome: 'unverified', issue: 'PARTY_READBACK_INPUT_INVALID' };
  }
  try {
    return await withCenturionStay360Page(async (page) => {
      await installReadOnlyGuard(page.context());
      const shallow = await readShallow(page, confirmation, { guestName: 'Proof Labtest', arrivalDate: arrival });
      if (shallow.confirmation !== confirmation) throw new Error('CONFIRMATION_MISMATCH');
      await readRecord(page, confirmation);
      const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
      if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
      const frame = await (await frames.elementHandle())?.contentFrame();
      if (!frame || new URL(frame.url()).origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com') throw new Error('RECORD_FRAME_UNAVAILABLE');
      const snapshot = await frame.evaluate(extractCreatePartySnapshot);
      return compareCreatePartyRecord(snapshot, { confirmation, guestId, agency, organization, arAccount });
    }, { headless: true });
  } catch { return { outcome: 'unverified', issue: 'PARTY_READBACK_FAILED' }; }
}
