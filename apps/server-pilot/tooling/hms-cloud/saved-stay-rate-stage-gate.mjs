// Validate one HMS-listed rate before allowing its unsaved saved-stay change.
import { matchesSavedStageRequest } from './saved-stay-room-stage-gate.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';

export const SAVED_RATE_STAGE_PATHS = Object.freeze([
  '/web/base/fieldvalidate', '/web/base/OSRESV.HDR.rateplanchange', '/web/base/OSRESV.HDR.attributerefresh',
]);
const issued = new WeakSet();
export const isSavedRateStageRequestGate = (gate) => Boolean(gate && issued.has(gate));

export function createSavedRateStageRequestGate({ frame, selected, deadlineAt } = {}) {
  if (!frame || selected?.propertyCode !== 'HRCEN' || selected.status !== 'Reserved' ||
      !/^\d{6,}-\d+$/.test(selected.confirmation || '') || !/^\d+$/.test(selected.guestId || '') ||
      !/^\d+$/.test(selected.reservationStayId || '') || !/^\d+$/.test(selected.reservationId || '') ||
      !/^\d+$/.test(selected.recordId || '') || !Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    throw new Error('RATE_STAGE_GATE_INPUT_INVALID');
  }
  let state = 'ready', native, target;
  const requests = new Map();
  const active = () => {
    if (performance.now() >= deadlineAt) state = 'closed';
    return state !== 'closed';
  };
  const gate = Object.freeze({
    arm(snapshot, current, next) {
      const data = snapshot?.data;
      if (!active() || state !== 'ready' || !data || !/^(?:[A-Z0-9]{1,12})?$/.test(current || '') ||
          !/^[A-Z0-9]{1,12}$/.test(next || '') || current === next || String(data.rateplan ?? '') !== current ||
          data.propertycode !== 'HRCEN' || data.status !== 'Reserved' ||
          String(data.confirmationnumber ?? '') !== selected.confirmation || String(data.guestid ?? '') !== selected.guestId ||
          String(data.reservationstayid ?? '') !== selected.reservationStayId ||
          String(data.reservationid ?? '') !== selected.reservationId || String(data.recordid ?? '') !== selected.recordId ||
          String(data.firstname ?? '') !== selected.firstName || String(data.lastname ?? '') !== selected.lastName ||
          ![false, 0, '0', 'false', ''].includes(data.udfchkbox04)) return false;
      const names = ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid', 'recordid',
        'status', 'firstname', 'lastname', 'arrivaldate', 'departuredate', 'adults', 'children', 'roomtype',
        'guaranteetype', 'udfchkbox04', 'udfchar13', 'emailaddress'];
      if (names.some((name) => !Object.hasOwn(data, name) ||
        (data[name] != null && !['string', 'number', 'boolean'].includes(typeof data[name])))) return false;
      native = Object.fromEntries(names.map((name) => [name, String(data[name] ?? '')]));
      if (data.udfchkbox04 === false) native.udfchkbox04 = '0';
      target = next; state = 'validation_armed'; return true;
    },
    consume(request) {
      if (!active()) return false;
      let kind = null;
      if (state === 'validation_armed' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[0], {
        GRID_NAME:'LVRATEPLANS2', GRID_TYPE:'LOV', REQUEST_TYPE:'LOV.HEAD_DATA.STORED', LOV_TAGNAME:'rateplan',
        USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR', LOV_ALIAS_NAME_1:'param.propertycode', LOV_ALIAS_VALUE_1:'HRCEN',
        LOV_ALIAS_NAME_2:'param.arrivaldate', LOV_ALIAS_VALUE_2:native.arrivaldate,
        LOV_ALIAS_NAME_3:'param.departuredate', LOV_ALIAS_VALUE_3:native.departuredate,
        filterfields:'rateplancode', filteroperator:'=', filtervalue:target })) kind = 'validation';
      else if (state === 'validation_verified' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[1],
        { ...native, rateplan:target })) kind = 'change';
      else if (state === 'change_consumed' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[2],
        { ...native, rateplan:target })) kind = 'refresh';
      if (!kind) { state = 'closed'; return false; }
      requests.set(kind, request); state = `${kind}_consumed`; return true;
    },
    verifyValidation(status, body) {
      if (!active() || state !== 'validation_consumed' || status !== 200) return false;
      try {
        const grid = parseSavedStayNativeResponse(body)?.grid?.GRIDRESULT?.GRID;
        if (grid?.METADATA?.GRIDNAME !== 'LVRATEPLANS2' || !Array.isArray(grid.DATA) ||
            grid.DATA.filter((row) => String(row.rateplancode ?? '') === target).length !== 1) return false;
        state = 'validation_verified'; return true;
      } catch { return false; }
    },
    isRequest(kind, request) { return requests.get(kind) === request; },
    isActive() { return active(); },
    close() { state = 'closed'; },
  });
  issued.add(gate); return gate;
}
