import {
  DRAFT_APPROVAL_POLICY_VERSION,
  DRAFT_APPROVAL_VERSION,
  DraftApprovalError,
  buildDraftApproval,
  assertDraftApprovalMatchesPayload,
  parseDraftApproval,
  resolveDraftApprovalRouteBinding,
  type DraftApprovalPayload,
} from '../src/ai/draft-approval.js';
import { describe, expect, it } from 'vitest';
import { quoteDigest } from '../src/quote-proposal/quote-revision.js';

const SIGNING_SECRET = 'u6-test-signing-secret';
const azureBinding={routeId:'explicit-azure-draft',modelId:'gpt-6-luna',purpose:'draft' as const,protocol:'azure-foundry-responses' as const,access:'current_app' as const,egress:'azure-foundry' as const,retention:'bounded' as const,usage:'reported' as const,release:{releaseId:'disposable',releaseVersion:'1',sourceRevision:'source',fingerprint:'fingerprint',purpose:'draft' as const,capabilityFamilyVersions:{reservationist:'reservationist-runtime-v1'},issuedAt:'2026-10-05T12:00:00.000Z',expiresAt:'2026-10-05T20:00:00.000Z',withdrawn:false}};

const base: DraftApprovalPayload = {
  draftId: 'draft-1',
  generationId: 'generation-1',
  transportId: 'transport-1',
  threadId: 'thread-1',
  revisionId: 'revision-1',
  threadStateVersion: 'thread-state-1',
  evidence: [{ kind: 'hms', id: 'evidence-1', sourceHash: 'source-1' }],
  policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
  approvedByUserId: 'user-1',
  approvedAt: '2026-09-09T10:00:00.000Z',
  origin: 'ai',
  subject: 'Reservation follow-up',
  html: '<p>We can help.</p>',
  text: 'We can help.',
  to: ['guest@example.test'],
  cc: [],
  bcc: [],
  attachments: [],
};

it('roundtrips truthful Azure draft evidence while retaining exact signed release binding',()=>{const binding=azureBinding as any,payload={...base,routeBinding:binding},approval=buildDraftApproval(payload,SIGNING_SECRET);expect(resolveDraftApprovalRouteBinding({routeBinding:binding})).toEqual(binding);expect(parseDraftApproval(approval,SIGNING_SECRET).routeBinding).toEqual(binding);expect(()=>assertDraftApprovalMatchesPayload(approval,{...payload,routeBinding:{...binding,release:{...binding.release,fingerprint:'changed'}}},SIGNING_SECRET)).toThrow();});
it.each([['azure-foundry-responses','none'],['in_process','azure-foundry'],['unknown','azure-foundry']])('rejects incompatible route evidence %s/%s', (protocol,egress)=>{expect(resolveDraftApprovalRouteBinding({routeBinding:{...azureBinding,protocol,egress}})).toBeUndefined();});

describe('draft approval token', () => {
  it('is closed, deterministic, and binds every send input plus evidence', () => {
    const approval = buildDraftApproval(base, SIGNING_SECRET);

    expect(approval.version).toBe(DRAFT_APPROVAL_VERSION);
    expect(approval.purpose).toBe('draft-only');
    expect(approval.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.recipientDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.attachmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(approval).sort()).toEqual([
      'approvedAt',
      'approvedByUserId',
      'attachmentDigest',
      'bodyDigest',
      'draftId',
      'evidenceDigest',
      'fingerprint',
      'generationId',
      'policyVersion',
      'purpose',
      'recipientDigest',
      'revisionId',
      'signature',
      'threadId',
      'threadStateVersion',
      'transportId',
      'version',
    ]);
    expect(buildDraftApproval(base, SIGNING_SECRET)).toEqual(approval);
    expect(approval.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires a fresh approval when body, recipient, attachment, policy, or revision changes', () => {
    const approval = buildDraftApproval(base, SIGNING_SECRET);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          html: '<p>Changed after review.</p>',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          to: ['other@example.test'],
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          attachments: [
            {
              filename: 'quote.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 3,
              contentBase64: 'YWJj',
            },
          ],
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          policyVersion: 'different-policy',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          revisionId: 'revision-2',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
  });

  it('does not create a token for manual drafts', () => {
    expect(() =>
      buildDraftApproval(
        {
          ...base,
          origin: 'manual',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
  });

  it('rejects malformed, unknown, or non-draft-purpose tokens', () => {
    const approval = buildDraftApproval(base, SIGNING_SECRET);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        { ...approval, purpose: 'send-anything' } as unknown as typeof approval,
        base,
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        { ...approval, fingerprint: 'not-a-fingerprint' } as typeof approval,
        base,
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() => assertDraftApprovalMatchesPayload(approval, base, 'wrong-secret')).toThrow(
      DraftApprovalError,
    );
  });

  it('binds approval to the trusted draft route capability release', () => {
    const routeBinding = {
      routeId: 'u6-approved-draft-release-1',
      modelId: 'u6-approved-draft-model-1',
      purpose: 'draft' as const,
      protocol: 'in_process' as const,
      access: 'current_app' as const,
      egress: 'none' as const,
      retention: 'bounded' as const,
      usage: 'reported' as const,
    };
    const approval = buildDraftApproval(
      { ...base, routeBinding } as unknown as DraftApprovalPayload,
      SIGNING_SECRET,
    );
    expect((approval as unknown as { routeBinding?: unknown }).routeBinding).toEqual(routeBinding);

    const changedRoute = { ...routeBinding, routeId: 'u6-approved-draft-release-2' };
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        { ...base, routeBinding: changedRoute } as unknown as DraftApprovalPayload,
        SIGNING_SECRET,
      ),
    ).toThrow(/route|capability|approval/i);
  });
});
it('binds optional versioned reservationist result/action digest without changing legacy tokens', () => {
  const payload = { ...base, resultDigest: 'a'.repeat(64) };
  const token = buildDraftApproval(payload, SIGNING_SECRET);
  expect((token as any).resultDigest).toBe(payload.resultDigest);
  expect(() =>
    assertDraftApprovalMatchesPayload(
      token,
      { ...payload, resultDigest: 'b'.repeat(64) },
      SIGNING_SECRET,
    ),
  ).toThrow();
});
it('pending reservationist results never authorize confirmed or cleared editor wording', async () => {
  const { assertReservationistResultWording } = await import('../src/ai/draft-approval.js');
  const result = {
    version: 1,
    readiness: 'pending_pms_action',
    tasks: [{ status: 'pending_pms_action' }],
  };
  for (const text of [
    'Your reservation is confirmed.',
    'Your booking has been made.',
    'Payment has cleared.',
    'The reservation was secured.',
    'Your rooms are confirmed.',
    'Funds have cleared.',
    'We have confirmed your reservation.',
    'You have a guaranteed booking.',
    'Your account is paid in full.',
    'Your booking is not confirmed but funds have cleared.',
    'No payment cleared and your rooms are confirmed.',
  ])
    expect(() =>
      assertReservationistResultWording(result, { subject: '', html: '<p>' + text + '</p>', text }),
    ).toThrow();
  expect(() =>
    assertReservationistResultWording(result, {
      subject: '',
      html: '',
      text: 'Your booking request is prepared, subject to staff completion and availability.',
    }),
  ).not.toThrow();
});

it('allows explicit negated pending completion wording', async () => {
  const { assertReservationistResultWording } = await import('../src/ai/draft-approval.js');
  for (const text of ['Your booking is not confirmed.', 'No payment cleared.', 'Funds have not cleared.', 'We have not confirmed your reservation.'])
    expect(() => assertReservationistResultWording({ version: 1 }, { subject: '', html: '', text })).not.toThrow();
});
it('rejects encoded and conjunction-separated unproven completion', async () => {
  const { assertReservationistResultWording } = await import('../src/ai/draft-approval.js');
  for (const html of ['<p>Your rooms are conf&#105;rmed.</p>', '<p>Your booking has been processed and confirmed.</p>'])
    expect(() => assertReservationistResultWording({ version: 1 }, { subject: '', html, text: '' })).toThrow();
});
it('requires explicit qualified offer validity and fresh source authority at action time', async () => {
  const { assertReservationistResultFreshForAction } = await import('../src/ai/draft-approval.js');
  const now = new Date('2026-10-04T12:00:00Z');
  const sourceFreshness = { authorizationId: 'server-grant', sourceRefs: ['source:1'], purpose: 'offer_source' as const, observedAt: '2026-10-04T11:00:00Z', expiresAt: '2026-10-04T13:00:00Z' };
  const native = { authorizationId: 'server-grant', groups: [{ sourceRef: 'source:1' }], validity: { days: 3, anchor: 'authored_date', cutoff: 'unresolved' }, sourceFreshness };
  expect(() => assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [native] }, now)).toThrow(/cutoff/i);
  const imported = { authorizationId: 'server-grant', ref: 'source:1', validUntil: '2026-10-05', sourceFreshness };
  expect(() => assertReservationistResultFreshForAction({ version: 1, importedOffers: [imported] }, now)).not.toThrow();
  for (const offer of [{ ...imported, validUntil: '2026-10-03' }, { ...imported, validUntil: '2026-10-04' }, { ...imported, sourceFreshness: undefined }, { ...imported, sourceFreshness: { ...sourceFreshness, sourceRefs: ['source:wrong'] } }, { ...imported, sourceFreshness: { ...sourceFreshness, expiresAt: '2026-10-04T12:00:00Z' } }])
    expect(() => assertReservationistResultFreshForAction({ version: 1, importedOffers: [offer] }, now)).toThrow();
  expect(() => assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [{ authorizationId: 'server-grant', groups: [{ sourceRef: 'source:1' }], validity: { cutoff: 'resolved', expiresAt: '2026-10-04T13:00:00Z' }, sourceFreshness }] }, now)).not.toThrow();
  expect(() => assertReservationistResultFreshForAction({ version: 1, tasks: [{ status: 'pending_pms_action' }] }, now)).not.toThrow();
});

it('binds freshness to original authorization and delegates override validity', async () => {
  const { assertReservationistResultFreshForAction } = await import('../src/ai/draft-approval.js');
  const now = new Date('2026-10-04T12:00:00Z');
  const sourceFreshness = { authorizationId: 'original-grant', sourceRefs: ['source:1'], purpose: 'offer_source' as const, observedAt: '2026-10-04T11:00:00Z', expiresAt: '2026-10-04T13:00:00Z' };
  const revision = { authorizationId: 'original-grant', groups: [{ sourceRef: 'source:1' }], validity: { cutoff: 'resolved', expiresAt: '2026-10-04T13:00:00Z' }, sourceFreshness };
  expect(() => assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [{ ...revision, sourceFreshness: { ...sourceFreshness, authorizationId: 'wrong-grant' } }] }, now)).toThrow();
  const override = { authorizationId: 'original-grant', sourceRevision: revision };
  expect(() => assertReservationistResultFreshForAction({ version: 1, approvedOverrides: [override] }, now)).not.toThrow();
  expect(() => assertReservationistResultFreshForAction({ version: 1, approvedOverrides: [{ ...override, sourceRevision: { ...revision, validity: { cutoff: 'unresolved' } } }] }, now)).toThrow(/cutoff/i);
  expect(() => assertReservationistResultFreshForAction({ version: 1, approvedOverrides: [{ ...override, authorizationId: 'wrong-grant' }] }, now)).toThrow();
});
it('revalidates pending packet source age/grant/hash while retaining immutable old request evidence',async()=>{
 const {assertReservationistResultFreshForAction}=await import('../src/ai/draft-approval.js');
 const now=new Date('2026-10-04T12:00:00Z');
 const current={kind:'current',sourceRef:'detail',sourceHash:'a'.repeat(64),authorizationId:'grant',propertyCode:'HRCEN',observedAt:'2026-10-04T11:30:00Z',expiresAt:'2026-10-04T13:00:00Z',maxSourceAgeMs:3600000};
 const causal={kind:'causal',sourceRef:'original-request',sourceHash:'b'.repeat(64),authorizationId:'grant',propertyCode:'HRCEN',observedAt:'2026-09-01T10:00:00Z'};
 const packetData={kind:'change',taskId:'change',reservationRef:'reservation:one',status:'pending_pms_action',saved:false,businessRulesValidated:true,authorizationId:'grant',propertyCode:'HRCEN',sourceRefs:['detail','original-request'],sourceProofs:[current,causal],requestBinding:{requestId:'request',ownerRef:'owner',threadId:'thread',taskId:'change',sourceRef:causal.sourceRef,sourceHash:causal.sourceHash,observedAt:causal.observedAt,changes:{arrivalDate:'2026-10-15',departureDate:'2026-10-17'}},requested:{arrivalDate:'2026-10-15',departureDate:'2026-10-17'}};
 const packet={...packetData,digest:quoteDigest(packetData)};
 expect(()=>assertReservationistResultFreshForAction({version:1,packets:[packet]},now)).not.toThrow();
 for(const proof of [{...current,expiresAt:'2026-10-04T12:00:00Z'},{...current,observedAt:'2026-09-01T10:00:00Z'},{...current,authorizationId:'other'},{...current,sourceHash:'bad'},{...current,sourceRef:'foreign'}]){const data={...packetData,sourceProofs:[proof,causal]};expect(()=>assertReservationistResultFreshForAction({version:1,packets:[{...data,digest:quoteDigest(data)}]},now)).toThrow(/source/);}
 expect(()=>assertReservationistResultFreshForAction({version:1,packets:[{...packet,sourceProofs:undefined}]},now)).toThrow(/source/);
 expect(()=>assertReservationistResultFreshForAction({version:1,packets:[{...packet,status:'blocked',businessRulesValidated:false,sourceProofs:undefined}]},now)).not.toThrow();
});
it('rechecks complete read receipts and retains failed read receipts as clarification evidence',async()=>{
 const {assertReservationistResultFreshForAction}=await import('../src/ai/draft-approval.js');
 const {prepareReservationistReadTask}=await import('../src/ai/reservationist-read-task.js');
 const {syntheticReservationistRead}=await import('./helpers/synthetic-reservationist-read.js');
 const f=await syntheticReservationistRead();
 f.input.taskSource.quote='Please check the reservation status and arrival date.';f.input.taskSource.end=f.input.taskSource.quote.length;
 const result=await prepareReservationistReadTask(f.input,{context:f.context,request:f.request,signal:f.context.signal,authorizeRead:f.authorizeRead,authorizeEvidence:f.authorizeEvidence});
 expect(result.recoveryCodes).toEqual([]);
 const receipt=result.readReceipt!;
 const value={version:1,tasks:[{id:f.input.taskId,status:'complete',evidenceRefs:result.evidenceRefs}],readReceipts:[receipt]};
 expect(()=>assertReservationistResultFreshForAction(value,new Date('2026-10-04T10:01:00Z'))).not.toThrow();
 expect(()=>assertReservationistResultFreshForAction(value,new Date('2026-10-04T10:06:00Z'))).toThrow(/source/);
 for(const mutate of [(r:typeof receipt)=>{r.grant.authorizationId='foreign';},(r:typeof receipt)=>{r.sourceProofs[0].sourceHash='bad';},(r:typeof receipt)=>{r.sourceProofs[0].requestDigest='b'.repeat(64);},(r:typeof receipt)=>{r.grant.allowedFields=[];},(r:typeof receipt)=>{r.sourceProofs=[];}]){const changed=structuredClone(value);mutate(changed.readReceipts[0]);expect(()=>assertReservationistResultFreshForAction(changed,new Date('2026-10-04T10:01:00Z'))).toThrow(/source/);}
 expect(()=>assertReservationistResultFreshForAction({...value,tasks:[{id:f.input.taskId,status:'needs_clarification'}],readReceipts:[{...receipt,sourceProofs:[]}]},new Date('2026-10-04T12:00:00Z'))).not.toThrow();
});


it('allows only the exact existing reservation status derived from a fresh authorized read receipt',async()=>{
 const {prepareReservationistReadTask}=await import('../src/ai/reservationist-read-task.js'),{syntheticReservationistRead}=await import('./helpers/synthetic-reservationist-read.js');
 const {assertReservationistResultWording}=await import('../src/ai/draft-approval.js');
 const f=await syntheticReservationistRead({status:'Confirmed'});f.input.taskSource.quote='Please check the reservation status and arrival date.';f.input.taskSource.end=f.input.taskSource.quote.length;
 const r=await prepareReservationistReadTask(f.input,f.deps),text='The existing reservation record shows status: Confirmed.';
 const result={version:1,tasks:[{id:f.input.taskId,kind:'question',status:'complete',evidenceRefs:r.evidenceRefs,guestText:r.guestText}],preparedFacts:r.preparedFacts,readReceipts:[r.readReceipt]};
 const now=new Date('2026-10-04T10:01:00Z');
 expect(()=>assertReservationistResultWording(result,{subject:'',text,html:`<p>${text}</p>`},now)).not.toThrow();
 for(const unsafe of ['Your reservation is confirmed.','The existing reservation record shows status: Booked.',text+' Your booking is confirmed.'])expect(()=>assertReservationistResultWording(result,{subject:'',text:unsafe,html:''},now)).toThrow();
 expect(()=>assertReservationistResultWording(result,{subject:'',text,html:''},new Date('2026-10-04T10:06:00Z'))).toThrow();
 expect(()=>assertReservationistResultWording({...result,readReceipts:[]},{subject:'',text,html:''},now)).toThrow();
 expect(()=>assertReservationistResultWording({...result,tasks:[{...result.tasks[0],status:'needs_clarification'}]},{subject:'',text,html:''},now)).not.toThrow();
 const arrivalOnly=structuredClone(result);arrivalOnly.readReceipts[0]!.grant.allowedFields=['arrival'];expect(()=>assertReservationistResultWording(arrivalOnly,{subject:'',text,html:''},now)).toThrow();
 const wrongTask={...result,tasks:[{...result.tasks[0],kind:'new_booking'}]};expect(()=>assertReservationistResultWording(wrongTask,{subject:'',text,html:''},now)).toThrow();
 expect(()=>assertReservationistResultWording({...result,preparedFacts:[]},{subject:'',text,html:''},now)).toThrow();
});


it('requires exact fresh retained document proof before promoting an existing attachment task', async () => {
  const { syntheticReservationistDocumentFixture } = await import('./helpers/synthetic-reservationist-document.js');
  const { assertReservationistResultFreshForAction } = await import('../src/ai/draft-approval.js');
  const f = syntheticReservationistDocumentFixture(); const { receipt } = await f.run();
  const value = { version: 1, tasks: [{ id: f.input.taskId, kind: 'existing_document', status: 'complete', evidenceRefs: [receipt.binding.sourceRef, receipt.capture.artifactRef] }], existingDocumentReceipts: [receipt] };
  expect(() => assertReservationistResultFreshForAction(value, new Date(f.input.clock.sourceAt))).not.toThrow();
  expect(() => assertReservationistResultFreshForAction(value, new Date(receipt.grant.expiresAt))).toThrow(/document/);
  for (const mutate of [(r: typeof receipt) => { r.sourceProof.ownerRef = 'foreign'; }, (r: typeof receipt) => { r.binding.documentDigest = 'b'.repeat(64); }, (r: typeof receipt) => { r.capture.body.sha256 = 'c'.repeat(64); }]) {
    const changed = structuredClone(value); mutate(changed.existingDocumentReceipts[0]);
    expect(() => assertReservationistResultFreshForAction(changed, new Date(f.input.clock.sourceAt))).toThrow(/document/);
  }
  expect(() => assertReservationistResultFreshForAction({ ...value, tasks: [{ ...value.tasks[0], evidenceRefs: [] }] }, new Date(f.input.clock.sourceAt))).toThrow(/document/);
});

it('admits actual native offers inside their sourced three-day window but refuses its unresolved boundary', async () => {
  const { syntheticRevision } = await import('./helpers/synthetic-quote-revision.js');
  const { assertReservationistResultFreshForAction } = await import('../src/ai/draft-approval.js');
  const revision = await syntheticRevision();
  const result = { version: 1, quoteRevisions: [revision] };
  expect(() => assertReservationistResultFreshForAction(result, new Date('2026-10-04T09:30:00Z'))).not.toThrow();
  for (const [day, allowed] of [['2026-10-04', true], ['2026-10-05', true], ['2026-10-06', true], ['2026-10-07', false], ['2026-10-08', false], ['2026-10-03', false]] as const) {
    const now = new Date(`${day}T09:30:00Z`);
    const offer = { ...revision, sourceFreshness: { ...revision.sourceFreshness!, observedAt: `${day}T09:00:00Z`, expiresAt: `${day}T10:00:00Z` } };
    const check = () => assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [offer] }, now);
    if (allowed) expect(check).not.toThrow(); else expect(check).toThrow(/cutoff|expired/);
  }
  expect(() => assertReservationistResultFreshForAction(result, new Date('2026-10-04T10:00:00Z'))).toThrow(/source/);
  for (const authoredDate of ['2026-02-30', '', '2026-10-04T00:00:00Z'])
    expect(() => assertReservationistResultFreshForAction({version: 1, quoteRevisions: [{ ...revision, authoredDate }]}, new Date('2026-10-04T09:30:00Z'))).toThrow(/cutoff/);
  for (const validity of [{ ...revision.validity, days: 7 }, { ...revision.validity, anchor: 'delivery_date' }])
    expect(() => assertReservationistResultFreshForAction({version: 1, quoteRevisions: [{ ...revision, validity }]}, new Date('2026-10-04T09:30:00Z'))).toThrow(/cutoff/);
  expect(() => assertReservationistResultFreshForAction({version:1,approvedOverrides:[{authorizationId:revision.authorizationId,sourceRevision:revision}]},new Date('2026-10-04T09:30:00Z'))).not.toThrow();
});

it('retains any explicit expiry and Johannesburg boundary even inside the authored calendar window', async () => {
  const { syntheticRevision } = await import('./helpers/synthetic-quote-revision.js');
  const { assertReservationistResultFreshForAction } = await import('../src/ai/draft-approval.js');
  const revision = await syntheticRevision();
  expect(() => assertReservationistResultFreshForAction({version:1,quoteRevisions:[{...revision,validity:{...revision.validity,expiresAt:'2026-10-04T09:15:00Z'}}]},new Date('2026-10-04T09:30:00Z'))).toThrow(/expired|validity/);
  const now = new Date('2026-10-06T22:00:00Z');
  const boundary = {...revision,sourceFreshness:{...revision.sourceFreshness!,observedAt:'2026-10-06T21:00:00Z',expiresAt:'2026-10-06T23:00:00Z'}};
  expect(() => assertReservationistResultFreshForAction({version:1,quoteRevisions:[boundary]},now)).toThrow(/cutoff/);
});


describe('source-bound conditional policy wording',()=>{
 const policy='8. A No-show fee equal to one night’s stay will be charged for guaranteed reservations who do not adhere to the following cancellation policy: (a). Cancellation - Seven or less rooms - within 48 hours prior to arrival will be subject to a full cancellation fee of the value of one night’s accommodation booked. (b). Cancellation - Eight rooms or more – Legacy Hotels & Resort group cancellation policy will apply.';
 const result=(value=policy)=>({version:1,tasks:[{id:'policy',kind:'question',status:'complete',guestText:'Regarding your question: '+value,evidenceRefs:['original-policy']}],preparedFacts:[{key:'quote_terms_cancellation_policy',value,source:'mail',authority:'authorized',status:'known',scopeVerified:true,disclosure:'guest',sourceHash:'a'.repeat(64),scopeHash:'b'.repeat(64),evidenceRef:'original-policy'}]});
 it('allows the exact authorized conditional fee class and fee basis without claiming a booked stay',async()=>{const {assertReservationistResultWording}=await import('../src/ai/draft-approval.js');const r=result(),text=r.tasks[0].guestText;expect(()=>assertReservationistResultWording(r,{subject:'',text,html:'<p>'+text+'</p>'})).not.toThrow();});
 it.each(['Your booking is confirmed.','You have a guaranteed booking.','We have booked your room.','Payment has cleared.'])('still rejects an independent action after the policy: %s',async action=>{const {assertReservationistResultWording}=await import('../src/ai/draft-approval.js');const r=result(),text=r.tasks[0].guestText;for(const payload of [{subject:action,text,html:''},...['. ','\n','; ',' but ',' and '].map(separator=>({subject:'',text:text+separator+action,html:''})),{subject:'',text,html:'<p>'+action.replace('confirmed','conf&#105;rmed')+'</p>'}])expect(()=>assertReservationistResultWording(r,payload)).toThrow();const forged=result(policy+' '+action);expect(()=>assertReservationistResultWording(forged,{subject:'',text:forged.tasks[0].guestText,html:''})).toThrow();});
 it.each(['task','fact','hash','scope','value','ref'])('denies missing or mismatched source join: %s',async change=>{const {assertReservationistResultWording}=await import('../src/ai/draft-approval.js');const r=result();if(change==='task')r.tasks[0].status='needs_clarification';if(change==='fact')r.preparedFacts=[];if(change==='hash')r.preparedFacts[0].sourceHash='bad';if(change==='scope')r.preparedFacts[0].scopeVerified=false;if(change==='value')r.preparedFacts[0].value='Other policy';if(change==='ref')r.tasks[0].evidenceRefs=[];expect(()=>assertReservationistResultWording(r,{subject:'',text:'Regarding your question: '+policy,html:''})).toThrow();});
 it.each(['The fee is the cost of accommodation booked by us for your party.','A fee will be charged for your guaranteed reservations who cancel late.'])('denies attributed policy prefixes: %s',async value=>{const {assertReservationistResultWording}=await import('../src/ai/draft-approval.js');const r=result(value);expect(()=>assertReservationistResultWording(r,{subject:'',text:r.tasks[0].guestText,html:''})).toThrow();});
 it('does not exempt edited guaranteed or booked claims under a valid policy result',async()=>{const {assertReservationistResultWording}=await import('../src/ai/draft-approval.js');const r=result();for(const text of ['Regarding your question: Your reservation is guaranteed.','Regarding your question: Your accommodation is booked.','Regarding your question: The guaranteed reservation has been made.'])expect(()=>assertReservationistResultWording(r,{subject:'',text,html:''})).toThrow();});
});
