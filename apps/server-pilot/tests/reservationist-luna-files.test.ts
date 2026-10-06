import {describe,it,expect,vi} from 'vitest';
import {LunaModelAdapter,type LunaLanguageModel} from '../src/ai/bedrock/luna.js';
type LunaCallOptions=Parameters<LunaLanguageModel['doGenerate']>[0];
describe('actual admitted bytes through approved Luna adapter',()=>{
 it('passes private PDF bytes as native file part with no URL or key and store false',async()=>{
  const generate=vi.fn(async(_request:LunaCallOptions)=>({content:[{type:'text',text:'{"tasks":[]}'}],usage:{inputTokens:{total:1},outputTokens:{total:1}}}));
  const adapter=new LunaModelAdapter({model:{doGenerate:generate} as any});const pdf=new Uint8Array(Buffer.from('%PDF-1.7 actual bytes'));
  await adapter.invoke({modelId:'global.openai.gpt-6-luna',systemPrompt:'Extract source facts',userPrompt:'read documents',files:[{filename:'evidence.pdf',mediaType:'application/pdf',data:pdf}] } as any);
  const req=generate.mock.calls[0][0] as any;expect(req.prompt[1].content).toContainEqual({type:'file',mediaType:'application/pdf',filename:'evidence.pdf',data:{type:'data',data:pdf}});expect(req.providerOptions.openai.store).toBe(false);
 });
 it('rejects oversized/non-PDF file before model spend',async()=>{
  const generate=vi.fn();const adapter=new LunaModelAdapter({model:{doGenerate:generate} as any});
  await expect(adapter.invoke({modelId:'x',systemPrompt:'x',userPrompt:'x',files:[{filename:'e.pdf',mediaType:'application/pdf',data:new Uint8Array([1,2,3])}]} as any)).rejects.toThrow(/file/);expect(generate).not.toHaveBeenCalled();
 });
});

it('enforces configured provider output ceiling and bounded request bytes before model call',async()=>{
 const generate=vi.fn(async(_request:LunaCallOptions)=>({content:[{type:'text',text:'{"tasks":[]}'}],usage:{inputTokens:{total:1},outputTokens:{total:1}}}));
 const adapter=new LunaModelAdapter({model:{doGenerate:generate} as any});
 await adapter.invoke({modelId:'global.openai.gpt-6-luna',systemPrompt:'Extract',userPrompt:'task',maxOutputTokens:1024,maxInputBytes:4096} as any);
 expect((generate.mock.calls[0][0] as any).maxOutputTokens).toBe(1024);
 await expect(adapter.invoke({modelId:'global.openai.gpt-6-luna',systemPrompt:'Extract',userPrompt:'x'.repeat(5000),maxOutputTokens:1024,maxInputBytes:4096} as any)).rejects.toThrow(/input.*limit/);
 expect(generate).toHaveBeenCalledTimes(1);
});
