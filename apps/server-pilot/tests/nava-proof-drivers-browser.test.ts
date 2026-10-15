import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildQuoteWorkbook } from '../src/quote-proposal/quote-workbook';
import { parseAe1Config, readAe1Plan, runAe1 } from '../scripts/nava-ae1-rates-proof';
import { parseAe2Config, runAe2 } from '../scripts/nava-ae2-find-proof';
import { parseAe4Config, runAe4 } from '../scripts/nava-ae4-override-proof';
import { QUOTE_SELECTORS } from '../scripts/nava-quote-proof';

/**
 * Runs the drivers end to end in Chromium against a scripted stand-in for the pane: plain HTML with the pane's labels
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

const readAsBadge = (kind: 'quote' | 'group' | 'new_booking') => {
  const label = kind === 'new_booking' ? 'New booking' : kind === 'group' ? 'Group' : 'Quote';
  const value = kind === 'new_booking' ? 'create_booking' : 'quote';
  return `<section role="status" aria-label="Nava reads this as: ${label}">
    <div><span>Nava reads this as:</span><span data-read-as="${kind}">${label}</span></div>
    <label>Change how Nava reads this email
      <select aria-label="Change how Nava reads this email">
        <option value="quote"${value === 'quote' ? ' selected' : ''}>Quote</option>
        <option value="create_booking"${value === 'create_booking' ? ' selected' : ''}>New booking</option>
      </select>
    </label>
  </section>`;
};

describe('quote proof read-as selector', () => {
  it('stays tied to WorkflowBadge’s read-as attribute', () => {
    const workflowBadge = readFileSync(
      new URL('../../mail/components/quote-workflow/workflow-badge.tsx', import.meta.url),
      'utf8',
    );
    const quoteProof = readFileSync(new URL('../scripts/nava-quote-proof.ts', import.meta.url), 'utf8');
    const selectorAttribute = /^\[data-preview-pane\] \[(data-[a-z-]+)\]$/.exec(QUOTE_SELECTORS.intent)?.[1];
    expect(selectorAttribute).toBe('data-read-as');
    expect(workflowBadge).toContain(`${selectorAttribute}={current}`);
    expect(workflowBadge).toContain("current === 'quote' || current === 'group'");
    expect(quoteProof).toContain("proof.kind !== 'quote' && proof.kind !== 'group'");
  });
});

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

/**
 * The AE1 pane: two stays with two room rows each. `rooms` is the count the read gives every row ('' for none); `single`
 * is the room type the email asks for on the single rows. `notQuote` is a thread read as not a quote: the pane shows no
 * Stay rows until its type is set to Quote, and then shows them.
 */
function ae1Page(
  rooms = '30',
  options: { single?: string; notQuote?: boolean; kind?: 'quote' | 'group' } = {},
): string {
  const row = (stay: number, room: number, asked: string) => `
    <div class="room" data-stay="${stay - 1}">
      <select aria-label="Room type">
        <option value="">Choose a room type</option>
        <option value="${asked}" selected>Email asked for ${asked} — pick a room type</option>
        <option value="STWN">Standard Twin (STWN)</option><option value="STQN">Standard Queen (STQN)</option>
      </select>
      <div role="group" aria-label="Rooms for stay ${stay}, room ${room}"></div>
      <input aria-hidden="true" type="number" aria-label="Rooms" class="sr-only" value="${rooms}">
      <input aria-hidden="true" type="number" aria-label="Adults" class="sr-only" value="">
      <select aria-label="Meal plan"><option value="unknown" selected>Not stated yet</option><option value="bb">B&amp;B</option></select>
    </div>`;
  const single = options.single ?? 'Single';
  const stayDetails = `<section aria-label="Stay">${row(1, 1, single)}${row(1, 2, 'Double/twin')}${row(2, 1, single)}${row(2, 2, 'Double/twin')}</section>`;
  const initialKind = options.notQuote ? 'new_booking' : (options.kind ?? 'quote');
  const body = `
    ${readAsBadge(initialKind)}
    <section aria-label="Quote contact — printed on the PDF">
      <dl>
        <div data-contact-field="name"><dd><span>Guest</span></dd></div>
        <div data-contact-field="email"><dd><span>guest@example.test</span></dd></div>
      </dl>
    </section>
    ${options.notQuote ? '' : stayDetails}
    <section aria-label="Availability & rates">
      <p id="rated">0 of 2 stays rated</p>
      <button id="get">Search availability</button>
      ${STAYS.map(
        ([a, d], i) =>
          `<div class="stay-search" data-stay="${i}">` +
          `<button class="date-range" data-stay="${i}">Search this date range for Stay ${i + 1}</button>` +
          `<details><summary>Details</summary>` +
          `<div><button class="step" data-stay="${i}">Run Search availability ${a} → ${d}</button></div>` +
          `</details></div>`,
      ).join('')}
    </section>
    <section aria-label="Documents">
      <button id="pdf">Prepare quote</button><p id="prepared"></p><button id="xlsx">Download Excel</button>
    </section>`;
  const script = `
    const stays = ${JSON.stringify(STAYS)};
    const runs = [];
    ${
      options.notQuote
        ? `// The Stay rows appear once the thread is Quote, as the pane shows them.
    document.querySelector('select[aria-label="Change how Nava reads this email"]').addEventListener('change', (event) => {
      if (event.target.value === 'quote') {
        const readAs = document.querySelector('[data-read-as]');
        readAs.setAttribute('data-read-as', 'quote');
        readAs.textContent = 'Quote';
        readAs.closest('[role="status"]').setAttribute('aria-label', 'Nava reads this as: Quote');
        document.querySelector('[data-preview-pane] main').insertAdjacentHTML('afterbegin', ${JSON.stringify(stayDetails)});
      }
    });`
        : ''
    }
    // The pane logs every field edit (workItems.recordEvent); the drivers must not cause one without leave.
    document.querySelectorAll('section[aria-label="Stay"] input, section[aria-label="Stay"] select').forEach((el) =>
      el.addEventListener('input', () => trpc('workItems.recordEvent', { field: el.getAttribute('aria-label') })),
    );
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
    qty: 30,
    nights: 1,
    rateMinor,
    totalMinor: 30 * rateMinor,
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
      const base = await serve(ae1Page('30', { kind: 'group' }), ae1Handlers());
      const out = join(dir, 'ae1-rates-test');
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', out, '--timeout-ms', '20000'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1' }),
        dir,
      );
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
        editsAllowed: true,
        activeMailboxSwitched: false,
        workflowRunIds: ['run-1', 'run-2'],
        blocked: ['panePartyLookup.findParty (second_party_lookup)'],
        screenshots: { rates: true, documents: true, pane: true },
      });
      // The counts are the read's 30s: no room count is typed, and no default is in play.
      expect(summary.roomSplitUsed.rule).toBe("the read's counts only (NAVA_AE1_ROOMS unset)");
      expect(summary.roomSplitUsed.rows.map((row) => `${row.askedType}->${row.roomType}x${row.rooms}/${row.adults}/${row.board}`)).toEqual([
        'Single->STQNx30/1/bb',
        'Double/twin->STWNx30/2/bb',
        'Single->STQNx30/1/bb',
        'Double/twin->STWNx30/2/bb',
      ]);
      expect(summary.filledFields.filter((field) => field.endsWith('.rooms'))).toEqual([]);
      // What the rates runs carried is what the driver typed.
      const ratesInputs = calls.filter((call) => call.procedure === 'workstation.executeStaffQuote');
      expect(ratesInputs).toHaveLength(2);
      expect((ratesInputs[0]!.input as { groups: unknown[] }).groups).toEqual([
        expect.objectContaining({ roomPreference: 'STQN', quantity: 30, adults: 1, board: 'bb' }),
        expect.objectContaining({ roomPreference: 'STWN', quantity: 30, adults: 2, board: 'bb' }),
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
      // The read has no counts, so NAVA_AE1_ROOMS gives them. The Rooms inputs ignore typing, as a pane that refused the value would.
      const html = ae1Page('').replace(
        'const stays =',
        `document.querySelectorAll('input[aria-label="Rooms"]').forEach((el) => el.addEventListener('input', () => { el.value = ''; }));
    const stays =`,
      );
      const base = await serve(html, ae1Handlers());
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', join(dir, 'ae1-block'), '--timeout-ms', '20000'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1', NAVA_AE1_ROOMS: '15/15' }),
        dir,
      );
      const summary = await runAe1(config, () => undefined);
      expect(summary.ok).toBe(false);
      expect(summary.blocker).toBe('the pane did not take the room type, room count, adults or meal plan typed into a row');
      expect(summary.ratesRuns).toBe(0);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'without NAVA_PROOF_ALLOW_EDITS stops with needs_edits for the fills and types nothing into the thread',
    async () => {
      const base = await serve(ae1Page(), ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-no-edits'), '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe1(config, () => undefined);
      expect(summary.ok).toBe(false);
      expect(summary.editsAllowed).toBe(false);
      expect(summary.blocker).toBe('needs_edits:roomType,adults,board');
      expect(summary.filledFields).toEqual([]);
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'with no room count in the read and no NAVA_AE1_ROOMS, stops with needs_edits:rooms and never invents one',
    async () => {
      const base = await serve(ae1Page(''), ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-no-rooms'), '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe1(config, () => undefined);
      expect(summary.ok).toBe(false);
      expect(summary.blocker).toBe('needs_edits:rooms');
      expect(summary.roomSplitUsed.rows.map((row) => [row.rooms, row.roomsSource])).toEqual([
        [null, 'missing'],
        [null, 'missing'],
        [null, 'missing'],
        [null, 'missing'],
      ]);
      expect(summary.filledFields).toEqual([]);
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'with no room count and a room type it cannot name, stops on needs_edits:rooms and types nothing',
    async () => {
      const base = await serve(ae1Page('', { single: 'Family' }), ae1Handlers());
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', join(dir, 'ae1-no-rooms-type'), '--timeout-ms', '20000'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1' }),
        dir,
      );
      const summary = await runAe1(config, () => undefined);
      expect(summary.ok).toBe(false);
      expect(summary.blocker).toBe('needs_edits:rooms');
      expect(summary.filledFields).toEqual([]);
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'a thread that is not Quote is switched first, and a rooms stop after the switch fills nothing else',
    async () => {
      const base = await serve(ae1Page('', { notQuote: true }), ae1Handlers());
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', join(dir, 'ae1-not-quote-no-rooms'), '--timeout-ms', '20000'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1' }),
        dir,
      );
      const summary = await runAe1(config, () => undefined);
      expect(summary.blocker).toBe('needs_edits:rooms');
      // The rows show only once the thread is Quote, so the switch is the one edit a rooms stop can leave behind.
      expect(summary.filledFields).toEqual(['type']);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'a thread that is not Quote without NAVA_PROOF_ALLOW_EDITS stops on needs_edits:type and changes nothing',
    async () => {
      const base = await serve(ae1Page('30', { notQuote: true }), ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-not-quote'), '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe1(config, () => undefined);
      expect(summary.blocker).toBe('needs_edits:type');
      expect(summary.filledFields).toEqual([]);
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
    },
    120_000,
  );
});

describe('AE1 dry plan against a scripted pane', () => {
  it.skipIf(!chromiumBinary)(
    'with edits allowed, a thread that is not Quote is not planned: its rows cannot be read without the switch',
    async () => {
      const base = await serve(ae1Page('30', { notQuote: true }), ae1Handlers());
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', join(dir, 'ae1-plan-not-quote'), '--dry-plan'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1' }),
        dir,
      );
      const plan = await readAe1Plan(config, () => undefined);
      expect(plan.blocker).toBe(
        'not planned: switch the thread to Quote first; its room rows cannot be planned without that edit',
      );
      expect(plan.roomSplit).toBeNull();
      expect(plan.paneRows).toBe(0);
      expect(plan.wouldFill).toEqual(['type']);
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
      expect(calls.some((call) => call.procedure === 'workstation.executeStaffQuote')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'without edits, a thread that is not Quote is blocked on needs_edits:type',
    async () => {
      const base = await serve(ae1Page('30', { notQuote: true }), ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-plan-not-quote-no-edits'), '--dry-plan'], env(base), dir);
      const plan = await readAe1Plan(config, () => undefined);
      expect(plan.blocker).toBe('needs_edits:type');
      expect(plan.wouldFill).toEqual(['type']);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'names needs_edits:rooms, not the room type, when a row has no count and a type it cannot name',
    async () => {
      const base = await serve(ae1Page('', { single: 'Family' }), ae1Handlers());
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', join(dir, 'ae1-plan-rooms-type'), '--dry-plan'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1' }),
        dir,
      );
      const plan = await readAe1Plan(config, () => undefined);
      expect(plan.blocker).toBe('needs_edits:rooms');
      expect(plan.paneRows).toBe(4);
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'prints the read counts with their source, and makes no edit and no HMS request',
    async () => {
      const base = await serve(ae1Page(), ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-plan'), '--dry-plan'], env(base), dir);
      const plan = await readAe1Plan(config, () => undefined);
      expect(plan.blocker).toBe('needs_edits:roomType,adults,board');
      expect(plan.editsAllowed).toBe(false);
      expect(plan.paneRows).toBe(4);
      expect(plan.roomSplit?.rule).toBe("the read's counts only (NAVA_AE1_ROOMS unset)");
      expect(plan.roomSplit?.rows.map((row) => [row.stay, row.room, row.rooms, row.roomsSource])).toEqual([
        [1, 1, 30, 'read'],
        [1, 2, 30, 'read'],
        [2, 1, 30, 'read'],
        [2, 2, 30, 'read'],
      ]);
      expect(plan.wouldFill).toHaveLength(12);
      expect(plan.wouldFill.filter((field) => field.endsWith('.rooms'))).toEqual([]);
      // The pane's own party search is refused, and it is the only request the plan saw refused.
      expect(plan.blocked).toEqual(['panePartyLookup.findParty (hms)']);
      for (const name of [
        'panePartyLookup.findParty',
        'workstation.executeStaffQuote',
        'workItems.recordEvent',
        'workstation.qualifiedQuoteProposalPdf',
        'workstation.quoteWorkbook',
      ]) {
        expect(calls.some((call) => call.procedure === name), name).toBe(false);
      }
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'shows NAVA_AE1_ROOMS as the source of the counts the read lacks',
    async () => {
      const base = await serve(ae1Page(''), ae1Handlers());
      const config = parseAe1Config(
        ['--threads', 't-1', '--out', join(dir, 'ae1-plan-env'), '--dry-plan'],
        env(base, { NAVA_AE1_ROOMS: '15/15' }),
        dir,
      );
      const plan = await readAe1Plan(config, () => undefined);
      expect(plan.roomSplit?.rows.map((row) => [row.rooms, row.roomsSource])).toEqual([
        [15, 'NAVA_AE1_ROOMS'],
        [15, 'NAVA_AE1_ROOMS'],
        [15, 'NAVA_AE1_ROOMS'],
        [15, 'NAVA_AE1_ROOMS'],
      ]);
      expect(plan.blocker).toBe('needs_edits:rooms,roomType,adults,board');
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'names needs_edits:rooms as the blocker when no count is given anywhere',
    async () => {
      const base = await serve(ae1Page(''), ae1Handlers());
      const config = parseAe1Config(['--threads', 't-1', '--out', join(dir, 'ae1-plan-missing'), '--dry-plan'], env(base), dir);
      const plan = await readAe1Plan(config, () => undefined);
      expect(plan.blocker).toBe('needs_edits:rooms');
      expect(plan.roomSplit?.rows.every((row) => row.rooms === null && row.roomsSource === 'missing')).toBe(true);
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

// ---------------------------------------------------------------------------------------------------------------------
// The active mailbox

/** The AE2 stand-in's server, plus a stateful default mailbox: transport-nava is the default, as on the pilot account. */
function ae2Handlers(mailbox: { current: string }): Record<string, Handler> {
  let polls = 0;
  return {
    'connections.getDefault': () => ({ id: mailbox.current, email: `${mailbox.current}@example.test` }),
    'connections.list': () => ({
      connections: [{ id: 'transport-nava' }, { id: 'transport-centurion' }],
      disconnectedIds: [],
    }),
    'connections.setDefault': (input) => {
      mailbox.current = (input as { connectionId: string }).connectionId;
      return { id: mailbox.current };
    },
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
      const done = polls > 1;
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
  };
}

describe('the active mailbox', () => {
  it.skipIf(!chromiumBinary)(
    "makes the run's transport the default before the pane opens and puts the old default back after",
    async () => {
      const mailbox = { current: 'transport-nava' };
      const base = await serve(ae2Page(), ae2Handlers(mailbox));
      const config = parseAe2Config(
        ['--threads', 't-1', '--out', join(dir, 'ae2-mailbox'), '--timeout-ms', '20000'],
        env(base, { NAVA_PREVIEW_TRANSPORT_ID: 'transport-centurion' }),
        dir,
      );
      const summary = await runAe2(config, () => undefined);
      expect(summary.failures).toEqual([]);
      expect(summary).toMatchObject({ ok: true, activeMailboxSwitched: true, restored: true });
      expect(mailbox.current).toBe('transport-nava');
      const sets = calls.filter((call) => call.procedure === 'connections.setDefault').map((call) => call.input);
      expect(sets).toEqual([{ connectionId: 'transport-centurion' }, { connectionId: 'transport-nava' }]);
      // The switch lands before the pane reads the mail, the restore after the find.
      const order = calls.map((call) => call.procedure);
      const firstSet = order.indexOf('connections.setDefault');
      const lastSet = order.lastIndexOf('connections.setDefault');
      expect(firstSet).toBeLessThan(order.indexOf('workItems.getByMessage'));
      expect(lastSet).toBeGreaterThan(order.indexOf('paneStayLookup.queueFind'));
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    "blocks a setDefault the pane sends; only the driver's two calls reach the server",
    async () => {
      const mailbox = { current: 'transport-nava' };
      const html = ae2Page().replace(
        "trpc('workItems.getByMessage'",
        "trpc('connections.setDefault', { connectionId: 'transport-centurion' });\n    trpc('workItems.getByMessage'",
      );
      const base = await serve(html, ae2Handlers(mailbox));
      const config = parseAe2Config(
        ['--threads', 't-1', '--out', join(dir, 'ae2-pane-set'), '--timeout-ms', '20000'],
        env(base, { NAVA_PREVIEW_TRANSPORT_ID: 'transport-centurion' }),
        dir,
      );
      const summary = await runAe2(config, () => undefined);
      expect(summary.blocked).toContain('connections.setDefault (unknown)');
      expect(summary.ok).toBe(false);
      expect(summary).toMatchObject({ activeMailboxSwitched: true, restored: true });
      expect(calls.filter((call) => call.procedure === 'connections.setDefault')).toHaveLength(2);
      expect(mailbox.current).toBe('transport-nava');
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    'switches nothing when the transport is already the default',
    async () => {
      const mailbox = { current: 'transport-centurion' };
      const base = await serve(ae2Page(), ae2Handlers(mailbox));
      const config = parseAe2Config(
        ['--threads', 't-1', '--out', join(dir, 'ae2-same'), '--timeout-ms', '20000'],
        env(base, { NAVA_PREVIEW_TRANSPORT_ID: 'transport-centurion' }),
        dir,
      );
      const summary = await runAe2(config, () => undefined);
      expect(summary).toMatchObject({ ok: true, activeMailboxSwitched: false, restored: false });
      expect(calls.some((call) => call.procedure === 'connections.setDefault')).toBe(false);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// AE4: a real thread's stay is never overwritten

/** A stored quote as in the live incident: 2026-11-02 to 06, one room. `rooms` '' leaves the room count missing. */
function ae4Page(rooms: string): string {
  const body = `
    ${readAsBadge('quote')}
    <section aria-label="Stay">
      <div hidden>
        <input type="date" aria-label="Arrival" value="2026-11-02">
        <input type="date" aria-label="Departure" value="2026-11-06">
      </div>
      <button>Change dates ▾</button>
      <select aria-label="Room type">
        <option value="">Choose a room type</option>
        <option value="STQN">Standard Queen (STQN)</option>
        <option value="STWN" selected>Standard Twin (STWN)</option>
      </select>
      <input type="number" aria-label="Rooms" value="${rooms}">
      <input type="number" aria-label="Adults" value="2">
      <select aria-label="Meal plan"><option value="unknown">Not stated yet</option><option value="bb" selected>B&amp;B</option></select>
    </section>
    <section aria-label="Room 1 price"><button disabled>Discount / override</button></section>`;
  const script = `
    trpc('workItems.getByMessage', { messageId: 'm1' });
    document.querySelectorAll('section[aria-label="Stay"] input, section[aria-label="Stay"] select').forEach((el) =>
      el.addEventListener('input', () => trpc('workItems.recordEvent', { field: el.getAttribute('aria-label'), value: el.value })),
    );`;
  return shell(body, script);
}

const ae4Handlers = (): Record<string, Handler> => ({
  'workItems.getByMessage': () => ({ status: 'ready', workItemId: 'wi-1', analysis: { luna: { workflow: 'quote' } } }),
});

describe('AE4 driver on a stored quote', () => {
  it.skipIf(!chromiumBinary)(
    'without NAVA_PROOF_ALLOW_EDITS stops with needs_edits for the one missing field and edits nothing',
    async () => {
      const base = await serve(ae4Page(''), ae4Handlers());
      const config = parseAe4Config(['--threads', 't-1', '--out', join(dir, 'ae4-no-edits'), '--timeout-ms', '20000'], env(base), dir);
      const summary = await runAe4(config, () => undefined);
      expect(summary.blocker).toBe('needs_edits:rooms');
      expect(summary).toMatchObject({ ok: false, editsAllowed: false, filledFields: [], hmsReads: 0 });
      expect(calls.some((call) => call.procedure === 'workItems.recordEvent')).toBe(false);
    },
    120_000,
  );

  it.skipIf(!chromiumBinary)(
    "with NAVA_PROOF_ALLOW_EDITS fills only the missing room count and keeps the stored stay's dates and room",
    async () => {
      const base = await serve(ae4Page(''), ae4Handlers());
      const lines: string[] = [];
      const config = parseAe4Config(
        ['--threads', 't-1', '--out', join(dir, 'ae4-fill'), '--timeout-ms', '20000'],
        env(base, { NAVA_PROOF_ALLOW_EDITS: '1' }),
        dir,
      );
      const summary = await runAe4(config, (line) => lines.push(line));
      expect(summary.filledFields).toEqual(['rooms']);
      expect(lines).toContain('stay filled: rooms');
      // The only edit is the room count; the dates, room type, adults and meal plan were never touched.
      const edits = calls.filter((call) => call.procedure === 'workItems.recordEvent').map((call) => call.input);
      expect(edits).toEqual([{ field: 'Rooms', value: '1' }]);
      // The scripted pane has no working override, so the run stops there, after the stay step.
      expect(summary.blocker).toMatch(/^Discount \/ override is disabled/);
    },
    120_000,
  );
});
