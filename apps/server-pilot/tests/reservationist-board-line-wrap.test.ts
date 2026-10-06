import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {extractReservationistPlan} from '../src/ai/reservationist-extraction.js';
async function board(text:string,value='breakfast and dinner',quote=text){
 const hash=createHash('sha256').update(text).digest('hex'),source=(q:string)=>({attachmentId:'message:m',sourceHash:hash,page:1,quote:q});
 return extractReservationistPlan({adapter:{invoke:async()=>({output:{facts:[{id:'board',kind:'board',value,source:source(quote),disclosure:'guest'}],tasks:[{id:'q',kind:'quote',source:source(text),factIds:['board']}],unresolvedAsks:[]}})} as never,messages:[{id:'m',text,at:'2026-09-30T08:00:00Z',direction:'inbound'}],causalAt:'2026-09-30T08:00:00Z',admissions:[],signal:new AbortController().signal});
}
it('verifies board words across original line wrap without changing the bound quote',async()=>{
 const text='Please quote accommodation, inclusive of breakfast and\ndinner';
 const p=await board(text);expect(p.facts[0].source.quote).toBe(text);expect(p.facts[0].value).toBe('breakfast and dinner');
});
it.each(['Please quote breakfast and\ndinner excluded','Please quote no breakfast and\ndinner','Please quote breakfast and\ndinner is not included','Please quote breakfast. Separate request: dinner'])('rejects excluded or separated meal claims: %s',async text=>{
 await expect(board(text)).rejects.toThrow('entailed');
});
it('does not narrow a wrapped dinner-and-breakfast request to breakfast alone',async()=>{
 await expect(board('Please quote breakfast and\ndinner','breakfast','breakfast')).rejects.toThrow('entailed');
});
it('does not borrow board words outside the exact source quote',async()=>{
 await expect(board('Accommodation required, breakfast and dinner','breakfast and dinner','Accommodation required')).rejects.toThrow('entailed');
});
