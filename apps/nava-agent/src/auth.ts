import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type Principal = {kind:'service'} | {kind:'staff';id:string;mailboxes:string[]};
const claims=z.object({sub:z.string().min(1),aud:z.literal('nava-agent'),mailbox_ids:z.array(z.string().min(1)),iat:z.number().int(),exp:z.number().int()});
const equal=(a:Buffer,b:Buffer)=>a.length===b.length && timingSafeEqual(a,b);
export function authenticate(header:string|undefined):Principal|null {
  if (!header?.startsWith('Bearer ')) return null;
  const token=header.slice(7), service=process.env.NAVA_API_TOKEN;
  if(service && equal(Buffer.from(token),Buffer.from(service))) return {kind:'service'};
  const secret=process.env.NAVA_STAFF_JWT_SECRET;
  if(!secret) return null;
  const parts=token.split('.');
  if(parts.length!==3 || !parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const [head,payload,signature]=parts;
    const algorithm=JSON.parse(Buffer.from(head,'base64url').toString('utf8'));
    if(algorithm.alg!=='HS256') return null;
    const expected=createHmac('sha256',secret).update(`${head}.${payload}`).digest();
    if(!equal(Buffer.from(signature,'base64url'),expected)) return null;
    const parsed=claims.safeParse(JSON.parse(Buffer.from(payload,'base64url').toString('utf8')));
    if(!parsed.success) return null;
    const now=Math.floor(Date.now()/1000), c=parsed.data;
    if(c.iat>now || c.exp<=now || c.exp<=c.iat || c.exp-c.iat>300) return null;
    return {kind:'staff',id:c.sub,mailboxes:c.mailbox_ids};
  } catch { return null; }
}
export const hasMailbox=(principal:Principal,mailbox:string)=>principal.kind==='service'||principal.mailboxes.includes(mailbox);
