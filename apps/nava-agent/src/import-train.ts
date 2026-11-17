import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { importThread } from './runtime.js';
import { threadInput } from './schema.js';
import { sql } from './db.js';

const address=z.string().email();
const sourceMessage=z.object({thread_id:z.string().min(1),message_id:z.string().min(1),timestamp:z.string().datetime({offset:true}),direction:z.enum(['inbound','outbound']),subject:z.string(),addresses:z.object({from:z.array(address).length(1),to:z.array(address),cc:z.array(address),bcc:z.array(address)}).passthrough(),body:z.string()}).passthrough();
const trainRecord=z.object({decision_id:z.string().min(1),split:z.literal('train'),input_cutoff:z.string().datetime({offset:true}),selected_message:sourceMessage,earlier_relevant_source_events:z.array(z.object({message:sourceMessage}).passthrough())}).passthrough();
const [path, decision, run, mailbox] = process.argv.slice(2);
if (!path || !decision || !run || !mailbox || !process.env.DATABASE_URL) throw new Error('Usage: import-train <model-safe-inputs.jsonl> <decision_id> <run_id> <mailbox_id>; DATABASE_URL required');
const hash=createHash('sha256');
for await (const chunk of createReadStream(path)) hash.update(chunk);
if(hash.digest('hex')!=='34e6aafb566b0b3e248e04f0793f1dfc8235df83630775a0d8dda5c37a89bcaa') throw new Error('Only the approved model-safe dataset is accepted');
let imported=false;
try {
  for await (const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})) {
    if (!line.trim()) continue;
    const raw:unknown=JSON.parse(line);
    if (typeof raw!=='object' || raw===null || !('split' in raw) || raw.split!=='train' || !('decision_id' in raw) || raw.decision_id!==decision) continue;
    const record=trainRecord.parse(raw);
    if(record.selected_message.direction!=='inbound') throw new Error('Selected message is not inbound');
    const messages=[...record.earlier_relevant_source_events.map(e=>e.message),record.selected_message].map(m=>({
      id:m.message_id,rfc_message_id:null,direction:m.direction,from:{name:null,email:m.addresses.from[0]},
      to:m.addresses.to.map(email=>({name:null,email})),cc:m.addresses.cc.map(email=>({name:null,email})),
      received_at:m.timestamp,subject:m.subject,body_text:m.body,body_html:null,attachments:[],
    }));
    const input=threadInput.parse({source:'eval',source_thread_id:JSON.stringify([run,record.selected_message.thread_id,record.decision_id]),mailbox_id:mailbox,selected_message_id:record.selected_message.message_id,property_code:null,mode:'historical',messages,decision_id:record.decision_id,input_cutoff:record.input_cutoff});
    const outcome=await importThread(input,JSON.stringify(['train',run,decision]),raw);
    process.stdout.write(JSON.stringify({thread_id:outcome.id,created:outcome.created})+'\n');
    imported=true;
    break;
  }
  if (!imported) throw new Error('Train decision not found');
} finally { await sql.end(); }
