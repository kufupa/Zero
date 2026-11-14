import { describe, expect, it, vi } from 'vitest';
import { projectCloudStayFind, readCloudStayForPane, runCloudStayFind, stampCloudStayReadResult } from '../src/ai/hms-cloud-saved-stay-find.js';
import { CENTURION_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';

describe('Cloud saved-stay projection', () => {
  it('requests the smaller identity observation only when explicitly selected for filing', async () => {
    const runTool = vi.fn().mockResolvedValue({ outcome: 'ok' });
    await readCloudStayForPane({ runTool }, { confirmation: '123456-1', arrival: '2027-01-10' }, true);
    expect(runTool).toHaveBeenCalledWith({ tool: 'read', confirmation: '123456-1', arrivalDate: '2027-01-10',
      view: 'record', includeNativePreimage: true, includeNativeIdentityOnly: true });
  });
  it('retries only arrival-hint mismatch and verifies the resulting stay', async () => {
    const request = { confirmation: '123456-1', arrival: '2027-01-10' };
    const raw = {
      outcome: 'ok', shallow: { confirmation: '123456-1', searchResults: { complete: true } },
      record: { details: { fields: [
        { name: 'firstname', value: 'Test' }, { name: 'lastname', value: 'Guest' },
        { name: 'arrivaldate', value: '12-Jan-2027' },
      ] } },
    };
    const runTool = vi.fn().mockResolvedValueOnce({ outcome: 'read_failed', issue: 'CONFIRMATION_HINT_MISMATCH' })
      .mockResolvedValueOnce(raw);
    const result = await readCloudStayForPane({ runTool }, request);
    expect(runTool.mock.calls).toEqual([
      [{ tool: 'read', confirmation: '123456-1', arrivalDate: '2027-01-10', view: 'record', includeNativePreimage: true }],
      [{ tool: 'read', confirmation: '123456-1', view: 'record', includeNativePreimage: true }],
    ]);
    expect(projectCloudStayFind(request, result)).toEqual(expect.objectContaining({
      outcome: 'found', guestName: 'Test Guest', arrivalMismatch: true, hmsArrival: '2027-01-12',
    }));
    const unsafe = vi.fn().mockResolvedValueOnce({ outcome: 'read_failed', issue: 'CONFIRMATION_HINT_MISMATCH' })
      .mockResolvedValueOnce({ ...raw, shallow: { ...raw.shallow, searchResults: { complete: false } } });
    expect(projectCloudStayFind(request, await readCloudStayForPane({ runTool: unsafe }, request)).outcome).toBe('ambiguous');
    const otherFailure = vi.fn().mockResolvedValue({ outcome: 'read_failed', issue: 'SEARCH_RESULTS_CAPPED' });
    await readCloudStayForPane({ runTool: otherFailure }, request);
    expect(otherFailure).toHaveBeenCalledTimes(1);
  });

  it('projects native identity only when it matches the selected visible stay', () => {
    const fields = [
      { name: 'status', value: 'Reserved' }, { name: 'guestid', value: '42' },
      { name: 'firstname', value: 'Proof' }, { name: 'lastname', value: 'Labtest' },
      { name: 'arrivaldate', value: '10-Jan-2027' }, { name: 'departuredate', value: '12-Jan-2027' },
      { name: 'roomtype', value: 'STQN' }, { name: 'rateplan', value: 'BAR' },
      { name: 'adults', value: '2' }, { name: 'children', value: '0' },
    ];
    const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1',
      guestId: '42', reservationStayId: '81', reservationId: '82', recordId: '83',
      status: 'Reserved', firstName: 'Proof', lastName: 'Labtest', arrival: '2027-01-10',
      departure: '2027-01-12', roomType: 'STQN', ratePlan: 'BAR', adults: 2, children: 0, childAges: 'unknown' };
    const raw = (observed: unknown) => ({ outcome: 'ok', shallow: { confirmation: '123456-1', searchResults: { complete: true } },
      record: { details: { fields }, nativePreimage: observed } });
    expect(projectCloudStayFind({ confirmation: '123456-1' }, raw(native)).nativePreimage).toEqual(native);
    for (const propertyCode of ['HRDAV', 'HRDAVS']) {
      const selected = { ...native, propertyCode };
      expect(projectCloudStayFind({ confirmation: '123456-1' }, raw(selected), propertyCode).nativePreimage).toEqual(selected);
      expect(projectCloudStayFind({ confirmation: '123456-1' }, raw(selected)).nativePreimage).toBeNull();
      expect(projectCloudStayFind({ confirmation: '123456-1' }, raw(native), propertyCode).nativePreimage).toBeNull();
    }
    for (const bad of [null, { ...native, confirmation: '999999-1' }, { ...native, guestId: '44' },
      { ...native, propertyCode: 'HRDAV' }, { ...native, reservationStayId: '' },
      { ...native, childAges: [8] }, { ...native, arrival: '2027-01-11' }]) {
      expect(projectCloudStayFind({ confirmation: '123456-1' }, raw(bad)).nativePreimage).toBeNull();
    }
  });

  it('passes party IDs to sender history only for the matching native stay and visible names', () => {
    const fields = [
      { name: 'status', value: 'Reserved' }, { name: 'guestid', value: '42' },
      { name: 'firstname', value: 'Proof' }, { name: 'lastname', value: 'Labtest' },
      { name: 'arrivaldate', value: '10-Jan-2027' }, { name: 'departuredate', value: '12-Jan-2027' },
      { name: 'roomtype', value: 'STQN' }, { name: 'rateplan', value: 'BAR' },
      { name: 'adults', value: '2' }, { name: 'children', value: '0' },
      { name: 'company', value: 'Test Company' }, { name: 'ta1', value: 'Test Agency' },
    ];
    const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1',
      guestId: '42', reservationStayId: '81', reservationId: '82', recordId: '83', status: 'Reserved',
      firstName: 'Proof', lastName: 'Labtest', arrival: '2027-01-10', departure: '2027-01-12',
      roomType: 'STQN', ratePlan: 'BAR', adults: 2, children: 0, childAges: 'unknown',
      commercial: { company: { name: 'Test Company', nativeId: '0042' }, agency: { name: 'Test Agency', nativeId: '73' } } };
    const read = (observed: unknown, visible = fields) => projectCloudStayFind({ confirmation: '123456-1' }, {
      outcome: 'ok', shallow: { confirmation: '123456-1', searchResults: { complete: true } },
      record: { details: { fields: visible }, nativePreimage: observed },
    });
    expect(read(native).commercial).toEqual({ organization: native.commercial.company, bookingAgency: native.commercial.agency });
    const namesOnly = { organization: { name: 'Test Company' }, bookingAgency: { name: 'Test Agency' } };
    expect(read({ ...native, propertyCode: 'HRDAV' }).commercial).toEqual(namesOnly);
    expect(read({ ...native, confirmation: '999999-1' }).commercial).toEqual(namesOnly);
    expect(read({ ...native, guestId: '44' }).commercial).toEqual(namesOnly);
    expect(read({ ...native, commercial: { company: { name: 'Other Company', nativeId: '0042' } } }).commercial).toEqual(namesOnly);
    expect(read({ ...native, commercial: { company: { name: 'Test Company', nativeId: '0' } } }).commercial).toEqual(namesOnly);
    expect(read({ ...native, commercial: { company: { name: 'Test Company', nativeId: 'x42' } } }).commercial).toEqual(namesOnly);
    expect(read(native, [...fields, { name: 'company', value: 'Other Company' }]).commercial).toEqual({ bookingAgency: native.commercial.agency });
  });

  it('accepts exact adult labels only when the visible and native counts agree', () => {
    const fields = [
      { name: 'status', value: 'Reserved' }, { name: 'guestid', value: '42' },
      { name: 'firstname', value: 'Proof' }, { name: 'lastname', value: 'Labtest' },
      { name: 'arrivaldate', value: '10-Jan-2027' }, { name: 'departuredate', value: '12-Jan-2027' },
      { name: 'roomtype', value: 'STQN' }, { name: 'rateplan', value: 'BAR' },
      { name: 'adults', value: '1 Adult' }, { name: 'children', value: '0' },
    ];
    const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1',
      guestId: '42', reservationStayId: '81', reservationId: '82', recordId: '83', status: 'Reserved',
      firstName: 'Proof', lastName: 'Labtest', arrival: '2027-01-10', departure: '2027-01-12',
      roomType: 'STQN', ratePlan: 'BAR', adults: 1, children: 0, childAges: 'unknown' };
    const read = () => projectCloudStayFind({ confirmation: '123456-1' }, {
      outcome: 'ok', shallow: { confirmation: '123456-1', searchResults: { complete: true } },
      record: { details: { fields }, nativePreimage: native },
    });
    expect(read()).toMatchObject({ stay: { adults: 1 }, nativePreimage: native });
    fields.find((field) => field.name === 'adults')!.value = '2 Adults';
    expect(read()).toMatchObject({ stay: { adults: 2 }, nativePreimage: null });
    native.adults = 2;
    expect(read()).toMatchObject({ stay: { adults: 2 }, nativePreimage: native });
    for (const invalid of ['2 Adults extra', '2 Adults1 Child', '2.5 Adults', '-2 Adults']) {
      fields.find((field) => field.name === 'adults')!.value = invalid;
      expect(read()).toMatchObject({ stay: { adults: null }, nativePreimage: null });
    }
  });

  it('reports bounded not-found as ambiguous and preserves a valid search range', () => {
    const result = projectCloudStayFind({ confirmation: '123456-1' }, {
      outcome: 'read_failed', issue: 'CONFIRMATION_NOT_FOUND',
      searchedDateRange: { from: '2027-01-01', to: '2027-01-31' },
    });
    expect(result).toEqual(expect.objectContaining({
      outcome: 'ambiguous', reason: 'CONFIRMATION_NOT_FOUND_IN_SEARCH_WINDOW',
      searchedDateRange: { from: '2027-01-01', to: '2027-01-31' },
    }));
  });

  it('refuses an unsupported target before opening a Cloud session', async () => {
    await expect(runCloudStayFind({
      request: { confirmation: '123456-1' },
      target: { ...CENTURION_HMS_READ_TARGET, browserSlot: 'davinci' },
    })).resolves.toEqual({ outcome: 'execution_failure', issue: 'CLOUD_READ_TARGET_UNSUPPORTED' });
  });

  it('stamps session results that omit their own observation time', () => {
    const result = stampCloudStayReadResult(
      { outcome: 'ok', shallow: { confirmation: '123456-1' }, record: { details: { fields: [] } } },
      '2026-11-02T10:15:00.000Z',
    );
    expect(result).toMatchObject({ observedAt: '2026-11-02T10:15:00.000Z' });
  });

  it('projects only allowlisted saved-stay fields and refuses mismatched record identity', () => {
    const savedStayRequest = { confirmation: '123456-1', arrival: '2027-01-10' };
    const raw = {
      outcome: 'ok',
      shallow: { confirmation: '123456-1', searchResults: { complete: true } },
      record: { details: { fields: [
        { name: 'status', label: 'Status', value: 'Reserved' },
        { name: 'arrivaldate', label: 'Arrival Date', value: '10-Jan-2027' },
        { name: 'arrivaldayofweek', label: 'Arrival Date', value: 'Sunday' },
        { name: 'departuredate', label: 'Departure Date', value: '12-Jan-2027' },
        { name: 'departuredayofweek', label: 'Departure Date', value: 'Tuesday' },
        { name: 'firstname', label: 'First Name', value: 'Test' },
        { name: 'lastname', label: 'Last Name', value: 'Guest' },
        { name: 'company', label: 'Organization', value: 'Test Organization' },
        { name: 'ta1', label: 'Primary Booking Agency', value: 'Test Agency' },
        { name: 'averagerate', label: 'Average Rate', value: '1250.00' },
        { name: 'averageratecurr', label: 'Average Rate', value: 'ZAR' },
        { name: 'grandtotal', label: 'Grand Total', value: '2500.00' },
        { name: 'grandtotalcurr', label: 'Grand Total', value: 'ZAR' },
        { name: 'balance', label: 'Balance', value: '999.00' },
        { name: 'depositreceived', label: 'Deposit Received', value: '' },
        { name: 'depositreceivedcurrency', label: 'Deposit Received', value: 'ZAR' },
        { name: 'udfchar02', label: 'Deposit Due Amount Required', value: '1000.00' },
        { name: 'enhancedexptotal', label: 'Add-On Total', value: '50.00' },
        { name: 'enhancedexptotalcurr', label: 'Add-On Total', value: 'ZAR' },
        { name: 'totalrate', label: 'Total Rate', value: '1275.00' },
        { name: 'totalratecurr', label: 'Total Rate', value: 'ZAR' },
        { name: 'resortfee', label: 'Resort Fee', value: '25.00' },
        { name: 'totalresortfee', label: 'Resort Fee', value: '25.00' },
        { name: 'promotioncode', label: 'Promotion', value: 'PROMO-A' },
        { name: 'groupname', label: 'Group', value: 'Test Group' },
        { name: 'araccountname', label: 'A/R Account', value: 'Test Account' },
        { name: 'caller', label: 'Booker Name', value: 'Test Booker' },
        { name: 'udfchar06', label: 'Booker Contact', value: 'Reservations Desk' },
        { name: 'email', label: 'Email', value: 'guest@example.test' },
      ] } },
    };
    const result = projectCloudStayFind(savedStayRequest, raw);
    expect(result.outcome).toBe('found');
    expect(result.guestName).toBe('Test Guest');
    expect(result.stay).toEqual(expect.objectContaining({
      confirmation: '123456-1', status: 'Reserved', arrival: '2027-01-10', departure: '2027-01-12',
      averageRate: '1250.00', grandTotal: '2500.00', balance: '999.00',
      depositReceived: '', bookingAgency: 'Test Agency', organization: 'Test Organization',
    }));
    expect(result.commercial).toEqual({
      organization: { name: 'Test Organization' }, bookingAgency: { name: 'Test Agency' },
    });
    expect(result.financialObservations).toEqual({
      averageRate: { amount: { state: 'observed', value: '1250.00' }, currency: { state: 'observed', value: 'ZAR' } },
      grandTotal: { amount: { state: 'observed', value: '2500.00' }, currency: { state: 'observed', value: 'ZAR' } },
      balance: { amount: { state: 'observed', value: '999.00' }, currency: { state: 'unknown', value: null } },
      depositReceived: { amount: { state: 'blank', value: '' }, currency: { state: 'observed', value: 'ZAR' } },
      depositDueAmount: { amount: { state: 'observed', value: '1000.00' }, currency: { state: 'unknown', value: null } },
      addOnTotal: { amount: { state: 'observed', value: '50.00' }, currency: { state: 'observed', value: 'ZAR' } },
      totalRate: { amount: { state: 'observed', value: '1275.00' }, currency: { state: 'observed', value: 'ZAR' } },
      resortFee: { amount: { state: 'observed', value: '25.00' }, currency: { state: 'unknown', value: null } },
      totalResortFee: { amount: { state: 'observed', value: '25.00' }, currency: { state: 'unknown', value: null } },
    });
    expect(result.reservationObservations).toEqual({
      guestEmail: { state: 'unknown', value: null },
      groupName: { state: 'observed', value: 'Test Group' },
      promotionCode: { state: 'observed', value: 'PROMO-A' },
      arAccountName: { state: 'observed', value: 'Test Account' },
      bookerName: { state: 'observed', value: 'Test Booker' },
      bookerContact: { state: 'observed', value: 'Reservations Desk' },
      reservationNote: { state: 'unknown', value: null, source: 'unavailable', confirmation: null },
    });
    expect(JSON.stringify(result)).not.toContain('guest@example.test');
    expect(projectCloudStayFind(savedStayRequest, {
      ...raw,
      shallow: { ...raw.shallow, confirmation: '999999-1' },
    })).toEqual(expect.objectContaining({ outcome: 'execution_failure', stay: null }));
  });

});
