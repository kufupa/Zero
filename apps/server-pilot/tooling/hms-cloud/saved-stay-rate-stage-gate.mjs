// Validate one HMS-listed rate before allowing its unsaved saved-stay change.
import { matchesSavedStageRequest } from './saved-stay-room-stage-gate.mjs';
import { parseSavedStayNativeResponse } from './saved-stay-native-response.mjs';

export const SAVED_RATE_STAGE_PATHS = Object.freeze([
  '/web/base/fieldvalidate', '/web/base/OSRESV.HDR.rateplanchange', '/web/base/OSRESV.HDR.attributerefresh',
  '/web/base/LOVPOP', '/web/base/GRIDDATA',
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
  let state = 'ready', native, target, trackTarget, trackGrid, trackRows, validationGrid = 'LVRATEPLANS2', chargeVerified = false;
  const requests = new Map();
  const active = () => {
    if (performance.now() >= deadlineAt) state = 'closed';
    return state !== 'closed';
  };
  const armTrack = (snapshot, next, readOnly = false) => {
    const data = snapshot?.data, display = snapshot?.values?.track;
    if (!active() || state !== 'ready' || !data || typeof display !== 'string' || String(data.track ?? '') !== display ||
        data.propertycode !== 'HRCEN' || data.status !== 'Reserved' ||
        String(data.confirmationnumber ?? '') !== selected.confirmation || String(data.guestid ?? '') !== selected.guestId ||
        String(data.reservationstayid ?? '') !== selected.reservationStayId || String(data.reservationid ?? '') !== selected.reservationId ||
        String(data.recordid ?? '') !== selected.recordId ||
        (!readOnly && (![false, 0, '0', 'false', ''].includes(data.udfchkbox04) ||
          !next || !/^[A-Z0-9]{1,12}$/.test(next.lookupCode || '') || typeof next.display !== 'string' ||
          !next.display.trim() || next.display !== next.display.trim() || next.display.length > 200 || /[\p{Cc}]/u.test(next.display)))) return false;
    native = { track: display }; trackTarget = readOnly ? null : next; trackRows = null; state = 'track_popup_armed'; return true;
  };
  const gate = Object.freeze({
    armTrack(snapshot, next) { return armTrack(snapshot, next); },
    armTrackRead(snapshot) { return armTrack(snapshot, null, true); },
    armTrackReset(metadata) {
      if (!active() || state !== 'track_popup_consumed' || metadata?.GRIDNAME !== 'LVTRACKCODE' ||
          !/^\d+$/.test(String(metadata.GRIDID ?? '')) || !/^\d+$/.test(String(metadata.DATASPYID ?? ''))) return false;
      trackGrid = { GRID_ID: String(metadata.GRIDID), DATASPY_ID: String(metadata.DATASPYID) };
      state = 'track_reset_armed'; return true;
    },
    verifyTrackRows(status, body) {
      if (!active() || state !== 'track_reset_consumed' || status !== 200) return false;
      try {
        const grid = parseSavedStayNativeResponse(body)?.grid?.GRIDRESULT?.GRID, rows = grid?.DATA;
        if (grid?.METADATA?.GRIDNAME !== 'LVTRACKCODE' || grid.METADATA.MORERECORDPRESENT !== '-' ||
            !Array.isArray(rows) || Number(grid.METADATA.RECORDS) !== rows.length ||
            rows.some(row => !/^[A-Z0-9]{1,12}$/.test(row?.trackcode || '') || typeof row?.tcddesc !== 'string' ||
              !row.tcddesc.trim() || row.tcddesc !== row.tcddesc.trim() || row.tcddesc.length > 200 || /[\p{Cc}]/u.test(row.tcddesc)) ||
            new Set(rows.map(row => row.trackcode)).size !== rows.length ||
            (trackTarget && rows.filter(row => row.trackcode === trackTarget.lookupCode && row.tcddesc === trackTarget.display).length !== 1)) return false;
        trackRows = rows.map(row => ({ code: row.trackcode, label: row.tcddesc }));
        state = 'track_verified'; return true;
      } catch { return false; }
    },
    trackChoices() { return active() && state === 'track_verified' && trackRows ? structuredClone(trackRows) : null; },
    completeTrack() {
      if (!active() || state !== 'track_verified') return false;
      state = 'ready'; return true;
    },
    armCharge(snapshot, current, next) {
      const data = snapshot?.data;
      if (!active() || state !== 'ready' || !data || !/^(?:[A-Z0-9]{1,12})?$/.test(current || '') ||
          !/^(?:[A-Z0-9]{1,12})?$/.test(next || '') || current === next || String(data.roomtypecharge ?? '') !== current ||
          data.propertycode !== 'HRCEN' || data.status !== 'Reserved' ||
          String(data.confirmationnumber ?? '') !== selected.confirmation || String(data.guestid ?? '') !== selected.guestId ||
          String(data.reservationstayid ?? '') !== selected.reservationStayId ||
          String(data.reservationid ?? '') !== selected.reservationId || String(data.recordid ?? '') !== selected.recordId ||
          ![false, 0, '0', 'false', ''].includes(data.udfchkbox04)) return false;
      const names = ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid', 'recordid',
        'status', 'firstname', 'lastname', 'arrivaldate', 'departuredate', 'adults', 'children', 'roomtype', 'rateplan',
        'guaranteetype', 'udfchkbox04', 'udfchar13', 'emailaddress'];
      if (names.some(name => !Object.hasOwn(data, name) ||
          (data[name] != null && !['string', 'number', 'boolean'].includes(typeof data[name])))) return false;
      native = Object.fromEntries(names.map(name => [name, String(data[name] ?? '')]));
      if (data.udfchkbox04 === false) native.udfchkbox04 = '0';
      target = next; validationGrid = 'LVROOMTYPE2'; chargeVerified = false; state = next ? 'charge_armed' : 'charge_validated'; return true;
    },
    completeCharge(status, body) {
      if (!active() || state !== 'charge_refresh_consumed' || status !== 200) return false;
      try {
        const values = parseSavedStayNativeResponse(body)?.values;
        if (!values || !Object.hasOwn(values, 'roomtypecharge') || String(values.roomtypecharge ?? '') !== target) return false;
        chargeVerified = true; state = 'ready'; return true;
      } catch { return false; }
    },
    chargeVerified() { return chargeVerified && active(); },
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
      target = next; validationGrid = 'LVRATEPLANS2'; state = 'validation_armed'; return true;
    },
    consume(request) {
      if (!active()) return false;
      let kind = null;
      const trackBase = { GRID_NAME:'LVTRACKCODE', GRID_TYPE:'LOV', LOV_TAGNAME:'track',
        USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR', LOV_ALIAS_NAME_1:'param.propertycode',
        LOV_ALIAS_VALUE_1:'HRCEN', LOV_ALIAS_TYPE_1:'text' };
      if (state === 'track_popup_armed' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[3], {
        ...trackBase, REQUEST_TYPE:'LOV.HEAD_DATA.STORED', popup:'true', filterfields:'tcddesc',
        filteroperator:'CONTAINS', filtervalue:native.track })) kind = 'track_popup';
      else if (state === 'track_reset_armed' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[4], {
        ...trackBase, ...trackGrid, REQUEST_TYPE:'LOV.DATA_ONLY.STORED' })) kind = 'track_reset';
      else if (state === 'charge_armed' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[0], {
        GRID_NAME:'LVROOMTYPE2', GRID_TYPE:'LOV', REQUEST_TYPE:'LOV.HEAD_DATA.STORED', LOV_TAGNAME:'roomtypecharge',
        USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR', LOV_ALIAS_NAME_1:'param.propertycode',
        LOV_ALIAS_VALUE_1:'HRCEN', filterfields:'roomtypecode', filteroperator:'=', filtervalue:target })) kind = 'validation';
      else if (state === 'validation_armed' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[0], {
        GRID_NAME:'LVRATEPLANS2', GRID_TYPE:'LOV', REQUEST_TYPE:'LOV.HEAD_DATA.STORED', LOV_TAGNAME:'rateplan',
        USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR', LOV_ALIAS_NAME_1:'param.propertycode', LOV_ALIAS_VALUE_1:'HRCEN',
        LOV_ALIAS_NAME_2:'param.arrivaldate', LOV_ALIAS_VALUE_2:native.arrivaldate,
        LOV_ALIAS_NAME_3:'param.departuredate', LOV_ALIAS_VALUE_3:native.departuredate,
        filterfields:'rateplancode', filteroperator:'=', filtervalue:target })) kind = 'validation';
      else if (state === 'charge_validated' && matchesSavedStageRequest(request, frame, SAVED_RATE_STAGE_PATHS[2],
        { ...native, roomtypecharge:target, ONLY_DATA_REQUIRED:'true', SYSTEM_FUNCTION_NAME:'OSRESV',
          USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR' })) kind = 'charge_refresh';
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
        const field = validationGrid === 'LVROOMTYPE2' ? 'roomtypecode' : 'rateplancode';
        if (grid?.METADATA?.GRIDNAME !== validationGrid || !Array.isArray(grid.DATA) ||
            grid.DATA.filter((row) => String(row[field] ?? '') === target).length !== 1) return false;
        if (validationGrid === 'LVROOMTYPE2') state = 'charge_validated';
        else state = 'validation_verified';
        return true;
      } catch { return false; }
    },
    isRequest(kind, request) { return requests.get(kind) === request; },
    isActive() { return active(); },
    close() { state = 'closed'; },
  });
  issued.add(gate); return gate;
}
