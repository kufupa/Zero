// One verified room picker sequence in the existing saved-stay request fence.
const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
export const SAVED_ROOM_STAGE_PATHS = Object.freeze([
  '/web/base/LOVPOP', '/web/base/GRIDDATA',
  '/web/base/OSRESV.HDR.roomtypechange', '/web/base/OSRESV.HDR.attributerefresh',
]);
const issued = new WeakSet();
export const isSavedRoomStageRequestGate = (gate) => Boolean(gate && issued.has(gate));

export function matchesSavedStageRequest(request, frame, path, expected) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN &&
      url.pathname === path && !url.search && !url.hash &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(expected).every(([key, value]) => body.getAll(key).length === 1 &&
        body.get(key) === String(value ?? '') && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1);
  } catch { return false; }
}

/** The mutable state is usable only by the active lifecycle that issued this gate. */
export function createSavedRoomStageRequestGate({ frame, selected, deadlineAt } = {}) {
  if (!frame || selected?.propertyCode !== 'HRCEN' || selected.status !== 'Reserved' ||
      !/^\d{6,}-\d+$/.test(selected.confirmation || '') || !/^\d+$/.test(selected.guestId || '') ||
      !/^\d+$/.test(selected.reservationStayId || '') || !/^\d+$/.test(selected.reservationId || '') ||
      !/^\d+$/.test(selected.recordId || '') || !Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    throw new Error('ROOM_STAGE_GATE_INPUT_INVALID');
  }
  let state = 'ready', current, target, native, grid, chosen;
  const requests = new Map();
  const active = () => {
    if (performance.now() >= deadlineAt) state = 'closed';
    return state !== 'closed';
  };
  const gate = Object.freeze({
    arm(snapshot, before, after) {
      const data = snapshot?.data;
      if (!active() || state !== 'ready' || !data || !/^[A-Z0-9]{1,12}$/.test(before || '') ||
          !/^[A-Z0-9]{1,12}$/.test(after || '') || before === after || String(data.roomtype ?? '') !== before ||
          data.propertycode !== 'HRCEN' || data.status !== 'Reserved' ||
          String(data.confirmationnumber ?? '') !== selected.confirmation || String(data.guestid ?? '') !== selected.guestId ||
          String(data.reservationstayid ?? '') !== selected.reservationStayId ||
          String(data.reservationid ?? '') !== selected.reservationId || String(data.recordid ?? '') !== selected.recordId ||
          String(data.firstname ?? '') !== selected.firstName || String(data.lastname ?? '') !== selected.lastName ||
          ![false, 0, '0', 'false', ''].includes(data.udfchkbox04)) return false;
      const names = ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid', 'recordid',
        'status', 'firstname', 'lastname', 'arrivaldate', 'departuredate', 'adults', 'children', 'rateplan',
        'guaranteetype', 'udfchkbox04', 'udfchar13', 'emailaddress'];
      if (names.some((name) => !Object.hasOwn(data, name) ||
        (data[name] != null && !['string', 'number', 'boolean'].includes(typeof data[name])))) return false;
      native = Object.fromEntries(names.map((name) => [name, String(data[name] ?? '')]));
      if (data.udfchkbox04 === true) native.udfchkbox04 = '1';
      if (data.udfchkbox04 === false) native.udfchkbox04 = '0';
      current = before; target = after; state = 'initial_armed';
      return true;
    },
    armReset(metadata) {
      if (!active() || state !== 'initial_consumed' || metadata?.GRIDNAME !== 'LVROOMTYPE2' ||
          !/^\d+$/.test(String(metadata.GRIDID ?? '')) || !/^\d+$/.test(String(metadata.DATASPYID ?? ''))) return false;
      grid = { GRID_ID: String(metadata.GRIDID), DATASPY_ID: String(metadata.DATASPYID) };
      state = 'reset_armed'; return true;
    },
    armSelection(option) {
      if (!active() || state !== 'reset_consumed' || option?.code !== target ||
          !/^\d+$/.test(String(option.nativeId ?? ''))) return false;
      chosen = { roomtype: target, roomtypeid: String(option.nativeId) };
      state = 'change_armed'; return true;
    },
    consume(request) {
      if (!active()) return false;
      const base = { GRID_NAME:'LVROOMTYPE2', GRID_TYPE:'LOV', LOV_TAGNAME:'roomtype',
        USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR', LOV_ALIAS_NAME_1:'param.propertycode',
        LOV_ALIAS_VALUE_1:'HRCEN', LOV_ALIAS_TYPE_1:'text' };
      let kind = null;
      if (state === 'initial_armed' && matchesSavedStageRequest(request, frame, SAVED_ROOM_STAGE_PATHS[0], {
        ...base, REQUEST_TYPE:'LOV.HEAD_DATA.STORED', popup:'true', filterfields:'roomtypecode',
        filteroperator:'CONTAINS', filtervalue:current })) kind = 'initial';
      else if (state === 'reset_armed' && matchesSavedStageRequest(request, frame, SAVED_ROOM_STAGE_PATHS[1], {
        ...base, ...grid, REQUEST_TYPE:'LOV.DATA_ONLY.STORED' })) kind = 'reset';
      else if (state === 'change_armed' && matchesSavedStageRequest(request, frame, SAVED_ROOM_STAGE_PATHS[2], { ...native, ...chosen })) kind = 'change';
      else if (state === 'change_consumed' && matchesSavedStageRequest(request, frame, SAVED_ROOM_STAGE_PATHS[3], { ...native, ...chosen })) kind = 'refresh';
      if (!kind) { state = 'closed'; return false; }
      requests.set(kind, request); state = `${kind}_consumed`; return true;
    },
    isRequest(kind, request) { return requests.get(kind) === request; },
    isActive() { return active(); },
    close() { state = 'closed'; },
  });
  issued.add(gate); return gate;
}
