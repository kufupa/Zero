import {expect,it} from 'vitest';
import {validateDocumentPlan} from '../src/ai/reservationist-document-facts.js';
function plan(text:string,arrival='2026-10-10',departure='2026-10-16'){
 const source={attachmentId:'range',sourceHash:'a'.repeat(64),disclosure:'guest' as const,pages:[text],pageCount:1};
 return validateDocumentPlan({facts:[{id:'dates',kind:'dates',disclosure:'guest',source:{attachmentId:'range',sourceHash:source.sourceHash,page:1,quote:text,start:0,end:text.length},value:{arrival,departure}}],tasks:[],unresolvedAsks:[]},[source]);
}
it.each(['Accommodation required from 10 to 16 October 2026, including breakfast and dinner','10th to 16th October 2026'])('binds the printed shared month/year across to: %s',async text=>{
 expect(plan(text).facts[0].value).toEqual({arrival:'2026-10-10',departure:'2026-10-16'});
});
it.each(['not 10 to 16 October 2026','10 to 16 October','10 to 16 2026','10 to 16 October 2026 or 11 to 17 November 2026','Arrival 11 October 2026, departure 17 October 2026; not 10 to 16 October 2026'])('rejects excluded/missing/conflicting printed to ranges: %s',async text=>{
 expect(()=>plan(text)).toThrow();
});
it('does not reinterpret a printed envelope as each staggered allocation',()=>{
 const text='Accommodation required from 10 to 16 October 2026';
 expect(()=>plan(text,'2026-10-11','2026-10-16')).toThrow('entailed');
});
