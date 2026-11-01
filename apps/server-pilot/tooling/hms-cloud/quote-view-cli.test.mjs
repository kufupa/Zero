import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getQuoteView } from './quote-view.mjs';
import { projectQuoteRequest } from './quote-view-cli.mjs';

const cli = fileURLToPath(new URL('./quote-view-cli.mjs', import.meta.url));

// Synthetic fixture exercises projection, not correctness against an HMS oracle.
function snapshot() {
  return {
    outcome: 'ok', observedAt: '2026-11-01T12:00:00Z',
    requestedCriteria: { propertyCode: 'HRCEN', arrivalDate: '2027-03-15', departureDate: '2027-03-17',
      adults: 2, childAges: [], roomTypes: ['STQN'], ratePlans: ['BAR'], roomQuantity: 2 },
    appliedCriteria: { propertyCodes: 'HRCEN', startDate: '2027-03-15', numberOfDays: 2,
      adultCount: 2, childCount: 0, roomTypeCodes: 'STQN', ratePlanCodes: 'BAR',
      groupID: '', organizationID: '', travelAgencyID: '' },
    response: { availabilitydata: { datesList: ['2027-03-15', '2027-03-16'], children: [{
      isprop: true, issummary: false, code: 'HRCEN', columns: {
        col1: { restricted: false }, col2: { restricted: false },
      }, children: [{ code: 'STQN', columns: { col1: { value: 3 }, col2: { value: 1 } }, children: [{
        code: 'BAR', currency: 'ZAR', restricted: false, columns: {
          col1: { value: '100.10', restricted: false, combClosed: false, israteavailable: true },
          col2: { value: '200.20', restricted: false, combClosed: false, israteavailable: true },
        },
      }] }],
    }] } },
  };
}

function invoke(input, args = ['--json-stdin']) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
}

test('offline request preserves the native bounded view and night cursor', () => {
  const saved = snapshot();
  const view = { nightLimit: 1, includeNightlyValueSum: true };
  const result = projectQuoteRequest({ snapshot: saved, view });
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(result.view, getQuoteView(saved, view));
  assert.equal(result.view.coverage.nights.nextOffset, 1);
  assert.equal(result.view.options[0].roomQuantity.status, 'partial');
  assert.equal(result.view.options[0].nightlyValueSum.outcome, 'unavailable');
  assert.equal(result.view.options[0].roomQuantity.allNightsShown, false);
  const second = projectQuoteRequest({ snapshot: saved, view: { nightOffset: 1, nightLimit: 1 } });
  assert.equal(second.view.options[0].nights[0].roomQuantity.status, 'shortfall');
  assert.equal(second.view.options[0].nights[0].roomQuantity.observedShortfall, 1);
});

test('unknown quantity, inventory and conflicting criteria remain distinct', () => {
  const saved = snapshot();
  delete saved.requestedCriteria.roomQuantity;
  delete saved.response.availabilitydata.children[0].children[0].columns.col1.value;
  const unknownQuantity = projectQuoteRequest({ snapshot: saved });
  assert.equal(unknownQuantity.view.roomQuantity.gap, 'ROOM_QUANTITY_UNKNOWN');
  assert.equal(unknownQuantity.view.options[0].nights[0].roomQuantity.status, 'quantity_unknown');
  const unknownInventory = projectQuoteRequest({ snapshot: saved, view: { roomQuantity: 2 } });
  assert.equal(unknownInventory.view.options[0].nights[0].roomQuantity.status, 'inventory_unknown');
  saved.appliedCriteria.adultCount = 1;
  const conflict = projectQuoteRequest({ snapshot: saved, view: { roomQuantity: 2 } });
  assert.equal(conflict.view.coverage.checkedCriteriaMatch.occupancy, false);
  assert.ok(conflict.view.options[0].nights[1].reasons.includes('unknown'));
});

test('optional arithmetic is not an official price or joint availability', () => {
  const result = projectQuoteRequest({ snapshot: snapshot(), view: { includeNightlyValueSum: true } });
  const sum = result.view.options[0].nightlyValueSum;
  assert.equal(sum.outcome, 'calculated');
  assert.equal(sum.value, '300.30');
  assert.equal(sum.priceBasis, 'unknown');
  assert.equal(sum.quantityBasis, 'unknown');
  assert.equal(sum.finalTotal, 'unknown');
  assert.equal(result.view.roomQuantity.combinedAvailability, 'unknown');
  const missing = snapshot();
  delete missing.response.availabilitydata.children[0].children[0].children[0].currency;
  assert.equal(projectQuoteRequest({ snapshot: missing, view: { includeNightlyValueSum: true } })
    .view.options[0].nightlyValueSum.outcome, 'unavailable');
});

test('rejects malformed snapshots, contradictory quantity and non-allowlisted tools', () => {
  assert.equal(projectQuoteRequest({ snapshot: {} }).issue, 'QUOTE_PROJECTION_FAILED');
  assert.equal(projectQuoteRequest({ snapshot: snapshot(), view: { roomQuantity: 3 } }).issue, 'ROOM_QUANTITY_MISMATCH');
  assert.equal(projectQuoteRequest({ snapshot: snapshot(), view: { roomCount: 2 } }).issue, 'INVALID_QUOTE_VIEW');
  assert.equal(projectQuoteRequest({ snapshot: snapshot(), view: { nightLimit: 0 } }).issue, 'INVALID_AVAILABILITY_VIEW_PAGE');
  assert.equal(projectQuoteRequest({ snapshot: snapshot(), view: { tool: 'openCancel' } }).issue, 'INVALID_QUOTE_VIEW');
  assert.equal(projectQuoteRequest({ snapshot: snapshot(), tool: 'confirmCancel' }).issue, 'QUOTE_SNAPSHOT_REQUIRED');
});

test('criteria unavailable remains distinct and stdout CLI preserves projection', () => {
  const unavailable = projectQuoteRequest({ snapshot: { outcome: 'criteria_unavailable' } });
  assert.equal(unavailable.outcome, 'ok');
  assert.equal(unavailable.snapshotOutcome, 'criteria_unavailable');
  const request = { snapshot: snapshot(), view: { nightLimit: 1 } };
  const run = invoke(JSON.stringify(request));
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), projectQuoteRequest(request));
  assert.equal(run.stderr, '');
});

test('CLI returns private-safe errors for invalid JSON and missing flag', () => {
  const invalid = invoke('{"secret":"do-not-echo"');
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout), { outcome: 'input_gap', issue: 'INVALID_JSON' });
  assert.ok(!invalid.stdout.includes('do-not-echo'));
  const missingFlag = invoke('', []);
  assert.equal(missingFlag.status, 1);
  assert.equal(JSON.parse(missingFlag.stdout).issue, 'EXPECTED_JSON_STDIN');
});

test('row pagination and restrictions survive the offline projection', () => {
  const saved = snapshot();
  const rates = saved.response.availabilitydata.children[0].children[0].children;
  const second = structuredClone(rates[0]);
  second.code = 'OFF';
  second.columns.col1.restricted = true;
  rates.push(second);
  saved.requestedCriteria.ratePlans = ['BAR', 'OFF'];
  saved.appliedCriteria.ratePlanCodes = 'BAR,OFF';
  const firstPage = projectQuoteRequest({ snapshot: saved, view: { limit: 1 } });
  assert.equal(firstPage.view.coverage.page.nextOffset, 1);
  const nextPage = projectQuoteRequest({ snapshot: saved, view: { limit: 1, offset: 1 } });
  assert.equal(nextPage.view.options[0].rate.code, 'OFF');
  assert.ok(nextPage.view.options[0].nights[0].reasons.includes('closed_or_restricted'));
  assert.equal(nextPage.view.coverage.page.nextOffset, null);
});
