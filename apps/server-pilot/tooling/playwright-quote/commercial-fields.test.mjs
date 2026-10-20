import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  mergeStayFormRecord,
  parseCommercialFields,
  snapshotCommercialFields,
  snapshotStayFormRecord,
} from './commercial-fields.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/commercial/${name}`, import.meta.url), 'utf8');

function docFromControls(fields) {
  return {
    querySelector(selector) {
      const match = /^(select|input|textarea)\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return null;
      const [, tag, name] = match;
      const field = fields[name];
      if (!field || field.kind !== (tag === 'select' ? 'select' : 'input')) return null;
      return {
        tagName: tag.toUpperCase(),
        value: field.value,
        querySelector(optionSelector) {
          return tag === 'select' && /option:(?:checked)|option\[selected\]/.test(optionSelector)
            ? { innerText: field.text, textContent: field.text }
            : null;
        },
      };
    },
  };
}

test('synthetic control fixture snapshot preserves display names and native ids', async () => {
  const fields = JSON.parse(await fixture('commercial-controls.json'));
  assert.deepEqual(snapshotCommercialFields(docFromControls(fields)), fields);
});

test('snapshot can read a populated control in a collapsed record section', () => {
  const hiddenControl = {
    tagName: 'INPUT',
    type: 'text',
    value: 'Travel Agency',
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
  const doc = {
    querySelectorAll(selector) {
      return selector === 'input[name="sourceofbusinessdesc"]' ? [hiddenControl] : [];
    },
  };
  assert.deepEqual(snapshotCommercialFields(doc), {
    sourceofbusinessdesc: { value: 'Travel Agency', text: 'Travel Agency', kind: 'input' },
  });
});

test('synthetic opened-record controls normalize to a compact commercial result', async () => {
  const fields = JSON.parse(await fixture('commercial-controls.json'));
  assert.deepEqual(parseCommercialFields(fields), {
    company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
    agency: { name: 'Harbor Travel', nativeId: 'AG-9' },
    ratePlan: 'Corporate Saver',
    mealPlan: 'Bed and Breakfast',
    roomType: 'STQN',
    marketSegment: 'Corporate',
    sourceOfBusiness: 'Travel Agency',
    averageRate: '1250.00',
    status: 'Reserved',
    guaranteeType: 'Guaranteed',
    depositReceived: '0.00',
    arrival: '2027-09-14',
    departure: '2027-09-16',
  });
});

test('missing optional controls never create an empty commercial object', () => {
  assert.equal(parseCommercialFields({}), null);
  assert.deepEqual(parseCommercialFields({}, { status: 'Checked Out', arrival: '2020-01-01' }), {
    status: 'Checked Out', arrival: '2020-01-01',
  });
  assert.deepEqual(parseCommercialFields({}, {
    organization: 'Northstar Conference Group', bookingAgency: 'Harbor Travel',
  }), {
    company: { name: 'Northstar Conference Group' },
    agency: { name: 'Harbor Travel' },
  });
});

test('stay form record keeps companyid and agency IATA, not an agency id', async () => {
  const fields = JSON.parse(await fixture('stay-form-record.json'));
  const parsed = parseCommercialFields(fields);
  assert.deepEqual(parsed.company, { name: 'Woolworths Holdings', nativeId: '49' });
  assert.deepEqual(parsed.agency, { name: 'CWT JNB', iata: '77218175' });
  assert.equal('nativeId' in parsed.agency, false);
});

test('snapshotStayFormRecord reads companyid and IATA from the Ext form record, not visible inputs', () => {
  const record = { companyid: 49, bookingagency1iatanumber: '77218175', ta1: 'CWT JNB' };
  const ta1 = { id: 'ta1-inputEl' };
  const ext = {
    getCmp(id) {
      assert.equal(id, 'ta1');
      return { up: (xtype) => (xtype === 'form' ? { getRecord: () => ({ data: record }) } : null) };
    },
  };
  const doc = { querySelector: (selector) => (selector === 'input[name="ta1"]' ? ta1 : null) };
  assert.deepEqual(snapshotStayFormRecord(ext, doc), {
    companyid: '49',
    bookingagency1iatanumber: '77218175',
  });
  const merged = mergeStayFormRecord(
    { ta1: { value: 'CWT JNB', text: 'CWT JNB', kind: 'input' } },
    snapshotStayFormRecord(ext, doc),
  );
  const parsed = parseCommercialFields(merged);
  assert.deepEqual(parsed.company, { nativeId: '49' });
  assert.deepEqual(parsed.agency, { name: 'CWT JNB', iata: '77218175' });
});

test('keeps a numeric party id even when it equals the name, else uses the select value', async () => {
  const fields = JSON.parse(await fixture('numeric-id-equals-name.json'));
  const parsed = parseCommercialFields(fields);
  assert.deepEqual(parsed.company, { name: '49', nativeId: '49' });
  assert.deepEqual(parsed.agency, { name: 'CWT JNB', nativeId: '290' });
  const nameAsValue = parseCommercialFields({
    ta1: { value: 'Harbor Travel', text: 'Harbor Travel', kind: 'select' },
  });
  assert.deepEqual(nameAsValue.agency, { name: 'Harbor Travel' });
});

test('reads commercial fields from live form snapshot entries', async () => {
  const { commercialFieldsFromFormEntries, parseCommercialFields } = await import('./commercial-fields.mjs');
  const fields = commercialFieldsFromFormEntries([
    { kind: 'label', text: 'Booking Agency' },
    { kind: 'field', name: 'ta1', value: 'Example Travel Agency' },
    { kind: 'field', name: 'company', value: '' },
    { kind: 'field', name: 'rateplan', value: 'BAR1' },
    { kind: 'field', name: 'roomtype', value: 'STWN' },
  ]);
  const parsed = parseCommercialFields(fields, {});
  assert.equal(parsed.agency?.name, 'Example Travel Agency');
  assert.equal(parsed.ratePlan, 'BAR1');
  assert.equal(parsed.company ?? null, null);
});
