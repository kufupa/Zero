import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildQuoteWorkbook } from '../src/quote-proposal/quote-workbook';
import { parseAe1Config, runAe1 } from '../scripts/nava-ae1-rates-proof';
import { parseAe2Config, runAe2 } from '../scripts/nava-ae2-find-proof';

/**
 * Runs both drivers end to end in Chromium against a scripted stand-in for the pane: plain HTML with the pane's labels
 * and a fake tRPC server. It proves the flow (settle, fill, one run per stay, documents, find, screenshots, summary), not
 * the pane itself; the markup tests in the per-driver files tie the selectors to the mail code.
 */

const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find(existsSync);

type Handler = (input: unknown) => unknown;

const TRPC_JS = `
async function trpc(procedure, input) {
  try {
    const response = await fetch('/api/trpc/' + procedure + '?batch=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 0: { json: input } }),
    });
    const [item] = await response.json();
    return item.result.data.json;
  } catch {
    return null;
  }
}`;

const shell = (body: string, script: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<aside><a data-thread-id="t-1"><span class="font-medium">Subject</span></a></aside>
<div data-preview-pane><div data-preview-status="ready"><main class="nava-pane-scroll">${body}</main></div></div>
<script>${TRPC_JS}
${script}</script></body></html>`;

let dir: string;
let server: Server | null = null;
let calls: Array<{ procedure: string; input: unknown }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-proof-drivers-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ cookies: [], origins: [] }));
  calls = [];
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

async function serve(html: string, handlers: Record<string, Handler>): Promise<string> {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    if (url.pathname === '/nava-preview') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      return;
    }
    if (!url.pathname.startsWith('/api/trpc/')) {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      const procedures = url.pathname.slice('/api/trpc/'.length).split(',');
      const body = raw ? (JSON.parse(raw) as Record<string, { json: unknown }>) : {};
      const out = procedures.map((procedure, index) => {
        const input = body[String(index)]?.json;
        calls.push({ procedure, input });
        const handler = handlers[procedure];
        return { result: { data: { json: handler ? handler(input) : null } } };
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const env = (base: string, extra: Record<string, string> = {}) => ({
  NAVA_PREVIEW_BASE_URL: base,
  NAVA_PREVIEW_STORAGE_STATE: join(dir, 'state.json'),
  ...(chromiumBinary ? { NAVA_PREVIEW_CHROMIUM: chromiumBinary } : {}),
  ...extra,
});

// ---------------------------------------------------------------------------------------------------------------------
// AE1

const STAYS = [
  ['2026-10-26', '2026-10-27'],
  ['2026-11-17', '2026-11-18'],
] as const;

function ae1Page(): string {
  const row = (stay: number, room: number, asked: string) => `
    <div class="room" data-stay="${stay - 1}">
      <select aria-label="Room type">
        <option value="">Choose a room type</option>
        <option value="${asked}" selected>Email asked for ${asked} — pick a room type</option>
        <option value="STWN">Standard Twin (STWN)</option><option value="STQN">Standard Queen (STQN)</option>
      </select>
      <div role="group" aria-label="Rooms for stay ${stay}, room ${room}"></div>
      <input aria-hidden="true" type="number" aria-label="Rooms" class="sr-only" value="">
      <input aria-hidden="true" type="number" aria-label="Adults" class="sr-only" value="">
      <select aria-label="Meal plan"><option value="unknown" selected>Not stated yet</option><option value="bb">B&amp;B</option></select>
    </div>`;
  const body = `
    <select aria-label="Nava reads this as"><option value="quote" selected>Quote request</option></select>
    <section aria-label="Stay details">${row(1, 1, 'Single')}${row(1, 2, 'Double/twin')}${row(2, 1, 'Single')}${row(2, 2, 'Double/twin')}</section>
    <section aria-label="Rates from HMS">
      <p id="rated">0 of 2 stays rated</p>
      <button id="get">Get rates from HMS</button>
      <details open><summary><span>HMS steps</span></summary>
        ${STAYS.map(([a, d], i) => `<button class="step" data-stay="${i}">Run Search availability ${a} → ${d}</button>`).join('')}
      </details>
    </section>
    <section aria-label="Quote documents">
      <button id="pdf">Prepare quote</button><p id="prepared"></p><button id="xlsx">Download Excel</button>
    </section>`;
  const script = `
    const stays = ${JSON.stringify(STAYS)};
    const runs = [];
    trpc('workItems.getByMessage', { messageId: 'm1' });
    // The pane searches the company and the agency by itself; the guard lets only the first through.
    trpc('panePartyLookup.findParty', { name: 'Org', kind: 'company' });
    trpc('panePartyLookup.findParty', { name: 'Org', kind: 'agency' });
    document.querySelectorAll('button.step').forEach((button) => {
      button.onclick = async () => {
        const i = Number(button.dataset.stay);
        const groups = Array.from(document.querySelectorAll('.room[data-stay="' + i + '"]')).map((room, n) => ({
          id: 'g' + i + n,
          arrivalDate: stays[i][0],
          departureDate: stays[i][1],
          roomPreference: room.querySelector('select[aria-label="Room type"]').value,
          quantity: Number(room.querySelector('input[aria-label="Rooms"]').value),
          adults: Number(room.querySelector('input[aria-label="Adults"]').value),
          board: room.querySelector('select[aria-label="Meal plan"]').value,
        }));
        const result = await trpc('workstation.executeStaffQuote', { messageId: 'm1', groups });
        if (!result) return;
        runs.push(result.workflowRunId);
        button.disabled = true;
        document.getElementById('rated').textContent = runs.length + ' of 2 stays rated';
      };
    });
    document.getElementById('pdf').onclick = async () => {
      const result = await trpc('workstation.qualifiedQuoteProposalPdf', {
        workflowRunId: runs[0], additionalStays: runs.slice(1).map((id) => ({ workflowRunId: id })),
      });
      if (result) document.getElementById('prepared').textContent = 'Prepared quote ' + result.fileName + ' for all stays.';
    };
    document.getElementById('xlsx').onclick = () =>
      trpc('workstation.quoteWorkbook', { workflowRunId: runs[0], additionalStays: runs.slice(1).map((id) => ({ workflowRunId: id })) });`;
  return shell(body, script);
}

function ae1Workbook(): string {
  const line = (dateLabel: string, description: string, rateMinor: number) => ({
    dateLabel,
    description,
    qty: 15,
    nights: 1,
    rateMinor,
    totalMinor: 15 * rateMinor,
  });
  const lines = STAYS.flatMap(([a]) => [
    line(a, 'Standard Queen · 1 adult per room · Bed & Breakfast', 150_000),
    line('', 'Standard Twin · 2 adults per room · Bed & Breakfast', 180_000),
  ]);
  const bytes = buildQuoteWorkbook({
    authoredDate: '2026-10-10',
    breakfastIncluded: true,
    header: { attention: 'A', company: 'C', clientEmail: 'c@example.test', clientTelephone: '0', signerName: 'N', signerEmail: 'n@example.test' },
    lines,
  });
  return Buffer.from(bytes).toString('base64');
}

const ae1Handlers = (): Record<string, Handler> => {
  let run = 0;
  return {
    'workItems.getByMessage': () => ({ status: 'ready', workItemId: 'wi-1', analysis: { luna: { workflow: 'quote' } } }),
    'panePartyLookup.findParty': () => ({ outcome: 'no_match', results: [], best: null }),
    'workstation.executeStaffQuote': (input) => {
      run += 1;
      const groups = (input as { groups: Array<{ id: string }> }).groups;
      return {
        status: 'ready',
        workflowRunId: `run-${run}`,
        rowRates: groups.map((group) => ({ groupId: group.id, source: 'hms', hmsNightlyMinor: [150_000], nightlyMinor: [150_000] })),
      };
    },
    'workstation.qualifiedQuoteProposalPdf': () => ({
      fileName: 'quote.pdf',
      pdfBase64: Buffer.from('%PDF-1.4\n%fake\n').toString('base64'),
    }),
    'workstation.quoteWorkbook': () => ({ fileName: 'quote.xlsx', xlsxBase64: ae1Workbook() }),
  };
};

describe('AE1 driver against a scripted pane', () => {
  it.skipIf(!chromiumBinary)(
    'fills the rows, rates each stay once, and checks the PDF and the Excel',
    async () => {
      const base = await serve(ae1Page(), ae1Handlers());
      const out = join(dir, 'ae1-rates-test');
      const config = parseAe1Config(['--threads', 't-1', '--out', out, '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe1(config, () => undefined);
      expect(summary.failures).toEqual([]);
      expect(summary).toMatchObject({
        ok: true,
        stays: 2,
        paneRows: 4,
        staysRated: 2,
        ratesRuns: 2,
        hmsReads: 3,
        partyLookups: 1,
        pdf: true,
        pdfStays: 2,
        xlsxStays: 2,
        xlsxRows: 4,
        expectedXlsxRows: 4,
        xlsxExtraRows: 0,
        xlsxTotalRow: true,
        workflowRunIds: ['run-1', 'run-2'],
        blocked: ['panePartyLookup.findParty (second_party_lookup)'],
        screenshots: { rates: true, documents: true, pane: true },
      });
      expect(summary.roomSplitUsed.rows.map((row) => `${row.askedType}->${row.roomType}x${row.rooms}/${row.adults}/${row.board}`)).toEqual([
        'Single->STQNx15/1/bb',
        'Double/twin->STWNx15/2/bb',
        'Single->STQNx15/1/bb',
        'Double/twin->STWNx15/2/bb',
      ]);
      // What the rates runs carried is what the driver typed.
      const ratesInputs = calls.filter((call) => call.procedure === 'workstation.executeStaffQuote');
      expect(ratesInputs).toHaveLength(2);
      expect((ratesInputs[0]!.input as { groups: unknown[] }).groups).toEqual([
        expect.objectContaining({ roomPreference: 'STQN', quantity: 15, adults: 1, board: 'bb' }),
        expect.objectContaining({ roomPreference: 'STWN', quantity: 15, adults: 2, board: 'bb' }),
      ]);
      for (const file of ['quote.pdf', 'quote.xlsx', 'rates.png', 'documents.png', 'pane.png']) {
        expect(statSync(join(out, file)).size, file).toBeGreaterThan(0);
      }
      expect(statSync(out).mode & 0o777).toBe(0o700);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'stops with a blocker when the pane does not take a room count',
    async () => {
      // The Rooms inputs ignore typing, as a pane that refused the value would.
      const html = ae1Page().replace(
        'const stays =',
        `document.querySelectorAll('input[aria-label="Rooms"]').forEach((el) => el.addEventListener('input', () => { el.value = ''; }));
    const stays =`,
      );
      const base = await serve(html, ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-block'), '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe1(config, () => undefined);
      expect(summary.ok).toBe(false);
      expect(summary.blocker).toBe('the pane did not take the room type, room count, adults or meal plan typed into a row');
      expect(summary.ratesRuns).toBe(0);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// AE2

function ae2Page(): string {
  const body = `
    <select aria-label="Nava reads this as" data-amendment-kind="amend"><option value="other" selected>Amendment</option></select>
    <section data-testid="amend-lookup-panel">
      <p>Booking in HMS now</p><div id="hms"><p>Nothing shown yet.</p></div>
      <div id="actions"><button id="find">Find this booking in HMS</button></div>
    </section>`;
  const script = `
    const row = (field, label, value) =>
      '<div data-field="' + field + '"><p>' + label + '</p><p>' + value + '</p></div>';
    const show = (date) => { const [y, m, d] = date.split('-'); return Number(d) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1] + ' ' + y; };
    trpc('workItems.getByMessage', { messageId: 'm1' });
    trpc('workItems.open', { messageId: 'm1' });
    trpc('paneStayLookup.jobStatus', { threadId: 't-1', kind: 'find', confirmation: '57291630-1' });
    document.getElementById('find').onclick = async () => {
      const queued = await trpc('paneStayLookup.queueFind', { threadId: 't-1', confirmation: '57291630-1', arrival: '2026-11-01' });
      if (!queued) return;
      let view = null;
      while (!view || (view.status !== 'done' && view.status !== 'failed')) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        view = await trpc('paneStayLookup.jobStatus', { runId: queued.runId });
      }
      const stay = view.result.stay;
      document.getElementById('hms').innerHTML =
        row('guest', 'Guest', '<span data-pii>Ana Fixturemann</span>') + row('arrival', 'Arrival', show(stay.arrival)) +
        row('departure', 'Departure', show(stay.departure));
      document.getElementById('actions').remove();
    };`;
  return shell(body, script);
}

describe('AE2 driver against a scripted pane', () => {
  it.skipIf(!chromiumBinary)(
    'clicks Find once and reports the booked dates it sent and the booking HMS holds',
    async () => {
      let polls = 0;
      const base = await serve(ae2Page(), {
        'workItems.getByMessage': () => ({
          status: 'ready',
          analysis: {
            amendment: {
              kind: 'amend',
              confirmationNumber: '57291630-1',
              guestLastName: 'Fixturemann',
              arrival: '2026-11-01',
              departure: '2026-11-06',
              requestedArrival: '2026-10-31',
              requestedDeparture: '2026-11-07',
            },
          },
        }),
        'paneStayLookup.queueFind': () => ({ runId: '00000000-0000-4000-8000-000000000001' }),
        'paneStayLookup.jobStatus': (input) => {
          if (!(input as { runId?: string }).runId) return null;
          polls += 1;
          const done = polls > 2;
          return {
            runId: '00000000-0000-4000-8000-000000000001',
            request: { kind: 'find', confirmation: '57291630-1', arrival: '2026-11-01' },
            prefetch: false,
            status: done ? 'done' : 'running',
            attempts: 1,
            failureClass: null,
            result: done
              ? { outcome: 'found', stay: { arrival: '2026-11-01', departure: '2026-11-06', lastName: 'Fixturemann' }, screenshots: [], runId: 'cli' }
              : null,
          };
        },
      });
      const out = join(dir, 'ae2-find-test');
      const config = parseAe2Config(['--threads', 't-1', '--out', out, '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe2(config, () => undefined);
      expect(summary.failures).toEqual([]);
      expect(summary).toMatchObject({
        ok: true,
        paneType: 'Amendment',
        amendmentKind: 'amend',
        requestFrom: 'pane',
        queue: 'on',
        findCalls: 1,
        hmsReads: 1,
        jobStatus: 'done',
        jobOutcome: 'found',
        found: true,
        lookupArrival: '2026-11-01',
        lookupDates: 'booked',
        emailBooked: { arrival: '2026-11-01', departure: '2026-11-06' },
        emailRequested: { arrival: '2026-10-31', departure: '2026-11-07' },
        hmsArrival: '2026-11-01',
        hmsDeparture: '2026-11-06',
        shownArrival: '2026-11-01',
        shownDeparture: '2026-11-06',
        blocked: ['workItems.open (write)'],
        screenshots: { amend: true, pane: true },
      });
      expect(statSync(join(out, 'amend.png')).size).toBeGreaterThan(0);
      // The summary carries no guest name and no booking number.
      expect(JSON.stringify(summary)).not.toMatch(/Fixturemann|57291630/);
      expect(calls.filter((call) => call.procedure === 'paneStayLookup.queueFind')).toHaveLength(1);
      expect(calls.some((call) => call.procedure === 'workItems.open')).toBe(false);
    },
    120_000,
  );
});
