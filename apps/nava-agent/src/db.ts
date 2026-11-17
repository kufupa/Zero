import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
export const sql = postgres(process.env.DATABASE_URL ?? '', {max:20});
export const uid = (prefix:string) => `${prefix}_${randomUUID()}`;
export const json = (v:unknown) => sql.json(v as postgres.JSONValue);
export async function event(session:string, kind:string, payload:unknown, managedId:string|null = null) {
  await sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:'+session},0))`;
    await tx`INSERT INTO nava_agent.agent_event (id,session_id,managed_event_id,kind,payload) VALUES (${uid('evt')},${session},${managedId},${kind},${json(payload)}) ON CONFLICT (managed_event_id) DO NOTHING`;
  });
}
