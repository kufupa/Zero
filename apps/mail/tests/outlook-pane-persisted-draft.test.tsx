// @vitest-environment happy-dom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import OutlookPanePage from '../app/(routes)/outlook-pane/page';
const state=vi.hoisted(()=>({selection:'native-1',transport:'transport-1',draftId:null as string|null,threadId:null as string|null,resolve:vi.fn(),list:vi.fn(),get:vi.fn(),ensure:vi.fn(),bridge:vi.fn(),editor:vi.fn(),hydration:vi.fn(),urlChanges:[] as unknown[]}));
vi.mock('../lib/workstation/use-outlook-bridge',()=>({useOutlookBridge:()=>({isConnected:true,activeEmail:{entryId:state.selection,storeId:'store',folderEntryId:'inbox',internetMessageId:`<${state.selection}@example.invalid>`,subject:'Actual selected request'},supportsAction:()=>false,sendCommand:state.bridge})}));
vi.mock('../lib/auth-client',()=>({useSession:()=>({data:{user:{id:'staff-1'},session:{id:'session-1'}},isLoading:false}),signIn:{email:vi.fn()}}));
vi.mock('../hooks/use-connections',()=>({useActiveConnection:()=>({data:{id:state.transport,email:'mailbox@example.invalid'},isLoading:false})}));
vi.mock('../providers/query-provider',()=>({trpcClient:{workstation:{qualifiedProposalChoices:{query:state.resolve}},drafts:{list:{query:state.list},get:{query:state.get},ensureEditableForReply:{mutate:state.ensure}}}}));
vi.mock('../hooks/use-drafts',()=>({useDraftArtifactHydration:state.hydration}));
vi.mock('nuqs',()=>({useQueryState:(key:string)=>[key==='draftId'?state.draftId:state.threadId,async(value:any)=>{const prior=key==='draftId'?state.draftId:state.threadId,next=typeof value==='function'?value(prior):value;if(key==='draftId')state.draftId=next;else state.threadId=next;state.urlChanges.push({key,next});}]}));
vi.mock('../components/create/email-composer',()=>({EmailComposer:(props:any)=>{state.editor(props);return <div role="textbox" aria-label="Existing staff composer">{props.initialMessage}</div>;}}));
vi.mock('../components/mail/reservationist-draft-card',()=>({ReservationistDraftCard:(props:any)=><section><p>{props.subject}</p><p>{props.readinessLabel}</p><button onClick={props.onEdit}>Review saved draft</button></section>}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),warning:vi.fn()}}));
const candidate={id:'candidate-1',threadId:'thread-1',replyToMessageId:'message-1',subject:'Actual saved quote',content:'Persisted original body',to:['guest@example.invalid'],cc:[],bcc:[],status:'candidate',origin:'ai',updatedAt:'2026-10-05T12:00:00Z',attachments:[],reviewSummary:{readinessLabel:'Needs review',readinessReason:'Quote source expired',tasks:[],preparedFacts:[]}};
beforeEach(()=>{vi.clearAllMocks();localStorage.setItem('nava_onboarding_completed','true');state.selection='native-1';state.transport='transport-1';state.draftId=null;state.threadId=null;state.urlChanges=[];state.resolve.mockResolvedValue({status:'awaiting_qualified_quote',threadId:'thread-1',messageId:'message-1',choices:[]});state.list.mockResolvedValue({threads:[candidate]});state.get.mockResolvedValue(candidate);state.ensure.mockResolvedValue({...candidate,status:'active'});state.hydration.mockReturnValue({entries:[],files:[],snapshotKey:'candidate-1',retry:vi.fn()});});
afterEach(cleanup);
async function load(){fireEvent.click(screen.getByRole('button',{name:'Load saved reply draft'}));await screen.findByText('Actual saved quote');}
it('loads the selected mailbox reply candidate and opens the guarded existing composer',async()=>{
 const view=render(<OutlookPanePage/>);await load();expect(state.resolve).toHaveBeenCalledWith({internetMessageId:'<native-1@example.invalid>'});expect(state.list).toHaveBeenCalledWith({threadId:'thread-1',limit:20});expect(state.get).toHaveBeenCalledWith({id:'candidate-1'});
 state.get.mockResolvedValue({...candidate,status:'active'});
 fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));await waitFor(()=>expect(state.ensure).toHaveBeenCalledWith({threadId:'thread-1',replyToMessageId:'message-1'}));await act(async()=>view.rerender(<OutlookPanePage/>));await screen.findByRole('textbox',{name:'Existing staff composer'});
 expect(state.draftId).toBe('candidate-1');expect(state.threadId).toBe('thread-1');expect(state.editor.mock.calls.at(-1)?.[0]).toMatchObject({initialMessage:candidate.content,initialSubject:candidate.subject,replyToMessageId:'message-1',syncReplyHeadersFromProps:true});expect(state.bridge).not.toHaveBeenCalled();
});
it('lets stale candidates remain visible but respects promotion refusal',async()=>{
 state.ensure.mockRejectedValue({data:{code:'CONFLICT'},message:'STALE_AI_CANDIDATE'});render(<OutlookPanePage/>);await load();fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));await screen.findByText(/Unable to open.*refresh/i);expect(state.editor).not.toHaveBeenCalled();expect(state.draftId).toBeNull();
});
it('discards a selected-message read that completes after Outlook selection changes',async()=>{
 let finish:any;state.resolve.mockImplementation(()=>new Promise(r=>finish=r));const view=render(<OutlookPanePage/>);fireEvent.click(screen.getByRole('button',{name:'Load saved reply draft'}));state.selection='native-2';view.rerender(<OutlookPanePage/>);await act(async()=>finish({threadId:'thread-1',messageId:'message-1',choices:[]}));expect(state.list).not.toHaveBeenCalled();expect(screen.queryByText('Actual saved quote')).toBeNull();
});
it('rejects a draft belonging to another reply parent or changed thread',async()=>{
 state.get.mockResolvedValue({...candidate,threadId:'foreign-thread'});render(<OutlookPanePage/>);fireEvent.click(screen.getByRole('button',{name:'Load saved reply draft'}));await screen.findByText(/Unable to load.*draft/i);expect(screen.queryByText('Actual saved quote')).toBeNull();expect(state.ensure).not.toHaveBeenCalled();
});
it('does not overwrite another editor URL identity when opening a pane draft',async()=>{
 state.draftId='foreign-draft';state.threadId='foreign-thread';render(<OutlookPanePage/>);await load();fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));await screen.findByText(/another draft.*open/i);expect(state.ensure).not.toHaveBeenCalled();expect(state.urlChanges).toEqual([]);
});
it('does not open after promotion completes for an abandoned selection',async()=>{
 let finish:any;state.ensure.mockImplementation(()=>new Promise(r=>finish=r));const view=render(<OutlookPanePage/>);await load();fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));state.selection='native-2';view.rerender(<OutlookPanePage/>);await act(async()=>finish({...candidate,status:'active'}));expect(state.draftId).toBeNull();expect(state.editor).not.toHaveBeenCalled();
});
it('refuses editing when original attachment hydration reports changed bytes',async()=>{
 state.get.mockResolvedValue({...candidate,attachments:[{artifactRef:'generated:x',sourceHash:'a'.repeat(64),sizeBytes:10,filename:'quote.pdf',mimeType:'application/pdf'}]});state.hydration.mockReturnValue({entries:[{artifactRef:'generated:x',filename:'quote.pdf',state:'changed'}],files:[],snapshotKey:'changed',retry:vi.fn()});render(<OutlookPanePage/>);await load();fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));await screen.findByText(/original bytes have been verified/);expect(state.ensure).not.toHaveBeenCalled();
});
it('rejects an existing active draft returned for a different reply parent',async()=>{
 state.ensure.mockResolvedValue({...candidate,status:'active',replyToMessageId:'other-message'});render(<OutlookPanePage/>);await load();fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));await screen.findByText(/Unable to open.*refresh/i);expect(state.draftId).toBeNull();expect(state.editor).not.toHaveBeenCalled();
});
it('retains the mounted editor on saved-draft refetch and clears only its owned URL on selection change',async()=>{
 const view=render(<OutlookPanePage/>);await load();state.get.mockResolvedValue({...candidate,status:'active'});fireEvent.click(screen.getByRole('button',{name:'Review saved draft'}));await waitFor(()=>expect(state.draftId).toBe('candidate-1'));view.rerender(<OutlookPanePage/>);await screen.findByRole('textbox',{name:'Existing staff composer'});
 const editorProps=state.editor.mock.calls.at(-1)![0];state.get.mockResolvedValue({...candidate,status:'active',content:'Later server body'});await load();expect(state.editor.mock.calls.at(-1)![0].initialMessage).toBe(editorProps.initialMessage);
 state.resolve.mockRejectedValue(new Error('refetch unavailable'));fireEvent.click(screen.getByRole('button',{name:'Load saved reply draft'}));await screen.findByText(/Unable to load the authorized saved draft/);expect(screen.getByRole('textbox',{name:'Existing staff composer'})).toBeDefined();
 state.selection='native-2';view.rerender(<OutlookPanePage/>);await waitFor(()=>expect(state.draftId).toBeNull());expect(state.threadId).toBeNull();expect(screen.queryByRole('textbox',{name:'Existing staff composer'})).toBeNull();
});
