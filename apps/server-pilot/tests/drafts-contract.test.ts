/**
 * Draft body wire contract: create stores content readable on get/list reopen.
 */
import { describe, expect, it } from 'vitest';
import {configureDraftArtifactStorage} from '../src/trpc/routes/drafts.js';
import {createHash} from 'node:crypto';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'drafts content contract (seeded, transaction-rollback)',
  () => {
    it(
      'drafts.create message reopens non-empty from get and list',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          const body = '<p>Hello draft</p>';

          const { id } = await caller.drafts.create({
            to: '',
            subject: 'Draft contract',
            message: body,
          });

          const got = await caller.drafts.get({ id });
          expect(got.content).toBe(body);

          const listed = await caller.drafts.list({});
          const row = listed.threads.find((t) => t.id === id);
          expect(row?.content).toBe(body);
        });
      },
      30000,
    );
    it('persists exact staff attachment bytes through create, reopen and removal',async()=>{
      await withSeededTestDb(async db=>{
        const objects=new Map<string,Buffer>(),writes:string[]=[];
        configureDraftArtifactStorage({stage:async(key,body)=>{writes.push(key);objects.set(key,Buffer.from(body));},read:async key=>objects.get(key)??null});
        try{
          const caller=await callerFor('user-navaai',{db}),body=Buffer.from('%PDF-1.4\nactual staff file\n%%EOF\n'),hash=createHash('sha256').update(body).digest('hex'),a={name:'Staff quote.pdf',type:'application/pdf',size:body.length,lastModified:0,base64:body.toString('base64')};
          const {id}=await caller.drafts.create({to:'guest@example.invalid',subject:'Staff review',message:'<p>Unsent staff review</p>',attachments:[a]});
          const got=await caller.drafts.get({id});expect(got.attachments).toHaveLength(1);const file=got.attachments[0]!;expect(file.sourceHash).toBe(hash);
          const bytes=await caller.drafts.getArtifact({draftId:id,artifactRef:file.artifactRef!});expect(Buffer.from(bytes.base64,'base64')).toEqual(body);
          await caller.drafts.create({id,to:'guest@example.invalid',subject:'Staff edited',message:'<p>Edited</p>',attachments:[a]});
          expect((await caller.drafts.get({id})).attachments[0]?.artifactRef).toBe(file.artifactRef);expect(writes).toHaveLength(1);
          await caller.drafts.create({id,to:'guest@example.invalid',subject:'Staff edited',message:'<p>Edited</p>',attachments:[]});expect((await caller.drafts.get({id})).attachments).toEqual([]);
        }finally{configureDraftArtifactStorage(null);}
      });
    },30000);
    it('refuses malformed staff bytes before any artifact is staged',async()=>{
      await withSeededTestDb(async db=>{
        let writes=0;configureDraftArtifactStorage({stage:async()=>{writes++;},read:async()=>null});
        try{const caller=await callerFor('user-navaai',{db});await expect(caller.drafts.create({to:'',subject:'Malformed',message:'',attachments:[{name:'x.pdf',type:'application/pdf',size:9,lastModified:0,base64:'YQ=='}]})).rejects.toMatchObject({code:'BAD_REQUEST'});expect(writes).toBe(0);}finally{configureDraftArtifactStorage(null);}
      });
    },30000);
  },
);
