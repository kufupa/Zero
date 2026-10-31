// Identify one rendered saved Labtest record before an action on its page.
const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return { display: `${value.slice(8, 10)}-${MONTHS[parsed.getUTCMonth()]}-${value.slice(0, 4)}`,
    wire: `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` };
}

export async function currentLabtestRecord(page, expected) {
  const { confirmation, guestId, arrival, departure, roomType, ratePlan, note } = expected || {};
  const start = date(arrival), end = date(departure);
  if (!/^\d{6,}-\d+$/.test(confirmation || '') || !/^\d+$/.test(guestId || '') || !start || !end ||
      arrival < '2027-01-01' || arrival >= departure || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || typeof note !== 'string' || !note || note.length > 200) {
    throw new Error('LABTEST_RECORD_INPUT_INVALID');
  }
  if (new URL(page.url()).origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(await page.title())) {
    throw new Error('PROPERTY_OR_ORIGIN_MISMATCH');
  }
  const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
  if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
  const frame = await (await frames.elementHandle())?.contentFrame();
  if (!frame || new URL(frame.url()).origin !== ORIGIN) throw new Error('RECORD_FRAME_UNAVAILABLE');
  const state = await frame.evaluate(({ expected, start, end, origin }) => {
    if (location.origin !== origin) return null;
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const names = ['confirmationnumber', 'status', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote', 'udfchkbox04', 'udfchar13', 'emailaddress'];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.name === name && visible(el))]));
    if (names.some((name) => fields[name].length !== 1)) return null;
    const cmp = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = cmp('guestid')?.up?.('form'), data = form?.getRecord?.()?.data, keys = data && Object.keys(data);
    if (!form?.el?.dom || !data || names.some((name) => !form.el.dom.contains(fields[name][0]))) return null;
    const unique = (key) => Object.hasOwn(data, key) && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1;
    const exact = (key, value) => unique(key) && String(data[key] ?? '').trim() === value;
    const value = (name) => fields[name][0].value.trim();
    if (!exact('propertycode', 'HRCEN') || !exact('confirmationnumber', expected.confirmation) ||
        !exact('guestid', expected.guestId) || !exact('status', 'Reserved') || !exact('firstname', 'Proof') ||
        !exact('lastname', 'Labtest') || value('confirmationnumber') !== expected.confirmation || value('status') !== 'Reserved' ||
        value('guestid') !== expected.guestId || value('firstname') !== 'Proof' || value('lastname') !== 'Labtest' ||
        value('arrivaldate') !== start.display || value('departuredate') !== end.display || value('roomtype') !== expected.roomType ||
        value('rateplan') !== expected.ratePlan || !value('track') || value('reservationnote') !== expected.note ||
        value('guaranteetype') !== 'Non-Guaranteed Individual' || cmp('guaranteetype')?.getValue?.() !== 'NGI' ||
        value('udfchar13') || value('emailaddress') || cmp('udfchkbox04')?.getValue?.() !== false) return null;
    const native = {};
    for (const key of ['PKID', 'bookingsessionid', 'reservationid', 'reservationstayid', 'recordid']) {
      if (!unique(key) || !String(data[key] ?? '').trim()) return null;
      native[key] = String(data[key]).trim();
    }
    return { native, track: value('track') };
  }, { expected, start, end, origin: ORIGIN });
  if (!state) throw new Error('LABTEST_RECORD_UNVERIFIED');
  return { frame, ...state, arrivalWire: start.wire, departureWire: end.wire };
}
