import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';

async function guest(text:string,firstName='Alex',lastName='Sample B.',quote=`${firstName} ${lastName}`){
 const hash=createHash('sha256').update(text).digest('hex'),source={attachmentId:'message:m',sourceHash:hash,page:1,quote:text,start:0,end:text.length};
 return extractReservationistPlan({mode:'combined',adapter:{invoke:async()=>({output:{facts:[{id:'guest',kind:'guest',disclosure:'guest',source:{...source,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length},value:{firstName,lastName}}],tasks:[{id:'accepted',kind:'acceptance',source,factIds:['guest']}],unresolvedAsks:[]}})} as never,messages:[{id:'m',text,at:'2026-10-01T12:00:00Z',direction:'inbound'}],causalAt:'2026-10-01T12:00:00Z',triggerMessageId:'m',admissions:[],signal:new AbortController().signal});
}
it('retains the printed final initial period in an exactly sourced guest name',async()=>{
 const result=await guest('I accept the offer. Guest: Alex Sample B.');
 expect(result.facts[0].value).toEqual({firstName:'Alex',lastName:'Sample B.'});
});
it.each(['Not Alex Sample B.','Without Alex Sample B.','Not guest: Alex Sample B.'])('does not narrow away original negation around a punctuated guest: %s',async text=>{
 await expect(guest(text)).rejects.toThrow('entailed');
});
it('does not invent an unprinted name period or match a longer name token',async()=>{
 await expect(guest('Accepted for Alex Sample B.', 'Alex','Sample C.','Alex Sample B.')).rejects.toThrow('entailed');
 await expect(guest('Accepted for Alex Sample B.X','Alex','Sample B.')).rejects.toThrow('entailed');
});
it('does not infer name ordering or borrow an initial from another semantic row',async()=>{
 await expect(guest('Accepted for Sample B. Alex','Alex','Sample B.','Sample B. Alex')).rejects.toThrow('entailed');
 await expect(guest('Accepted for Alex Sample. Separate guest B.','Alex','Sample B.','Alex Sample. Separate guest B.')).rejects.toThrow('entailed');
});
