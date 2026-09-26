import { describe, expect, it } from 'vitest';
import { projectFolioBalanceFromDetailDump } from '../src/hms/folio-detail-projection.js';

describe('projectFolioBalanceFromDetailDump', () => {
  it('maps dump-proved balance + balancecurr into folio balance claims', () => {
    const projected = projectFolioBalanceFromDetailDump({
      schemaVersion: 1,
      surface: 'guest_stay_detail',
      keys: ['balance', 'balancecurr', 'confirmationnumber'],
      values: {
        balance: '12.50',
        balancecurr: 'ZAR',
      },
    });
    expect(projected.status).toBe('available');
    expect(projected.totalBalance).toBe('12.50');
    expect(projected.currency).toBe('ZAR');
    expect(projected.claimKeys).toEqual(
      expect.arrayContaining(['balance.totalBalance', 'balance.currency']),
    );
    expect(projected.depositsReasonCode).toBe('SURFACE_UNPROVEN');
  });

  it('stays unavailable when money shape is wrong', () => {
    const projected = projectFolioBalanceFromDetailDump({
      schemaVersion: 1,
      surface: 'guest_stay_detail',
      keys: ['balance', 'balancecurr'],
      values: { balance: '12', balancecurr: 'ZAR' },
    });
    expect(projected.status).toBe('unavailable');
    expect(projected.reasonCode).toBe('SURFACE_UNPROVEN');
  });
});
