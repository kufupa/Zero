import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gotenbergConverter } from './converter.js';
import { createQuoteArtifacts, type Artifact } from './index.js';

// Synthetic-only smoke: no mailbox, guest, HMS or production storage access.
async function main() {
  const [outputDir, converterUrl, propertyCode = 'HRCEN'] = process.argv.slice(2);
  if (!['HRCEN', 'HRDAV'].includes(propertyCode)) throw new Error('UNSUPPORTED_FIXTURE_PROPERTY');
  if (!outputDir || !converterUrl) throw new Error('USAGE: cli <new-output-directory> <private-converter-url>');
  const dir = resolve(outputDir);
  await mkdir(dir, { mode: 0o700 });
  const option = (amount: string, dates: string[]) => ({ availability: 'available', eligibility: 'verified', matchStatus: 'match', room: { code: 'SKNG', label: 'Standard King' },
    rate: { code: 'BAR', label: 'Flexible rate' }, mealPlan: 'Bed & Breakfast', nightly: dates.map(date =>
      ({ date, price: { amount, currency: 'ZAR' }, inventory: 10, restricted: false, rateAvailable: true })) });
  const groups = [
    { group_id: 'synthetic-a', arrival_date: '2027-02-01', departure_date: '2027-02-02', rooms: [
      { id: 'room-a', quantity: 2, adults: 1, children: 0, child_ages: [] },
      { id: 'room-b', quantity: 1, adults: 2, children: 0, child_ages: [] },
    ] },
    { group_id: 'synthetic-b', arrival_date: '2027-03-03', departure_date: '2027-03-08', rooms: [
      { id: 'room-c', quantity: 3, adults: 1, children: 0, child_ages: [] },
    ] },
  ];
  const quote = { quote_id: 'synthetic-quote', proposal_id: 'synthetic-proposal', revision: 7, property_code: propertyCode, authored_date: '2027-01-01',
    header: { attention: 'Example Contact', organization: '', clientEmail: '', clientTelephone: '', signerName: 'Reservations', signerEmail: '' }, groups,
    capture: { quote_id: 'synthetic-quote', property_code: propertyCode, group_order: groups.map(group => group.group_id),
      groups: Object.fromEntries(groups.map(group => [group.group_id, { ...group, status: 'complete', rooms: group.rooms.map(room => ({
        room_id: room.id, native_result: { request: { quantity: room.quantity, adults: room.adults, children: room.children, childAges: room.child_ages }, options: [option(room.id === 'room-b' ? '1200.00' : '1000.00', group.group_id === 'synthetic-a' ? ['2027-02-01'] : ['2027-03-03', '2027-03-04', '2027-03-05', '2027-03-06', '2027-03-07'])] },
      })) }])) },
    selections: groups.flatMap(group => group.rooms.map(room => ({ group_id: group.group_id, room_id: room.id, option_index: 0 }))),
  };
  const run = createQuoteArtifacts({ resolveQuote: async () => quote, convertWorkbook: gotenbergConverter(converterUrl),
    writePair: async ({ pdf, workbook }) => {
      await writeFile(`${dir}/${pdf.name}`, pdf.bytes, { mode: 0o600, flag: 'wx' });
      await writeFile(`${dir}/${workbook.name}`, workbook.bytes, { mode: 0o600, flag: 'wx' });
      const ref = (name: string, mime_type: string): Artifact => { const id = randomUUID(); return { id, name, mime_type, url: `/api/nava/v1/artifacts/${id}` }; };
      return { pdf: ref(pdf.name, pdf.mime_type), workbook: ref(workbook.name, workbook.mime_type) };
    },
  });
  const result = await run({ quote_id: quote.quote_id }, { sessionId: 'synthetic-session', mode: 'labtest' });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, error: result.error, fixture: 'synthetic', outputDir: dir })}\n`);
  if (!result.ok) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('ARTIFACT_SMOKE_FAILED\n'); process.exitCode = 1; });
