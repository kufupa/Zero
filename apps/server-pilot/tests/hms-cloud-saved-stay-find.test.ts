import { describe, expect, it } from 'vitest';
import { projectCloudStayFind, stampCloudStayReadResult } from '../src/ai/hms-cloud-saved-stay-find.js';

describe('Cloud saved-stay projection', () => {
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
        { name: 'guestfullname', label: 'Guest Name', value: 'Test Guest' },
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
      company: { name: 'Test Organization' }, agency: { name: 'Test Agency' },
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
      groupName: { state: 'observed', value: 'Test Group' },
      promotionCode: { state: 'observed', value: 'PROMO-A' },
      arAccountName: { state: 'observed', value: 'Test Account' },
      bookerName: { state: 'observed', value: 'Test Booker' },
      bookerContact: { state: 'observed', value: 'Reservations Desk' },
    });
    expect(JSON.stringify(result)).not.toContain('guest@example.test');
    expect(projectCloudStayFind(savedStayRequest, {
      ...raw,
      shallow: { ...raw.shallow, confirmation: '999999-1' },
    })).toEqual(expect.objectContaining({ outcome: 'execution_failure', stay: null }));
  });

});
