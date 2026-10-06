/** Explicit local synthetic proof: env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS pnpm --dir apps/server-pilot exec tsx tests/quote-proposal-converter-proof.ts */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { buildRevisionProposalPdf, buildQuoteProposalPdf } from '../src/quote-proposal/proposal-pdf.js';
const url=process.env.SYNTHETIC_CONVERTER_URL??'http://127.0.0.1:39180';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw new Error('local synthetic converter only');
const header={attention:'Synthetic only',company:'Synthetic',clientEmail:'test@example.invalid',clientTelephone:'',agency:'Synthetic',signerName:'Test',signerEmail:'test@example.invalid'};
const money=(n:number)=>`R${Math.floor(n/100).toLocaleString('en-ZA')}.${String(n%100).padStart(2,'0')}`;
for(const count of [1,2,6,7,13]){
 const r=await syntheticRevision(Array.from({length:count},(_,i)=>`${100+i}.01`));
 const result=await buildRevisionProposalPdf(r,header,{url});
 const path=`/tmp/u5-synthetic-${count}.pdf`;writeFileSync(path,result.pdf);
 const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});
 for(let i=0;i<count;i++)if(!text.includes(money((10000+i*100+1)*2)))throw new Error(`missing displayed line ${i}`);
 if(!text.replace(/\s/g,'').includes(money(r.totalMinor).replace(/\s/g,'')))throw new Error('displayed_total_mismatch');
 writeFileSync(`${path}.json`,JSON.stringify({revisionId:r.id,pdfHash:result.pdfHash,totalMinor:r.totalMinor}));
 console.log(`revision ${count} lines: exact money verified; PDF SHA256 ${result.pdfHash}`);
}
for(const count of [1,2,6]){
 const result=await buildQuoteProposalPdf({attention:header.attention,company:header.company,clientEmail:header.clientEmail,clientTelephone:header.clientTelephone,agency:header.agency,dateLabel:'Synthetic',lines:Array.from({length:count},(_,i)=>({dateLabel:`Synthetic ${i}`,qty:1,roomCode:'STQN',meal:'room_only' as const,nights:2,rate:1000+i*500}))},{name:'Test',email:'test@example.invalid'},url);
 const path=`/tmp/u1-synthetic-${count}.pdf`;writeFileSync(path,result.pdf);
 const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});
 const values=Array.from({length:count},(_,i)=>(1000+i*500)*2);
 for(const amount of [...values,values.reduce((a,b)=>a+b,0)])if(!text.replace(/[\s,]/g,'').includes(amount.toFixed(2)))throw new Error(`xlsx displayed money missing ${amount}`);
 if(/breakfast.*included|includes.*breakfast/i.test(text))throw new Error('room-only breakfast promise');
 console.log(`legacy XLSX ${count} lines: exact money verified; PDF SHA256 ${createHash('sha256').update(result.pdf).digest('hex')}`);
}
import { resolveImportedOffer,resolveApprovedOverride } from '../src/quote-proposal/quote-revision.js';
import { renderImportedProposalHtml,renderApprovedOverrideHtml,convertProposalHtml } from '../src/quote-proposal/proposal-pdf.js';
const revision=await syntheticRevision();
const original={ref:'synthetic-offer',sourceHash:'a'.repeat(64),authorizationId:revision.authorizationId,scopeDigest:revision.scopeDigest,propertyCode:'HRCEN',currency:'ZAR',printedDate:'2026-10-04',sentAt:'2026-10-04T10:00:00Z',validUntil:'2026-10-07',terms:'Synthetic original terms',lines:Array.from({length:7},(_,i)=>({id:`original-${i}`,page:1,quote:`Original package line ${i}`,amount:'123.45'}))};
const offer=await resolveImportedOffer({ref:original.ref,authorizationId:revision.authorizationId,evaluationAt:'2026-10-05T10:00:00Z',resolveSource:async()=>original,authorizeSource:async()=>true});
const adjustment=await resolveApprovedOverride({revision,ref:'synthetic-approval',evaluationAt:'2026-10-05T10:00:00Z',resolveApproval:async()=>({ref:'synthetic-approval',authorizationId:revision.authorizationId,revisionId:revision.id,sourceHash:'a'.repeat(64),actorRef:'synthetic-staff',reason:'Synthetic approved replacement',approvedAt:'2026-10-04T11:00:00Z',amount:'2000.00',currency:'ZAR'}),authorizeActor:async()=>true});
for(const [kind,html,total] of [['imported',renderImportedProposalHtml(offer,header),offer.totalMinor],['override',renderApprovedOverrideHtml(adjustment,header),adjustment.approvedTotalMinor]] as const){const pdf=await convertProposalHtml(html,{url});const path=`/tmp/u5-synthetic-${kind}.pdf`;writeFileSync(path,pdf);const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});if(!text.replace(/\s/g,'').includes(money(total).replace(/\s/g,'')))throw new Error('source_total_mismatch');if(kind==='override'&&['synthetic-staff','Synthetic approved replacement','2026-10-04T11:00:00Z',revision.id].some(privateValue=>text.includes(privateValue)))throw new Error('private_override_provenance_leaked');console.log(`${kind} source lines exact money verified; PDF SHA256 ${createHash('sha256').update(pdf).digest('hex')}`);}


const usdSource={...original,ref:'synthetic-usd-offer',currency:'USD',lines:[{id:'usd-line',page:1,quote:'Original USD package',amount:'100.01'}]};
const usdOffer=await resolveImportedOffer({ref:usdSource.ref,authorizationId:revision.authorizationId,evaluationAt:'2026-10-05T10:00:00Z',resolveSource:async()=>usdSource,authorizeSource:async()=>true});
const usdPdf=await convertProposalHtml(renderImportedProposalHtml(usdOffer,header),{url});
writeFileSync('/tmp/reservationist-synthetic-usd.pdf',usdPdf);
const usdText=execFileSync('pdftotext',['-layout','/tmp/reservationist-synthetic-usd.pdf','-'],{encoding:'utf8'});
if(!usdText.includes('USD 100.01')||usdText.includes('R100.01'))throw new Error('source_currency_mismatch');
console.log(`imported USD source currency exact money verified; PDF SHA256 ${createHash('sha256').update(usdPdf).digest('hex')}`);
