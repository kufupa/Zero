import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../src/trpc/router.js';
import { patchSheetXml } from '../src/quote-proposal/patch-sheet.js';
import { patchProposalWorkbook } from '../src/quote-proposal/patch-template.js';
import { __setDbForTests } from '../src/db/client.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { mailboxAccess } from '../src/db/schema/mail.js';

const reachable = await probeTestDb();

const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../fixtures/centurion-quotation-template.xlsx', import.meta.url)),
);

function sessionCaller(email = 'ropperman@legacyhotels.co.za', name = 'R Opperman') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email,
      name,
    },
  } as never);
}

const sampleLines = [
  {
    dateLabel: '15-17 September 2026',
    qty: 2,
    roomCode: 'STQN',
    meal: 'bb' as const,
    nights: 2,
    rate: 2150,
  },
];

describe('quote proposal xlsx patch', () => {
  it('writes client header, DESCRIPTION, rates, and signer without dropping drawings or print area', () => {
    const patched = patchProposalWorkbook(TEMPLATE, {
      attention: 'David Miller',
      company: 'CIDB',
      clientEmail: 'guest@example.com',
      clientTelephone: '',
      signerName: 'R Opperman',
      signerEmail: 'ropperman@legacyhotels.co.za',
      signerTelephone: '0126433600',
      lines: [
        {
          dateLabel: '15-17 September 2026',
          qty: 2,
          description: 'Single room Bed & Breakfast',
          nights: 2,
          rate: 2150,
        },
      ],
    });
    const files = unzipSync(patched);
    expect(files['xl/drawings/drawing1.xml']).toBeTruthy();
    expect(files['xl/calcChain.xml']).toBeUndefined();
    expect(new TextDecoder().decode(files['xl/_rels/workbook.xml.rels']!)).not.toContain('calcChain');
    expect(new TextDecoder().decode(files['[Content_Types].xml']!)).not.toContain('calcChain');
    expect(files['xl/media/image1.png']).toBeTruthy();
    expect(new TextDecoder().decode(files['xl/workbook.xml']!)).toContain('Sheet1!$A$1:$H$69');
    const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('David Miller');
    expect(sheet).toContain('Single room Bed &amp; Breakfast');
    expect(sheet).toContain('R Opperman');
    expect(sheet).toContain('0126433600');
    expect(sheet).toContain('<v>2150</v>');
    expect(sheet).toMatch(/<c r="H24"[^>]*><v>8600<\/v><\/c>/);
    expect(sheet).toContain('t="s"><v>1</v>');
  });

  it('keeps VAT cell as Included shared-string', () => {
    const templateSheet = new TextDecoder().decode(
      unzipSync(TEMPLATE)['xl/worksheets/sheet1.xml']!,
    );
    const patched = patchSheetXml(templateSheet, {
      attention: 'A',
      company: 'B',
      clientEmail: 'c@x.com',
      clientTelephone: '',
      signerName: 'N',
      signerEmail: 'n@x.com',
      signerTelephone: '0126433600',
      lines: [
        {
          dateLabel: '15-17 September 2026',
          qty: 1,
          description: 'Deluxe room Bed & Breakfast',
          nights: 1,
          rate: 2700,
        },
      ],
    });
    expect(patched).toMatch(/<c r="H32"[^>]*t="s"><v>1<\/v><\/c>/);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('workstation.quoteProposalPdf (disposable DB)', () => {
  afterEach(() => {
    __setDbForTests(null);
    vi.unstubAllGlobals();
    delete process.env.GOTENBERG_URL;
  });

  it('refuses PDF for a mailbox not provisioned to the signed-in user', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      process.env.GOTENBERG_URL = 'http://gotenberg.test';
      await expect(
        sessionCaller().workstation.quoteProposalPdf({
          outlookEmail: 'navaai@legacyhotels.co.za',
          agency: 'CIDB',
          dateLabel: '15-17 Sep',
          lines: sampleLines,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' } satisfies Partial<TRPCError>);
    });
  });

  it('does not use another granted mailbox when the signed-in staff selected Centurion', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      await db.insert(mailboxAccess).values({ id: randomUUID(), userId: 'user-ropperman',
        transportId: 'transport-nava', role: 'member' });
      await expect(sessionCaller().workstation.quoteProposalPdf({
        outlookEmail: 'navaai@legacyhotels.co.za',
        agency: 'CIDB', dateLabel: '15-17 Sep', lines: sampleLines,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' } satisfies Partial<TRPCError>);
    });
  });

  it('converts the patched workbook through Gotenberg and stamps the session user', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      process.env.GOTENBERG_URL = 'http://gotenberg.test';
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe('http://gotenberg.test/forms/libreoffice/convert');
        expect(init?.method).toBe('POST');
        return new Response(Buffer.from('%PDF-1.4 test'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await sessionCaller().workstation.quoteProposalPdf({
        outlookEmail: 'centurion@legacyhotels.co.za',
        attention: 'David Miller',
        company: 'CIDB',
        clientEmail: 'guest@example.com',
        agency: 'CIDB',
        dateLabel: '15-17 Sep',
        lines: sampleLines,
      });

      expect(res.fileName).toBe('Quote - CIDB 15-17 Sep.pdf');
      expect(Buffer.from(res.pdfBase64, 'base64').toString()).toContain('%PDF-1.4');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = fetchMock.mock.calls[0]?.[1]?.body;
      expect(body).toBeInstanceOf(FormData);
    });
  });
});

const patchInput = (lines: Array<{ qty: number; nights: number; rate: number }>) => ({
  attention: 'Synthetic', company: 'Test', clientEmail: '', clientTelephone: '',
  signerName: 'Test', signerEmail: '', signerTelephone: '',
  lines: lines.map((line, index) => ({ ...line, dateLabel: `Test ${index}`, description: 'Room Only' })),
});
const templateSheet = () => new TextDecoder().decode(unzipSync(TEMPLATE)['xl/worksheets/sheet1.xml']!);
const cell = (sheet: string, ref: string) => sheet.match(new RegExp(`<c r="${ref}"[^>]*(?:/>|>[\\s\\S]*?</c>)`))?.[0];

describe('wrong-money containment', () => {
  it.each([
    [[{ qty: 1, nights: 2, rate: 1000 }], [2000]],
    [[{ qty: 1, nights: 2, rate: 1000 }, { qty: 1, nights: 3, rate: 1000 }], [2000, 3000]],
    [Array.from({ length: 6 }, () => ({ qty: 3, nights: 2, rate: 0.29 })), Array(6).fill(1.74)],
  ])('writes numeric displayed line money and totals for %j', (lines, totals) => {
    const sheet = patchSheetXml(templateSheet(), patchInput(lines as any));
    (totals as number[]).forEach((total, index) => expect(cell(sheet, `H${24 + index}`)).toContain(`<v>${total}</v>`));
    const sum = Math.round((totals as number[]).reduce((a, b) => a + b, 0) * 100) / 100;
    expect(cell(sheet, 'H31')).toContain(`<v>${sum}</v>`);
    expect(cell(sheet, 'H33')).toContain(`<v>${sum}</v>`);
    for (const ref of ['H24', 'H25', 'H26', 'H27', 'H28', 'H29', 'H31', 'H33']) expect(cell(sheet, ref)).not.toMatch(/<f[ >]/);
  });
  it('clears all unused rows including stale money caches when repatched', () => {
    const six = patchSheetXml(templateSheet(), patchInput(Array.from({ length: 6 }, () => ({ qty: 1, nights: 1, rate: 1000 }))));
    const sheet = patchSheetXml(six, patchInput([{ qty: 1, nights: 2, rate: 1000 }]));
    for (let row = 25; row <= 30; row++) for (const col of ['A', 'B', 'C', 'F', 'G', 'H']) {
      expect(cell(sheet, `${col}${row}`)).not.toMatch(/<v>|<f[ >]/);
    }
  });
  it('refuses broken seventh-row geometry explicitly', () => {
    expect(() => patchSheetXml(templateSheet(), patchInput(Array.from({ length: 7 }, () => ({ qty: 1, nights: 1, rate: 1 }))))).toThrow(/overflow.*6/i);
  });
  it('clears breakfast boilerplate for room-only or unknown board', () => {
    const sheet = patchSheetXml(templateSheet(), patchInput([{ qty: 1, nights: 1, rate: 1 }]));
    expect(cell(sheet, 'A38')).not.toContain('t="s"');
    expect(cell(sheet, 'F39')).not.toContain('t="s"');
  });
  it.each([NaN, Infinity, -1, 1.001])('rejects invalid rate %s', (rate) => {
    expect(() => patchSheetXml(templateSheet(), patchInput([{ qty: 1, nights: 1, rate }]))).toThrow(/rate/i);
  });
});

import { convertXlsxWithGotenberg } from '../src/quote-proposal/gotenberg.js';
describe('converter response containment', () => {
  it.each([
    [500, 'application/pdf', '%PDF-1.4 test'],
    [200, 'text/html', '%PDF-1.4 test'],
    [200, 'application/pdf', ''],
    [200, 'application/pdf', '<html>error</html>'],
  ])('rejects unusable response %s %s', async (status, mime, body) => {
    await expect(convertXlsxWithGotenberg(new Uint8Array(), { url: 'http://synthetic.test', fetchImpl: vi.fn(async () => new Response(body, { status, headers: { 'content-type': mime } })) as typeof fetch })).rejects.toThrow();
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('qualified proposal endpoint authorization (disposable DB)',()=>{
 afterEach(()=>__setDbForTests(null));
 it('cannot resolve a foreign or missing run before conversion',async()=>{
  await withSeededTestDb(async(db)=>{
   __setDbForTests({db,conn:null as never});
   await expect((sessionCaller().workstation as any).qualifiedQuoteProposalPdf({workflowRunId:'foreign',messageId:'foreign-message',revisionRef:'foreign',factRefs:[],outlookEmail:'centurion@legacyhotels.co.za'})).rejects.toMatchObject({code:'NOT_FOUND'});
  });
 });
 it('rejects typed money on the qualified endpoint',async()=>{
  await withSeededTestDb(async(db)=>{
   __setDbForTests({db,conn:null as never});
   await expect((sessionCaller().workstation as any).qualifiedQuoteProposalPdf({workflowRunId:'run',messageId:'message',revisionRef:'quote',outlookEmail:'centurion@legacyhotels.co.za',rate:1000,nights:2})).rejects.toMatchObject({code:'BAD_REQUEST'});
  });
 });
});
import { aiWorkflowRun,aiDraftGeneration,mailThread,message } from '../src/db/schema/mail.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { resolveImportedOffer,resolveApprovedOverride,quoteDigest } from '../src/quote-proposal/quote-revision.js';
import { eq } from 'drizzle-orm';
describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('successful qualified ledger conversion (disposable DB)',()=>{
 afterEach(()=>{__setDbForTests(null);vi.unstubAllGlobals();vi.useRealTimers();delete process.env.GOTENBERG_URL;});
 it('renders selected persisted revision for requesting staff and refuses another requester generation',async()=>{
  await withSeededTestDb(async(db)=>{
   __setDbForTests({db,conn:null as never});vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T09:30:00Z'));const rawRevision=await syntheticRevision(),{id:rawId,...revisionData}=rawRevision;const resolvedData={...revisionData,validity:{...revisionData.validity,cutoff:'explicit',expiresAt:'2026-10-07T10:00:00Z'}};const revision={...resolvedData,id:`quote:${quoteDigest(resolvedData)}`} as any;const threadId=randomUUID(),messageId=randomUUID(),generationId=randomUUID(),runId=randomUUID();
   await db.insert(mailThread).values({id:threadId,transportId:'transport-centurion',threadRootId:threadId});
   await db.insert(message).values({id:messageId,transportId:'transport-centurion',threadId,direction:'inbound',fromAddress:'synthetic@example.invalid',messageIdHeader:'<u5-qualified@example.invalid>'});
   await db.insert(aiDraftGeneration).values({id:generationId,transportId:'transport-centurion',threadId,requestedByUserId:'user-ropperman',model:'synthetic',promptVersion:'synthetic'});
   await db.insert(aiWorkflowRun).values({id:runId,transportId:'transport-centurion',threadId,triggerMessageId:messageId,generationId,runKind:'candidate_draft',idempotencyKey:runId,modelId:'synthetic',promptVersion:'synthetic',state:'succeeded',metrics:{reservationistResult:{version:1,readiness:'ready_for_staff_review',quoteRevisionIds:[revision.id],quoteRevisions:[revision],proposalFacts:[]}}});
   const offerSource={sourceFreshness:{authorizationId:revision.authorizationId,sourceRefs:['sent'],purpose:'offer_source' as const,observedAt:'2026-10-04T09:00:00Z',expiresAt:'2026-10-04T10:00:00Z'},ref:'sent',sourceHash:'a'.repeat(64),authorizationId:revision.authorizationId,scopeDigest:revision.scopeDigest,propertyCode:'HRCEN',currency:'ZAR',printedDate:'2026-10-04',sentAt:'2026-10-04T09:00:00Z',validUntil:'2026-10-07',terms:'Original synthetic terms',lines:[{id:'original',page:1,quote:'Original package',amount:'1234.56'}]};
   const offer=await resolveImportedOffer({ref:'sent',authorizationId:revision.authorizationId,evaluationAt:'2026-10-05T10:00:00Z',resolveSource:async()=>offerSource,authorizeSource:async()=>true});
   const override=await resolveApprovedOverride({revision,ref:'approval',evaluationAt:'2026-10-05T10:00:00Z',resolveApproval:async()=>({ref:'approval',authorizationId:revision.authorizationId,revisionId:revision.id,sourceHash:'a'.repeat(64),actorRef:'staff',reason:'Synthetic approved adjustment',approvedAt:'2026-10-04T09:00:00Z',amount:'2000.00',currency:'ZAR'}),authorizeActor:async()=>true});
   await db.update(aiWorkflowRun).set({metrics:{reservationistResult:{version:1,readiness:'ready_for_staff_review',quoteRevisionIds:[revision.id],quoteRevisions:[revision],proposalFacts:[],importedOffers:[offer],approvedOverrides:[override]}}}).where(eq(aiWorkflowRun.id,runId));
   process.env.GOTENBERG_URL='http://synthetic.test';vi.stubGlobal('fetch',vi.fn(async()=>new Response('%PDF-1.4 synthetic',{headers:{'content-type':'application/pdf'}})));
   const res=await sessionCaller().workstation.qualifiedQuoteProposalPdf({workflowRunId:runId,messageId,revisionRef:revision.id,factRefs:[],outlookEmail:'centurion@legacyhotels.co.za'});
   expect(res.revisionId).toBe(revision.id);expect(res.totalMinor).toBe(220002);expect(res.pdfHash).toMatch(/^[a-f0-9]{64}$/);
   for(const [kind,packet,total] of [['imported_offer',offer,123456],['approved_override',override,200000]] as const){const output=await sessionCaller().workstation.sourceQuoteProposalPdf({kind,workflowRunId:runId,messageId,revisionRef:packet.id,factRefs:[],outlookEmail:'centurion@legacyhotels.co.za'});expect(output.totalMinor).toBe(total);expect(output.revisionId).toBe(packet.id);}
   const choices=await sessionCaller().workstation.qualifiedProposalChoices({internetMessageId:'<u5-qualified@example.invalid>'});expect(choices.choices.map(c=>c.revisionRef)).toEqual([revision.id,offer.id,override.id]);
   vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));const beforeCalls=(fetch as any).mock.calls.length;for(const [kind,packet] of [['imported_offer',offer],['approved_override',override]] as const){await expect(sessionCaller().workstation.sourceQuoteProposalPdf({kind,workflowRunId:runId,messageId,revisionRef:packet.id,factRefs:[],outlookEmail:'centurion@legacyhotels.co.za'})).rejects.toMatchObject({code:'PRECONDITION_FAILED'});}await expect(sessionCaller().workstation.qualifiedQuoteProposalPdf({workflowRunId:runId,messageId,revisionRef:revision.id,factRefs:[],outlookEmail:'centurion@legacyhotels.co.za'})).rejects.toMatchObject({code:'PRECONDITION_FAILED'});expect((fetch as any).mock.calls.length).toBe(beforeCalls);expect((await sessionCaller().workstation.qualifiedProposalChoices({internetMessageId:'<u5-qualified@example.invalid>'})).choices).toEqual([]);
   await db.update(aiDraftGeneration).set({requestedByUserId:'foreign-requester'}).where(eq(aiDraftGeneration.id,generationId));
   await expect(sessionCaller().workstation.qualifiedQuoteProposalPdf({workflowRunId:runId,messageId,revisionRef:revision.id,factRefs:[],outlookEmail:'centurion@legacyhotels.co.za'})).rejects.toMatchObject({code:'NOT_FOUND'});
  });
 });
});
