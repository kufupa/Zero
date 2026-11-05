#!/usr/bin/env python3
import json, os, sys
from collections import defaultdict
from pathlib import Path
from datetime import datetime, timezone

BASE=Path('/home/orca/.codex/sessions/2026')
# USD/1M: OpenAI standard direct API / Azure Global Standard proxy.
# tuple: ordinary input, cached input, 30-minute write, output.
PRICES={
 'gpt-6.1-terra':(1,.05,1.25,5),
 'gpt-6.1-sol':(2,.1,2.5,10),
 'gpt-6-luna':(.1,.01,.125,.5),
 'gpt-6-astra':(10,1,12.5,50),
 'gpt-6-sol':(2,.2,2.5,10),
 'gpt-5.6-luna':(.2,.02,.25,1.2),
 'gpt-5.6-terra':(2,.2,2.5,12),
 'gpt-5.6-sol':(4,.4,5,20),
}
FIELDS=('input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens')

def discovery():
 files=[]
 for date in ('11/04','11/05'):
  for p in (BASE/date).glob('*.jsonl'):
   try:
    with p.open() as f:o=json.loads(f.readline())
    d=o['payload'];files.append((p,d))
   except (OSError,ValueError,KeyError):continue
 return files

def descendants(files,root):
 ids={root};progress=True
 while progress:
  progress=False
  for p,d in files:
   if d.get('parent_thread_id') in ids and d.get('id') not in ids:
    ids.add(d['id']);progress=True
 return [(p,d) for p,d in files if d.get('id') in ids]

def sumset(files,start,end):
 groups=defaultdict(lambda:{'responses':0,'input_tokens':0,'cached_input_tokens':0,'cache_write_input_tokens':0,'output_tokens':0,'reasoning_output_tokens':0,'short':0,'long':0,'near_threshold':0,'usd':0,'unknown_rates':0,'negative_fresh':0,'tiers':set()})
 seen=set();first=None;last=None;missing_model=0
 for path,meta in files:
  current_model=None;current_tier=None
  with path.open() as f:
   for lineno,line in enumerate(f,1):
    try:o=json.loads(line)
    except ValueError:continue
    ts=o.get('timestamp','');p=o.get('payload',{});typ=o.get('type')
    if typ=='event_msg' and p.get('type')=='thread_settings_applied':
     s=p.get('thread_settings',{});current_model=s.get('model',current_model);current_tier=s.get('service_tier',current_tier)
    elif typ=='turn_context':current_model=p.get('model',current_model)
    if typ!='token_usage_record' or not start<=ts<end:continue
    rid=p.get('response_id');u=p.get('usage',{})
    if not rid or rid in seen:continue
    seen.add(rid);first=min(first or ts,ts);last=max(last or ts,ts)
    model=current_model or 'UNKNOWN';g=groups[(meta.get('agent_path','/root'),model)]
    if current_model is None:missing_model+=1
    g['responses']+=1;g['tiers'].add(current_tier or 'unknown')
    for k in FIELDS:g[k]+=u.get(k,0) or 0
    inp=u.get('input_tokens',0) or 0;cached=u.get('cached_input_tokens',0) or 0;write=u.get('cache_write_input_tokens',0) or 0;out=u.get('output_tokens',0) or 0
    fresh=inp-cached-write
    if fresh<0:g['negative_fresh']+=1;continue
    islong=inp>272000;g['long' if islong else 'short']+=1
    if 270000<=inp<=274000:g['near_threshold']+=1
    if model not in PRICES:g['unknown_rates']+=1;continue
    pi,pc,pw,po=PRICES[model]
    if islong:pi*=2;pc*=2;pw*=2;po*=1.5
    g['usd']+=(fresh*pi+cached*pc+write*pw+out*po)/1_000_000
 for g in groups.values():g['tiers']=sorted(g['tiers']);g['usd']=round(g['usd'],6)
 return {'start':start,'end_exclusive':end,'first_record':first,'last_record':last,'unique_response_count':len(seen),'missing_model_records':missing_model,'groups':[{'lane':k[0],'model':k[1],**v} for k,v in sorted(groups.items())]}

if __name__=='__main__':
 files=discovery();root=os.environ.get('ARCH_FORK_RETRO_SESSION_ID','01a1ab8c-aa6c-7f11-9c61-ee8b145454e1')
 now=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
 examples={
  'arch_fork_chat_before_morning':sumset(descendants(files,'01a1a943-d9d0-7e11-b9c7-2659e9af7287'),'2026-11-05T01:12:38.619Z','2026-11-05T08:06:53.770Z'),
  'overnight':sumset(descendants(files,'01a1a943-d9d0-7e11-b9c7-2659e9af7287'),'2026-11-05T01:43:11.271Z','2026-11-05T08:06:53.770Z'),
  'retro_so_far':sumset(descendants(files,root),'2026-11-05T11:51:25.057Z',now),
  # Six directly evidenced, independently launched antecedent chats; this is
  # intentionally a partial selection, not a claim to price every earlier lane.
  'earlier_six_identified_chats':sumset([(p,d) for p,d in files if d.get('id') in (
    '01a1a897-abe8-76d1-af51-c545c78b9eb9', # earlier coordinator
    '01a1a89f-1ea0-7223-bb28-92aa9e7429d7', # UI
    '01a1a89f-1eae-7001-8587-4d28dd14a483', # native Amend and proof prep
    '01a1a8c1-dbc1-7452-901d-522ba054419e', # Amend review/proof
    '01a1a8ef-7970-7333-88b3-58e196e34805', # Filing integration
    '01a1a8f0-3758-79d2-96cc-a7f7981e22fd', # Create integration
  )],'2026-11-04T22:12:00Z','2026-11-05T00:35:30Z'),
  'original_ui':sumset([(p,d) for p,d in files if d.get('id')=='01a1a89f-1ea0-7223-bb28-92aa9e7429d7'],'2026-11-04T22:16:58.567Z','2026-11-04T23:45:27.075Z'),
  'early_integration':sumset([(p,d) for p,d in files if d.get('id')=='01a1a8f0-3758-79d2-96cc-a7f7981e22fd'],'2026-11-04T23:42:37.523Z','2026-11-05T00:35:16.937Z'),
  'planning_parents':sumset([(p,d) for p,d in files if d.get('id') in ('01a1a8e5-2227-7832-bb3a-7d9f79094087','01a1a943-d9d0-7e11-b9c7-2659e9af7287')],'2026-11-05T00:04:47.729Z','2026-11-05T01:43:11.271Z'),
 }
 print(json.dumps(examples,indent=2))
