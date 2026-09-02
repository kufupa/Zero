from collections import Counter, defaultdict
from pathlib import Path
import json, re

ROOT=Path('/home/ubuntu/projects/zero/.private/connected-mailbox-corpus')
SNAP=ROOT/'connected-mailbox-inbox-2026-08-30.md'
CENSUS=ROOT/'thread-review/full-thread-census-2026-08-30.json'
OUT=ROOT/'follow-up/automation-routing-deep-analysis-2026-08-31.json'
text=SNAP.read_text(errors='replace').replace('\r\n','\n')
blocks=re.split(r'(?m)^---\n',text)
def field(b,k):
 m=re.search(r'(?m)^- \*\*'+re.escape(k)+r':\*\*\s*`?([^`\n]*)',b)
 return m.group(1).strip() if m else ''
rows=[]
for b in blocks:
 if re.search(r'(?m)^## Message \d+: ',b):
  rows.append({'thread':field(b,'Thread ID'),'direction':field(b,'Direction').lower(),'body':b})
assert len(rows)==3820
threads=defaultdict(list)
for r in rows: threads[r['thread']].append(r)
review={x['threadId']:x for x in json.loads(CENSUS.read_text())['threads']}

def has(p,s): return bool(re.search(p,s,re.I|re.S))
auto=r'automated e.?mail|do not reply|no.?reply|not monitored|system[- ]generated|mailer daemon|notification|delivery report|nondelivery|security digest|quarantine digest|confirmation number|reservation confirmation|night audit|reservation system|channel manager|OTA|SynXis'
hard=r'failed|failure|error|declin|unpaid|overdue|refund|chargeback|bounce|undeliver|urgent|same.?day|arrival|check.?in|overbook|inventory|missing|dispute|complaint|security|credential|suspicious|blocked|payment|deposit|wrong recipient|document missing|integration'
request=r'\b(?:please|can you|could you|would you|we need|i need|do you have|is it possible|availability|available|quote|quotation|rate request|book a|make a booking|reserve|change|modify|amend|cancel my|cancel the|how much|what rate|send me|confirm for me)\b'
# ordinary state notices that reservationists generally monitor, not answer
state=r'confirmation|confirmed|reservation|booking|cancel(?:led|lation)?|modif(?:ied|ication)|notification|update|voucher|invoice|receipt|folio|night audit|rooming list'
# email says an action occurred / state changed; not an external request
route=Counter(); by_intent=defaultdict(Counter)
for tid,rs in threads.items():
 body='\n'.join(r['body'] for r in rs)
 intent=review[tid].get('intentClass','unknown')
 isauto=has(auto,body)
 ishard=has(hard,body)
 isrequest=has(request,body)
 isstate=has(state,body)
 outbound=any(r['direction']=='outbound' for r in rs)
 if isauto and ishard:
  c='automated_exception_review'
 elif isauto and isrequest:
  c='automated_external_request_review'
 elif isauto and (isstate or intent in {'booking_new','booking_cancel','booking_modify','document_request','payment_finance','group_event'}):
  c='automated_business_state_notice_low_priority'
 elif isauto:
  c='automated_routine_monitor'
 elif isrequest or intent in {'quote_request','booking_new','group_event','payment_finance','booking_cancel','booking_modify','document_request'}:
  c='human_external_or_business_action'
 else:
  c='ordinary_or_unknown_review'
 route[c]+=1; by_intent[intent][c]+=1
OUT.write_text(json.dumps({'schemaVersion':1,'status':'private_read_only_pattern_inference','corpus':{'messages':len(rows),'threads':len(threads),'inbound':sum(r['direction']=='inbound' for r in rows),'outbound':sum(r['direction']=='outbound' for r in rows)},'routing':dict(route),'byIntent':{k:dict(v) for k,v in sorted(by_intent.items())},'rules':{'automated_business_state_notice_low_priority':'automated/system/recurrent state notification without hard exception or external request; lower urgency for reservationist, retain visible','automated_exception_review':'automated pattern plus payment/failure/cancellation-policy/deadline/security/document/integration/arrival/inventory risk','automated_external_request_review':'automated-looking but contains explicit request/availability/rate/change/response obligation'},'limitations':['Lexical rules intentionally broad; quoted text and boilerplate can overinclude','Counts are routing estimates, not manual labels','Cancellation is low priority only when it is a clean state notice; cancellation policy/refund/payment/deadline/failure overrides'], 'source':SNAP.name},indent=2)+'\n')
print(json.dumps({'routing':dict(route),'byIntent':{k:dict(v) for k,v in sorted(by_intent.items())}}))
