import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Principal } from './auth.js';
import { json, sql } from './db.js';
import { writeEvent } from './session-store.js';
import { createQuoteArtifacts, quoteOptions, type Artifact } from '../tools/quote-artifacts/index.js';
import { gotenbergConverter } from '../tools/quote-artifacts/converter.js';
import { quoteInput } from '../tools/quote/schema.js';

const id = z.string().min(1).max(200);
const request = z.object({expected_revision:z.number().int().positive().safe(),quote_id:id,
  selections:z.array(z.object({group_id:id,room_id:id,option_index:z.number().int().nonnegative().safe()}).strict()).min(1).max(80)}).strict();
const source = z.object({direction:z.literal('inbound'),from:z.object({name:z.string().nullable(),email:z.string()})});
const capture = z.object({quotes:z.record(z.unknown()),searches:z.array(z.object({arrival_date:id,departure_date:id,
  native_result:z.object({outcome:z.string(),audit:z.object({status:z.string()})})})).min(1)});
const stage = z.object({revision:z.number().int(),job_id:id,native_result:capture,artifacts:z.array(z.unknown()).optional()});
const actions = z.object({actions:z.array(z.object({type:z.string(),details:z.unknown()}))});
const fileId = z.string().uuid();
const artifact = z.object({id:fileId,name:z.enum(['Quotation.pdf','Quotation.xlsx']),
  mime_type:z.enum(['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),url:z.string()});
const limit = 20 * 1024 * 1024;
const quoteCalendar = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'});

function authoredDate() {
  const parts = quoteCalendar.formatToParts();
  const date = (part:string) => parts.find(value=>value.type===part)?.value;
  return `${date('year')}-${date('month')}-${date('day')}`;
}

function converterUrl() {
  const value = process.env.NAVA_QUOTE_GOTENBERG_URL ?? process.env.GOTENBERG_URL;
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname) && !url.username && !url.password &&
        url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch { /* Invalid deployments do not advertise the route as ready. */ }
}

async function artifactDir() {
  const root = process.env.NAVA_QUOTE_ARTIFACT_DIR;
  if (!root || !isAbsolute(root)) throw new Error('ARTIFACT_DIR_REQUIRED');
  await mkdir(root,{recursive:true,mode:0o700});
  const info = await lstat(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('ARTIFACT_DIR_NOT_PRIVATE');
  return root;
}

function responseError(code:string,message:string) { return {error:{code,message,details:null}}; }

export function registerQuoteArtifacts(app:Hono<{Variables:{principal:Principal}}>) {
  app.post('/proposals/:id/quote-artifacts',async c=>{
    const principal = c.get('principal');
    if (principal.kind !== 'staff') return c.json(responseError('FORBIDDEN','Signed staff identity required.'),403);
    const parsed = request.safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json(responseError('INVALID_INPUT','Select native quote options for this revision.'),400);
    const input = parsed.data;
    const proposalId = c.req.param('id');
    const [row] = await sql`SELECT p.session_id,p.thread_id,p.revision,p.phase,p.current,p.stage,t.mailbox_id,t.property_code,t.mode,m.payload AS selected
      FROM nava_agent.proposal p JOIN nava_agent.mail_thread t ON t.id=p.thread_id
      JOIN nava_agent.mail_message m ON m.thread_id=t.id AND m.source_message_id=t.selected_message_id
      WHERE p.id=${proposalId} AND p.workflow='quote'`;
    if (!row || !principal.mailboxes.includes(row.mailbox_id)) return c.json(responseError('NOT_FOUND','Quote not found.'),404);
    const ready = stage.safeParse(row.stage);
    if (row.mode !== 'live' || row.phase !== 'ready' || row.revision !== input.expected_revision || !ready.success ||
        ready.data.revision !== row.revision || ready.data.artifacts?.length) {
      return c.json(responseError('QUOTE_REVISION_UNAVAILABLE','Run and select options from the current staff quote recheck.'),409);
    }
    const draft = actions.safeParse(row.current);
    const selected = source.safeParse(row.selected);
    const matching = draft.success ? draft.data.actions.flatMap(a=>{
      const quote = quoteInput.safeParse(a.details);
      return a.type === 'quote' && quote.success && quote.data.quote_id === input.quote_id ? [quote.data] : [];
    }) : [];
    const [quote] = matching;
    const native = Object.hasOwn(ready.data.native_result.quotes,input.quote_id) ? ready.data.native_result.quotes[input.quote_id] : undefined;
    if (matching.length !== 1 || !quote || quote.property_code !== row.property_code || native === undefined || !selected.success) {
      return c.json(responseError('QUOTE_CAPTURE_UNAVAILABLE','No matching native quote capture for this revision.'),409);
    }
    const searches=ready.data.native_result.searches;
    if(searches.some((search,i)=>search.native_result.outcome!=='quote' ||
      searches.slice(0,i).some(prior=>prior.arrival_date<search.departure_date && search.arrival_date<prior.departure_date))) {
      return c.json(responseError('QUOTE_ALLOCATION_UNVERIFIED','Choose a quote with verified prices and availability for all requested nights.'),409);
    }
    const options=quoteOptions(quote,ready.data.native_result);
    const selectedOptions=input.selections.map(selection=>options.find(option=>option.group_id===selection.group_id &&
      option.room_id===selection.room_id && option.option_index===selection.option_index));
    if(selectedOptions.some(option=>!option)) return c.json(responseError('QUOTE_NOT_RENDERABLE','The selected quote is incomplete or cannot be represented by the quotation template.'),409);
    const converter = converterUrl();
    if (!converter || !process.env.NAVA_QUOTE_ARTIFACT_DIR) return c.json(responseError('ARTIFACTS_UNAVAILABLE','Private quote artifact service unavailable.'),503);
    const job = ready.data.job_id;
    const result = await createQuoteArtifacts({
      resolveQuote:async()=>({quote_id:quote.quote_id,proposal_id:proposalId,revision:row.revision,property_code:quote.property_code,
        authored_date:authoredDate(),groups:quote.groups,capture:native,selections:input.selections,
        header:{attention:selected.data.from.name??'',organization:'',clientEmail:selected.data.from.email,clientTelephone:'',signerName:'',signerEmail:''}}),
      convertWorkbook:gotenbergConverter(converter),
      writePair:async({pdf,workbook,signal})=>{
        const root = await artifactDir();
        const files:string[] = [];
        const write = async (output:typeof pdf):Promise<Artifact>=>{
          signal?.throwIfAborted();
          if (output.bytes.byteLength > limit) throw new Error('ARTIFACT_TOO_LARGE');
          const artifactId = randomUUID(), path = join(root,artifactId);
          const handle=await open(path,'wx',0o600);
          files.push(path);
          try { await handle.writeFile(output.bytes); } finally { await handle.close(); }
          return {id:artifactId,name:output.name,mime_type:output.mime_type,url:`/api/nava/v1/artifacts/${artifactId}`};
        };
        try {
          const pdfRef = await write(pdf), workbookRef = await write(workbook);
          signal?.throwIfAborted();
          await sql.begin(async tx=>{
            const saved = await tx`UPDATE nava_agent.proposal p SET stage=p.stage || ${json({artifacts:[pdfRef,workbookRef],quote_selected_options:selectedOptions})}::jsonb,updated_at=now()
              FROM nava_agent.mail_thread t WHERE p.thread_id=t.id AND p.id=${proposalId} AND p.revision=${input.expected_revision}
              AND p.phase='ready' AND p.stage->>'job_id'=${job} AND COALESCE(p.stage->'artifacts','[]'::jsonb)='[]'::jsonb AND p.workflow='quote'
              AND t.mailbox_id=${row.mailbox_id} AND t.mode='live' RETURNING p.id`;
            if (saved.length !== 1) throw new Error('QUOTE_REVISION_CHANGED');
            await writeEvent(tx,row.session_id,'quote_artifacts_ready',{proposal_id:proposalId,revision:input.expected_revision,
              job_id:job,quote_id:quote.quote_id,artifact_ids:[pdfRef.id,workbookRef.id]});
          });
          return {pdf:pdfRef,workbook:workbookRef};
        } catch (error) {
          await Promise.allSettled(files.map(file=>unlink(file)));
          throw error;
        }
      },
    })({quote_id:input.quote_id},{sessionId:row.session_id,mode:'live',signal:c.req.raw.signal});
    return result.ok ? c.json(result.data,201) : c.json(responseError(result.error.code,result.error.message),result.error.retryable?503:409);
  });

  app.get('/artifacts/:id',async c=>{
    const principal = c.get('principal');
    const wanted = fileId.safeParse(c.req.param('id'));
    const missing = responseError('NOT_FOUND','Quote artifact not found.');
    if (principal.kind !== 'staff' || !wanted.success) return c.json(missing,404);
    const [row] = await sql`SELECT p.stage->'artifacts' AS artifacts,t.mailbox_id FROM nava_agent.proposal p
      JOIN nava_agent.mail_thread t ON t.id=p.thread_id WHERE p.workflow='quote' AND t.mode='live'
      AND p.phase='ready' AND p.stage->>'revision'=p.revision::text
      AND p.stage->'artifacts' @> ${json([{id:wanted.data}])}`;
    if (!row || !principal.mailboxes.includes(row.mailbox_id)) return c.json(missing,404);
    const refs = z.array(artifact).safeParse(row.artifacts);
    const ref = refs.success ? refs.data.find(item=>item.id===wanted.data) : undefined;
    if (!ref) return c.json(missing,404);
    try {
      const root = await artifactDir();
      const file = await open(join(root,ref.id),constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) return c.json(missing,404);
        return c.body(Uint8Array.from(await file.readFile()),200,{'Content-Type':ref.mime_type,
          'Content-Disposition':`attachment; filename="${ref.name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      } finally { await file.close(); }
    } catch { return c.json(missing,404); }
  });
}
