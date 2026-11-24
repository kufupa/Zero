import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path.home()/".local/share/zero/runs/overnight-20261122/data/scripts"))
from truth import *
import shutil
CAT=read(WORLD/'catalog.json')
DIRS={k:{str(r['code']):r for r in v.get('records',[]) if r.get('code')} for k,v in CAT['catalogs'].items()}
CORE={'first_name','last_name','arrival_date','departure_date','adults','child_count','reservation_id','confirmation_number','attachment_id','quantity'}
PATH=re.compile(r'^/(?:bookings/\d{1,3}/fields/(?:first_name|last_name|arrival_date|departure_date|adults|child_count|room_type|board|rate_plan|billing_reference|agency_name|organization_name|guarantee_type)|actions/\d{1,3}/(?:type|details/(?:attachment_id|cancellation_reason|groups/\d{1,3}/(?:arrival_date|departure_date|rooms/\d{1,3}/(?:quantity|adults|child_count|room_type|board)))))$')
FIELDS={'firstname':'first_name','lastname':'last_name','arrivaldate':'arrival_date','departuredate':'departure_date','adults':'adults','children':'child_count','roomtype':'room_type','mealplan':'board','rateplan':'rate_plan','company':'organization_name','ta1':'agency_name','guarantee':'guarantee_type','billingreference':'billing_reference'}
LETTER={'arrival':'arrival_date','departure':'departure_date','room_type_text':'room_type','adults':'adults','children':'child_count','meal_plan':'board','company':'organization_name','agency':'agency_name','rate_plan_code':'rate_plan','rate_plan_text':'rate_plan'}
ALIASES={'room_type':'roomTypes','rate_plan':'ratePlans','guarantee_type':'guaranteeTypes','agency_name':'agencies','organization_name':'organizations'}
def commercial(k,v):
    cat=DIRS.get(ALIASES.get(k),{}); token=str(v).strip()
    if k=='room_type':
        token=next((code for code,r in cat.items() if token.upper()==code or name(r['meaning'])==name(v)),'')
        return dict(code=token,meaning=cat[token]['meaning']) if token else None
    if k=='rate_plan' and token in cat: return dict(code=token,meaning=cat[token].get('meaning'))
    if k in ('agency_name','organization_name'):
        matches=[r for r in cat.values() if name(r.get('meaning'))==name(v) or str(r['code'])==token]
        if len(matches)==1: return dict(name=matches[0]['meaning'],code=matches[0]['code'])
        return dict(name=v)
    return v
def board(x):
    s=norm(x)
    if 'dinner' in s and 'breakfast' in s or s in ('db','dbb','d b b'): return 'DBB'
    if 'breakfast' in s or s in ('bb','b&b','b b','b'): return 'BB'
    if 'room only' in s or s in ('ro','r/o','r'): return 'RO'
    return ''
def val(k,v):
    if v is None or str(v).strip() in ('','null','undefined'): return None
    if k.endswith('_date'): return iso(v) or None
    if k in ('adults','child_count','quantity'): return int(v) if str(v).isdigit() else None
    if k=='board': return board(v) or None
    return v
def quote_of(ev,s,q):
    return q if isinstance(q,str) and norm(q) and any(norm(q) in norm(txt) for txt in ev.get(s,[])) else ''
def text_evidence(m,older):
    ev={}
    for e,s in [(m,'selected'),*((o,'earlier:'+o['message_id']) for o in older)]:
        ev[s]=[e['subject'],e['body_text']]
        for p in e['pdf_attachments_text']:
            ev['pdf:'+p['id']]=[p['filename'],p.get('text','')]
    return ev
def field(path,value,source,evidence=None,detail=None):
    tier='P0' if path.rsplit('/',1)[-1] in CORE else 'P2' if path.endswith(('guarantee_type','board')) else 'P1'
    return dict(path=path,value=value,expectation='expected',source='hms_truth' if source.startswith('hms') else 'email_explicit' if source=='luna_evidence' else 'heuristic',basis=source,tier=tier,priority=tier,knowable=bool(evidence),**(evidence or {}),**(detail or {}))
def room_evidence(v,q):
    q=re.sub(r'\b(?:(?:twin|double|single) (?:share|sharing|occupancy|use)|suite (?:no |number )?\d+)\b','',name(q)); terms=set(name(v).split())&set(q.split())
    code=(commercial('room_type',v) or {}).get('code','')
    if code.lower() in q.split(): return code
    family=next((w for w in ('standard','deluxe','executive','luxury','suite') if w in terms),'')
    bed=next((w for w in ('king','queen','twin') if w in terms and (family or w!='twin' or 'twin bed' in q or 'twin room' in q)),'')
    return ' '.join(filter(None,(family,bed)))
def explicit(l,ev,m):
    entries={}
    for row in l.get('fields') or []:
        if not isinstance(row,dict) or not PATH.fullmatch(str(row.get('path') or '')): continue
        path=row['path']; k=path.rsplit('/',1)[-1]; v=val(k,row.get('value')); s=row.get('source'); q=quote_of(ev,s,row.get('quote')) if isinstance(s,str) else ''
        if not q or v is None or isinstance(v,(list,dict)): continue
        if k=='room_type' and not (v:=room_evidence(v,q)): continue
        if k=='attachment_id' and v not in attachments(m): continue
        if k=='type' and v not in ('voucher_submission','payment_proof_submission'): continue
        entries[path]=field(path,v,'luna_evidence',dict(evidence_source=s,evidence_quote=q))
    return entries
def compatible(k,truth,request):
    if request is None: return False
    values=[truth]
    if isinstance(truth,dict): values=list(truth.values())
    if k=='guarantee_type': values.append((DIRS['guaranteeTypes'].get(str(truth)) or {}).get('meaning'))
    r=name(request)
    if r and r in {name(v) for v in values if v is not None}: return True
    if k in ('agency_name','organization_name'):
        clean=lambda s:' '.join(x for x in name(s).split() if x not in {'pty','ltd','limited','proprietary'})
        return any(clean(v)==clean(request) for v in values if clean(v))
    if k=='room_type':
        rt=norm(' '.join(str(v) for v in values)); rq=norm(request)
        if rq in ('king','queen','twin'): return rq in rt.split()
        for family in ('deluxe','standard','executive','luxury','suite'):
            if family in rt and family in rq:
                beds={'king','queen','twin','double'}; expected=set(rt.split())&beds; asked=set(rq.split())&beds
                return not expected or not asked or expected==asked
    return False
def outcome(entries,path,k,v,source,detail):
    v=val(k,v)
    if v is None or (v:=commercial(k,v)) is None: return
    old=entries.get(path)
    ev={x:old[x] for x in ('evidence_source','evidence_quote')} if old and compatible(k,v,old['value']) else None
    if isinstance(v,dict) and old:
        v=dict(v,requested=old['value'])
        if k=='room_type' and ev:
            v['alt_codes']=[c for c,r in DIRS['roomTypes'].items() if c!=v.get('code') and compatible(k,r['meaning'],old['value'])]
    entries[path]=field(path,v,source,ev,detail)
def letter_matches(b,r):
    names=set(name(r.get('guest_name')).split())
    guest={name(b.get(k)) for k in ('first_name','last_name') if b.get(k)}
    ar,dep=(iso(b.get(k)) for k in ('arrival_date','departure_date'))
    return bool(guest and all(set(n.split())<=names for n in guest) and (not ar or iso(r.get('arrival'))==ar)
                and (not dep or iso(r.get('departure'))==dep))
def create(tr,entries,l,at,related):
    slots=max([int(p.split('/')[2])+1 for p in entries if p.startswith('/bookings/')]+[0])
    bookings=[b if isinstance(b,dict) else {} for b in l.get('bookings') or []]
    matches={}
    for i in range(max(slots,len(bookings))):
        b=bookings[i] if i<len(bookings) else {}
        b={**b,**{k:v['value'] for p,v in entries.items() if p.startswith(f'/bookings/{i}/fields/') and (k:=p.rsplit('/',1)[-1]) in CORE}}
        nearby={c for c in related if c in tr.letters and at <= tr.letters[c][0]['sent_at'] and tr.letters[c][0]['sent_at'][:10]<=dtadd(at,10)}
        matches_= {c for c in nearby if letter_matches(b,tr.letters[c][0])}
        sk=name(b.get('last_name')),iso(b.get('arrival_date'))
        if not matches_ and all(sk):
            for c in tr.surname[sk]:
                if c not in tr.letters: continue
                r=tr.letters[c][0]
                if at<=r['sent_at'] and r['sent_at'][:10]<=dtadd(at,3) and letter_matches(b,r): matches_.add(c)
        if not matches_ and all(sk):
            matches_={c for c in tr.surname[sk] if c in tr.created and at<=tr.created[c] and tr.created[c][:10]<=dtadd(at,3)
                      and name(tr.hms(c).get('lastname'))==sk[0] and iso(tr.hms(c).get('arrivaldate'))==sk[1]
                      and (not b.get('first_name') or name(tr.hms(c).get('firstname')).startswith(name(b['first_name'])))
                      and (not b.get('departure_date') or iso(tr.hms(c).get('departuredate'))==iso(b['departure_date']))}
        if not matches_ and len(nearby)==1 and len(bookings)<=1 and not any(b.values()): matches_=nearby
        if len(matches_)==1: matches[i]=next(iter(matches_))
    duplicates={c for c,n in Counter(matches.values()).items() if n>1}
    applied={}
    for i,c in matches.items():
        if c in duplicates: continue
        applied[i]=c
        h=tr.hms(c); letter=tr.letters[c][0] if tr.letters.get(c) else {}
        from_letter={v:letter.get(k) for k,v in LETTER.items() if letter.get(k) is not None}
        from_hms={v:h[k] for k,v in FIELDS.items() if k in h}
        changed={LETTER[k] for d in tr.diffs[c] for k in d['changes'] if k in LETTER}
        if any('guest_name' in d['changes'] for d in tr.diffs[c]): changed|={'first_name','last_name'}
        if words:=str(letter.get('guest_name') or '').split():
            if len(words)>1: from_letter.update(first_name=' '.join(words[:-1]),last_name=words[-1])
        for k in from_letter.keys()|from_hms.keys():
            value=from_hms.get(k)
            if value is not None and (k not in changed or k not in from_letter):
                outcome(entries,f'/bookings/{i}/fields/{k}',k,value,'hms_truth',dict(confirmation=c,captured_at=tr.anchors[c]['captured_at']))
            elif k in from_letter:
                outcome(entries,f'/bookings/{i}/fields/{k}',k,from_letter[k],'letter_snapshot',dict(confirmation=c,captured_at=letter['sent_at']))
    return applied, max(slots,len(bookings))
def voucher_identity(tr,p,t,hit):
    pdf=p['filename']+'\n'+p.get('text',''); norm_pdf=' '+name(pdf)+' '; sur=name(t.get('surname'))
    ids={c for x in confs(pdf,tr.known_compact,True) for c in tr.candidates(conf(x)) if tr.hms(c) or c in hit}
    def printed_date(value):
        day=datetime.fromisoformat(d) if (d:=iso(value)) else None
        return day is not None and any(' '+name(x)+' ' in norm_pdf for fmt in ('%Y-%m-%d','%d/%m/%Y','%d/%m/%y','%d-%b','%d%B','%d %B') for f in (day.strftime(fmt),) for x in (f,f.lstrip('0')))
    matched=hit if sur and ' '+sur+' ' in norm_pdf and all(printed_date(t.get(k)) for k in ('arrival_date','departure_date')) else set()
    return (ids&matched or ids) if ids else matched
def existing(tr,entries,l,m,ev,visible,own,related):
    route=l['route']; at=m['received_at']; targets={}; status={}; unresolved=0; attached=attachments(m)
    supplied=[t for t in l.get('targets') or [] if isinstance(t,dict)] or [{}]
    for i,t in enumerate(supplied):
        rawconf=conf(t.get('confirmation')); path=f'/bookings/{i}/fields/confirmation_number' if route=='filing' else f'/bookings/{i}/reservation_id'
        entries[path]=field(path,None,'target_unverified')
        document=next((f['value'] for p,f in entries.items() if p==f'/actions/{i}/details/attachment_id'),None)
        if route=='filing' and not document and len(attached)==1: document=next(iter(attached))
        q=next(({'evidence_quote':t['quote'],'evidence_source':s} for s in ev if quote_of(ev,s,t.get('quote'))),None)
        printed=rawconf and q and bool(re.search(r'(?<!\d)'+rawconf.replace('-',r'[\s–-]?')+r'(?!\d)',q['evidence_quote']))
        direct=(tr.candidates(rawconf) if printed else tr.candidates(rawconf)&visible) if rawconf else set()
        hit,basis=tr.name_lookup(t)
        context=set(own) if len(own)==1 else set(visible) if len(visible)==1 else set()
        pool=((direct|hit if route=='filing' else direct&hit or {x for x in direct if tr.hms(x) or x in tr.letters} or hit or direct) if direct else hit or context)
        if route=='filing':
            if not document: unresolved+=1; continue
            p=attached.get(document,{})
            token=docname(p.get('filename')); plausible=pool|visible|(related if len(related)<=3 else set()); probed=bool(plausible&tr.document_attempts); entries[path]['documents_attempted']=probed
            docs={c for c in plausible if c in tr.docs and any(docname(d.get('name'))==token
                  for d in tr.docs[c][1].get('documents',[]) if token)}
            voucher=l.get('doc_kind')=='voucher' or (entries.get(f'/actions/{i}/type') or {}).get('value')=='voucher_submission'
            pool=docs or (voucher_identity(tr,p,t,hit) if voucher and p else set())
            if len(pool)!=1: unresolved+=1; continue
            basis='hms_documents' if docs else 'hms_voucher_match'
            if not q and p: q=dict(evidence_source='pdf:'+document,evidence_quote=p['filename'])
        if len(pool)!=1: unresolved+=1; continue
        c=next(iter(pool))
        if route!='filing' and not (tr.hms(c) or c in tr.letters or c in hit and basis=='hms_search'):
            unresolved+=1; continue
        if not q and c in visible:
            for s,texts in ev.items():
                found=next((tkn for text in texts for tkn in (c,c.replace('-',' '),c.replace('-',''),c.split('-')[0]) if tkn in text),None)
                if found: q=dict(evidence_source=s,evidence_quote=found); break
        if not q or (route!='filing' and not direct and c not in hit and c not in visible):
            unresolved+=1; continue
        targets[i]=c
        detail=dict(captured_at=tr.docs[c][0] if c in tr.docs else tr.anchors.get(c,{}).get('captured_at') or tr.search.get(searchkey(t),{}).get('read_at'),attachment_id=document,documents_attempted=probed or c in tr.document_attempts,documents_check='matched' if docs else 'not_seen' if c in tr.docs else 'unobserved') if route=='filing' else dict(captured_at=(tr.search.get(searchkey(t),{}).get('read_at') if c in hit and basis=='hms_search' else None) or tr.anchors.get(c,{}).get('captured_at') or (tr.letters.get(c) or [{}])[0].get('sent_at'))
        detail['unobserved_in_twin']=not any(x['captured_at']<=at for x in tr.anchors.get(c,{}).get('captures',[])) and not any(p['sent_at']<at for p in tr.versions.get(c,[]))
        entries[path]=field(path,c,basis if route=='filing' or c in hit else 'hms_confirmation' if tr.hms(c) else 'letter_confirmation',q,detail)
        if c in tr.status: status[c]=dict(captured_at=tr.status[c][0],status=tr.status[c][1])
        elif h:=tr.hms(c): status[c]=dict(captured_at=tr.anchors[c]['captured_at'],status=h.get('status'))
        if route=='amend':
            ds=[d for d in tr.diffs[c] if at<=d['after_sent_at'] and d['after_sent_at'][:10]<=dtadd(at,7)]
            d=ds[0] if ds else {}
            change={LETTER[k]:v['after'] for k,v in d.get('changes',{}).items() if k in LETTER}
            h=tr.hms(c)
            for p in [p for p in entries if p.startswith(f'/bookings/{i}/fields/')]:
                k=p.rsplit('/',1)[-1]
                hk=next((s for s,v in FIELDS.items() if v==k),'')
                current_hms=(h.get(hk) if tr.anchors.get(c,{}).get('captured_at','')>=at else None)
                if current_hms is not None and compatible(k,commercial(k,val(k,current_hms)),entries[p]['value']):
                    outcome(entries,p,k,current_hms,'hms_truth',dict(captured_at=tr.anchors[c]['captured_at']))
                elif k in change: outcome(entries,p,k,change[k],'letter_amend_delta',dict(captured_at=d['after_sent_at']))
    return targets,unresolved,status
def build(tr,m,all_older,visible,own,related,l):
    at=m['received_at']; id=cid(m); route=l['route']; old=[o for o in all_older if o['received_at']<at][-6:]
    ev=text_evidence(m,old); entries=explicit(l,ev,m)
    targets={}; native={}; statuses={}; n=0
    disp=l.get('disposition'); disp=disp if disp in ('propose','skip','staff_review') else 'staff_review'
    if route=='create':
        native,n=create(tr,entries,l,at,related)
    elif route in ('amend','cancel','filing'):
        targets,unresolved,statuses=existing(tr,entries,l,m,ev,visible,own,related)
        n=max(1,len(targets)+unresolved)
        disp=(l.get('intent') or {}).get('disposition') or 'propose'
    for path,f in list(entries.items()):
        if path.endswith('/room_type') and f['basis']=='luna_evidence':
            if route!='create' and (room:=commercial('room_type',f['value'])): f['value']=room
            else: entries.pop(path)
    if disp!='propose': n=0
    target_ids=list(targets.values())
    pvs=sorted((p for c in target_ids for p in tr.versions.get(c,[]) if p['sent_at']<=at),key=lambda p:p['sent_at'])
    hms={'exists':False,'confirmation':None,'basis':'unknown_before_as_of','stay':None,'documents':[]}; c=target_ids[0] if len(target_ids)==1 else None
    prior=[x for x in tr.anchors.get(c,{}).get('captures',[]) if x['captured_at']<=at]
    if prior:
        cp=prior[-1]; hms.update(exists=True,confirmation=c,basis='pre_as_of_hms_capture',captured_at=cp['captured_at'],stay=cp['hms_fields'])
    elif c and pvs:
        hms.update(exists=True,confirmation=c,basis='last_pre_as_of_pdf',basis_pdf_sent_at=pvs[-1]['sent_at'],
                   basis_pdf_sha256=pvs[-1]['sha256'],stay=pvs[-1]['pdf_fields'])
    quote=next((q for q in ((l.get('intent') or {}).get('evidence_quote'),l.get('evidence_quote')) for s in ev if quote_of(ev,s,q)),'')
    card=dict(case_id=id,as_of=at,property_code='HRCEN',source=dict(input_cutoff=at,property_code='HRCEN',property_provenance='centurion_mail_union'),
              selected_email=m,context_before=old,cross_thread_context=[],pdf_versions=pvs,workflow=route,real_confirmation=hms['confirmation'],hms_shown=hms)
    row=dict(workflow=route,skip=disp=='skip',gold=[entries[k] for k in sorted(entries)],expected_action_count=n,
             **({'expected_targets':target_ids} if target_ids else {}),expected_disposition=disp,evidence_quote=quote,doc_kind=l.get('doc_kind'),
             staff_outcome_only=dict(create_confirmations=native,current_status=statuses),source_label='azure:gpt-6-luna:high',slice='test' if at>=AFTER else 'dev')
    return card,row,set(target_ids)|set(native.values())
def dedup(m,l,cs):
    subj=name(CHAIN.sub('',m['subject']))
    body=m['body_text'] if re.match(r'(?i)^fwd?:',m['subject']) else current(m['body_text'])
    head=re.split(r'(?im)^\s*(?:kind regards|best regards|sent from|regards)[,. !]*$',body,maxsplit=1)[0]
    docs=sorted(p.get('sha256') or name(p['filename']) for p in m['pdf_attachments_text'])
    match=(m.get('from_address'),subj,name(head),docs,sorted(cs))
    return 'decision:'+sha(raw(match)) if subj and (len(name(head))>=16 or cs or docs) else 'decision:'+m['decision_hash']
def report(out,stats,field_stats,tf,h):
    cost=0.0
    for u in chain.from_iterable(read(p).get('usage',[]) for folder in ('labels','intent-labels') for p in (DATA/folder).glob('*.json')):
        cached=(u.get('input_tokens_details') or {}).get('cached_tokens',0)
        cost+=(.10*(u.get('input_tokens',0)-cached)+.01*cached+.50*u.get('output_tokens',0))/1e6
    prod_current=sum(1 for _ in optional(DATA/'prod-current.jsonl')); selected=sum(tf[f'selected:{s}'] for s in ('dev','test'))
    counts=read(DATA/'mail-funnel.json')|dict(tf)
    note=f"""# Gold v6
July 27–October 31 dev; November 1–22 test, UTC. Where a connected component crosses November 1, November decisions stay in test and earlier decisions are omitted from dev. Case input contains only mail and attachment evidence visible at the selected receipt time. Gold uses staff HMS captures and letters where attributable; Luna high covers unobserved decisions. Create room gold uses staff HMS or letter catalogue codes; occupancy alone is never room evidence. Staff-outcome-only rows are not prompt inputs. Amend, cancel and filing disposition records the requested action independently from whether HMS verified a target. Unverified target rows are unscored; cases with no verified target omit the target set.\n
| Funnel | n |
|---|---:|
"""
    for k,v in sorted(counts.items()): note+=f'| {k} | {v} |\n'
    note+=f'\nProduction late export: {prod_current} rows before source dedupe. Selected benchmark decisions: {selected}. Luna high estimated usage cost: ${cost:.2f}.\n\n'
    note+='Prior v2 overlap counts identify previously benchmarked raw emails. This v6 seal is unevaluated; it does not imply all underlying emails are new.\n\nFor the updated twin, set `NAVA_BENCH_LETTERS=$RUN/data/v6/replay/<split>/evidence/letters.jsonl` for each run. Its default global letters file can restore stays assigned to the other split. Set `NAVA_BENCH_THREAD_MAIL=$RUN/data/v6/replay/<split>/evidence/thread-mail.jsonl` for split-scoped sender history. The bench CLI flags are unchanged.\n\n'
    note+='| Split | Workflow | Cases | Propose | Staff review | Skip | Staff-created bookings | Verified targets | Filing cases with Documents attempted | PDF matches | Voucher identity matches |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n'
    for s in ('dev','test'):
        for route in ('triage','quote','create','amend','cancel','filing'):
            x=stats[s,route]
            note+=f"| {s} | {route} | {x['cases']} | {x['propose']} | {x['staff_review']} | {x['skip']} | {x['created']} | {x['targets']} | {x['documents_cases']} | {x['documents_targets']} | {x['voucher_targets']} |\n"
    note+='\n| Split | Workflow | Field | Cases | Gold values | Knowable values | HMS values | PDF values |\n|---|---|---|---:|---:|---:|---:|---:|\n'
    for (s,r,p),x in sorted(field_stats.items()):
        note+=f"| {s} | {r} | `{p}` | {stats[s,r]['cases']} | {x['gold']} | {x['knowable']} | {x['hms']} | {x['letter']} |\n"
    exact=[r for r in h.reads if r.get('purpose')=='record']; searches=[s for r in h.reads for s in (r.get('searches') or [r.get('search') or {}]) if s.get('outcome')=='ok']; docs=[r for r in h.reads if r.get('purpose')=='documents' or r.get('documents') is not None or any(e.get('view')=='documents' for e in r.get('errors',[]))]; remaining=Counter(len(r['confirmation'].split('-')[0]) for r in h.jobs('initial'))
    note+=f"\nHMS truth: {sum(bool(h.hms(c)) for c in h.anchors)} reservations with HMS record captures. {sum(bool(h.hms(c)) for c in h.letters)}/{len(h.letters)} original letter confirmations have an HMS record capture. Live reads: {sum(bool(fields(r)) for r in exact)}/{len(exact)} exact jobs returned record details; {len(searches)} successful surname/date queries; {sum(r.get('documents') is not None for r in docs)}/{len(docs)} Documents jobs returned trees ({sum(bool(tree.get('documents')) for _,tree in h.docs.values())} distinct stays with a nonempty tree).\n"
    note+=f"\nRemaining untouched raw confirmation candidates by base length: {dict(sorted(remaining.items()))}. The HMS queue exceeded the timebox; unresolved or unattempted references are not counted as confirmed. Two kept dev messages could not be labelled (Azure content filter); all November messages were labelled.\n"
    why={'create':'Most unmatched requests had no linked original confirmation letter or uniquely attributable HMS stay.', 'amend':'Some requests lacked a unique stay or a corroborated change; decision-time request fields remain where evidenced.', 'cancel':'Some requests lacked a unique stay. Disposition records the email’s intent.', 'filing':'Targets distinguish a matching PDF in HMS Documents from a voucher matched to the HMS stay. An unobserved Documents tree does not prove the PDF was unfiled.'}
    for r in why:
        x=stats['test',r]; quantity=f"{x['created']} staff-created bookings" if r=='create' else f"{x['targets']} verified stay targets"; note+=f"- Test {r}: {x['cases']} decisions; {quantity}. {why[r]}\n"
    (out/'STATS.md').write_text(note)
def main(preview=False):
    out=DATA/('v6-preview' if preview else 'v6')
    if (out/'test-seal.json').exists(): print('v6 already sealed:',out); return
    tr=Truth(); graph=Components(); items=[]; meta=Counter(); owner={}; recipients=defaultdict(list)
    for v in chain.from_iterable(tr.versions.values()):
        for k in ('source_message_id','internet_message_id'):
            if v.get(k): recipients[mid(v[k])].append(v)
    for th in lines(DATA/'threads.jsonl'):
        messages=th['messages']; tid=th['thread_id']
        refs=[tr.related(m,r) for m,r in zip(messages,th['confirmations'])]
        related=set(chain.from_iterable(refs))
        for m in messages:
            if m['direction']=='outbound':
                related|=tr.by_tid[m['thread_id']]
                for k in set(m['source_aliases'])|{m.get('internet_message_id')}:
                    for v in recipients[mid(k)]: v['recipient_fields']={x:m['addresses'][x] for x in ('to','cc')}
        graph.join([tid,*('c:'+c for c in related if c in tr.anchors or c in tr.letters)])
        old=[]; seen=set()
        for m,own in zip(messages,refs):
            if m['direction']=='inbound':
                id=cid(m); l=read_label(id); at=m['received_at']; route=l.get('route')
                if not route: meta['unlabelled']+=1
                elif route=='skip': meta['labelled_skip']+=1
                else:
                    visible=(seen|own)
                    card,row,cs=build(tr,m,old,visible,own,related,l)
                    decision=dedup(m,l,cs)
                    graph.join([tid,decision,*('c:'+c for c in cs)])
                    items.append((tid,decision,card,row,cs)); meta['labelled_action_or_triage']+=1
            old.append(m); seen|=own
    for tid,_,card,_,_ in items:
        c=graph.root(tid); split='test' if card['as_of']>=AFTER else 'dev'
        if c not in owner or split=='test': owner[c]=split
    temp=out.with_suffix('.build')
    if temp.exists(): shutil.rmtree(temp)
    prior_ids={mid((read(p).get('selected_email') or {}).get('internet_message_id')) for p in (LEGACY/'splits-v2').glob('*/*/case.json')}
    prior_ids.discard(''); stats=defaultdict(Counter); field_stats=defaultdict(Counter); gold={'dev':{},'test':{}}; seen=set(); created=set()
    for tid,decision,card,row,cs in sorted(items,key=lambda x:(x[2]['as_of'],x[2]['case_id'])):
        s=row['slice']; component=graph.root(tid); route=row['workflow']; at=card['as_of']; id=card['case_id']
        if owner[component]!=s: meta['dev_omitted_cross_component']+=1; continue
        if (s,decision) in seen: meta['near_or_exact_duplicate']+=1; continue
        if route=='create':
            native=row['staff_outcome_only']['create_confirmations']
            if native and set(native.values())<=created: meta['duplicate_staff_create']+=1; continue
            for i,c in list(native.items()):
                if c in created: native.pop(i)
            created.update(native.values())
        seen.add((s,decision)); row['component_id']='component-'+sha(component)[:18]
        dump(temp/s/id/'case.json',card); gold[s][id]=row
        if mid(card['selected_email'].get('internet_message_id')) in prior_ids: meta['prior_v2_replay_overlap:'+s]+=1
        n=stats[s,route]; n['cases']+=1; n[row['expected_disposition']]+=1
        n.update(created=len(row['staff_outcome_only']['create_confirmations']),targets=len(row.get('expected_targets',[])),documents_cases=int(any(f.get('documents_attempted') for f in row['gold'])),documents_targets=sum(f['basis']=='hms_documents' for f in row['gold']),voucher_targets=sum(f['basis']=='hms_voucher_match' for f in row['gold']))
        for f in row['gold']:
            p=re.sub(r'(?<=/)\d{1,3}(?=/|$)','*',f['path']); x=field_stats[s,route,p]
            x['gold']+=1; x['knowable']+=f['knowable']; x['hms']+=f['basis'].startswith('hms'); x['letter']+=f['basis'].startswith('letter')
    for s,rows in gold.items():
        meta['selected:'+s]=len(rows); dump(temp/s/'gold.json',rows); world=temp/'replay'/s/'world'
        forbidden={c for c in tr.anchors.keys()|tr.versions.keys() if owner.get(graph.root('c:'+c),s)!=s}
        anchors=[]; blocked={name(tr.hms(c).get('guestfullname')) for c in forbidden}; blocked.discard('')
        for c in sorted((tr.anchors.keys()|tr.versions.keys())-forbidden):
            a=tr.anchors.get(c,dict(confirmation=c,property_code='HRCEN',hms_fields={},captures=[])); pvs=tr.versions.get(c)
            if pvs: a={**a,'pdfs':pvs}
            anchors.append(a)
        dump_lines(world/'anchors.jsonl',anchors); dump(world/'catalog.json',CAT); evidence=world.parent/'evidence'; allowed={a['confirmation'] for a in anchors}
        dump_lines(evidence/'letters.jsonl',(r for r in optional(DATA/'letters.jsonl') if conf(r.get('confirmation_no') or r.get('filename_confirmation_no')) in allowed))
        dump_lines(evidence/'threads.jsonl',(dict(confirmations=t['confirmations'],messages=[{k:m[k] for k in ('received_at','subject','body_text')} for m in t['messages']]) for t in lines(DATA/'threads.jsonl') if owner.get(graph.root(t['thread_id']),s)==s))
        dump_lines(evidence/'thread-mail.jsonl',({k:m[k] for k in ('direction','thread_id','from_address','received_at')} for t in lines(DATA/'threads.jsonl') if owner.get(graph.root(t['thread_id']),s)==s for m in t['messages'] if m['direction']=='inbound'))
        profiles=read(WORLD/'profiles.json')
        profiles['profiles']=[p for p in profiles['profiles'] if not blocked.intersection({
            name(str(p.get(a) or '')+' '+str(p.get(b) or '')) for a,b in [('firstName','lastName'),('lastName','firstName')]})]
        dump(world/'profiles.json',profiles)
    report(temp,stats,field_stats,meta,tr)
    if not preview:
        paths=[*(temp/'test').rglob('*.json'),*(temp/'replay/test').rglob('*.json*')]
        digests={p.relative_to(temp).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}
        dump(temp/'test-seal.json',dict(algorithm='sha256',files=digests,sha256=sha(raw(digests)),cases=len(gold['test']),evaluated_cases=0,world_input_sha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (DATA/'threads.jsonl',DATA/'letters.jsonl') if p.is_file()}))
    if out.exists(): shutil.rmtree(out)
    temp.rename(out)
    print(out,dict(meta),flush=True)
if False: main('--preview' in sys.argv)

# --- v7 action-time transformer -------------------------------------------------
# The code above is the frozen v6 builder, copied unchanged except for making its
# imports resolve.  The functions below are the v7 lane: they re-adjudicate the
# immutable v6 rows against dated letters, HMS captures and amendment chains.

from copy import deepcopy
import argparse
import hashlib
import os

ZERO=Path.home()/'.local/share/zero'
RUN22=ZERO/'runs/overnight-20261122/data'
RUN23=ZERO/'runs/overnight-20261123'
SHIP_OUT=ZERO/'runs/ship-20261124/gold/out'
SPLITS=(('train',RUN23/'cases-train'),('val',RUN23/'cases-val'),('locked-test',RUN23/'cases-test'))
OTA_DOMAINS=DOMAINS

def jload(p): return json.loads(Path(p).read_text())
def jdump(p,x):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(x,sort_keys=True,separators=(',',':'))+'\n')

def leaf(path): return str(path).rsplit('/',1)[-1]
def booking_index(path):
    m=re.match(r'^/bookings/(\d+)/',str(path))
    return int(m[1]) if m else None

def normpath(path): return re.sub(r'(?<=/)\d+(?=/|$)','*',str(path))
def stable_value(v): return json.dumps(v,sort_keys=True,separators=(',',':')) if isinstance(v,(dict,list)) else str(v)

def unknown_field(f,basis='action_time_unknown',detail=None):
    x={k:f.get(k) for k in ('path','tier','priority','source','knowable','confirmation') if k in f}
    x.update(expectation='no_gold',value=None,basis=basis)
    if detail: x.update(detail)
    return x

def first_action_letter(tr,c,at):
    rows=tr.letters.get(c,[])
    after=[r for r in rows if r.get('sent_at','')>=at]
    return after[0] if after else (rows[0] if rows else {})

def changed_keys(tr,c,at):
    out=defaultdict(list)
    for d in sorted(tr.diffs.get(c,[]),key=lambda x:x.get('after_sent_at','')):
        if d.get('after_sent_at','')<at: continue
        keys=set()
        for src in d.get('changes',{}):
            if src=='guest_name': keys.update(('first_name','last_name'))
            elif src in LETTER: keys.add(LETTER[src])
        for k in keys: out[k].append(d)
    return out

def letter_field_value(letter,k):
    if not letter: return None
    if k in ('first_name','last_name'):
        words=str(letter.get('guest_name') or '').split()
        if len(words)<2: return None
        return ' '.join(words[:-1]) if k=='first_name' else words[-1]
    src=next((src for src,dst in LETTER.items() if dst==k),None)
    return letter.get(src) if src else None

def hms_field_value(h,k):
    hk=next((src for src,dst in FIELDS.items() if dst==k),None)
    return h.get(hk) if hk else None

def canonical_outcome_value(k,v):
    v=val(k,v)
    if v is None: return None
    return commercial(k,v)

def create_action_value(tr,c,k,at):
    """Return (value,basis,captured_at) for staff state attributable to create time."""
    letter=first_action_letter(tr,c,at)
    lv=canonical_outcome_value(k,letter_field_value(letter,k))
    if lv is not None:
        return lv,'letter_action_time',letter.get('sent_at')
    changes=changed_keys(tr,c,at).get(k,[])
    if changes:
        return None,'action_time_unknown',changes[0].get('after_sent_at')
    for cap in sorted(tr.anchors.get(c,{}).get('captures',[]),key=lambda x:x.get('captured_at','')):
        if cap.get('captured_at','')<at: continue
        hv=canonical_outcome_value(k,hms_field_value(cap.get('hms_fields') or {},k))
        if hv is not None:
            return hv,'hms_post_action_stable',cap.get('captured_at')
    # Anchors sometimes have only the rolled-up final capture, never use it when a
    # modification chain exists; otherwise it is the same stable post-action state.
    h=tr.hms(c)
    hv=canonical_outcome_value(k,hms_field_value(h,k))
    if hv is not None and not changes:
        return hv,'hms_post_action_stable',tr.anchors.get(c,{}).get('captured_at')
    return None,'action_time_unknown',None

def correct_create(row,card,tr):
    at=card.get('as_of') or ''
    confs=(row.get('staff_outcome_only') or {}).get('create_confirmations') or {}
    out=[]
    for f in row.get('gold') or []:
        f=deepcopy(f); p=f.get('path',''); k=leaf(p); bi=booking_index(p)
        basis=str(f.get('basis') or '')
        c=confs.get(str(bi)) if bi is not None else None
        if c and (basis.startswith('hms') or basis.startswith('letter')):
            v,nb,cap=create_action_value(tr,c,k,at)
            if v is None:
                f=unknown_field(f,nb,dict(confirmation=c,captured_at=cap) if cap else dict(confirmation=c))
            else:
                f.update(value=v,expectation='expected',basis=nb,captured_at=cap,confirmation=c)
                f['source']='hms_truth' if nb.startswith('hms') else 'email_explicit' if nb=='luna_evidence' else 'heuristic'
        out.append(f)
    row['gold']=out
    return row

def target_value(row):
    for f in row.get('gold') or []:
        if str(f.get('path','')).endswith('/reservation_id') and f.get('value'):
            return str(f['value'])
    return ''

def amend_attribution(rows,tr):
    reqs=defaultdict(list)
    for split,cid,row,card in rows:
        if row.get('workflow')!='amend': continue
        c=target_value(row)
        at=card.get('as_of') or ''
        if c and at: reqs[c].append((at,cid))
    owners={}
    for c,ds in tr.diffs.items():
        for d in ds:
            end=d.get('after_sent_at','')
            prior=[(at,cid) for at,cid in reqs.get(c,[]) if at<=end]
            if prior:
                at,cid=max(prior)
                owners[(c,end)]=cid
    return owners

def explicit_label_values(cid):
    try: l=read_label(cid)
    except Exception: return {}
    return {r.get('path'):r.get('value') for r in l.get('fields') or [] if isinstance(r,dict) and r.get('path')}

def correct_amend(row,card,tr,owners):
    at=card.get('as_of') or ''; cid=card.get('case_id') or ''
    c=target_value(row); explicit=explicit_label_values(cid)
    if not c: return row
    changes=changed_keys(tr,c,at)
    out=[]
    for f in row.get('gold') or []:
        f=deepcopy(f); p=f.get('path',''); k=leaf(p); basis=str(f.get('basis') or '')
        if not p.startswith('/bookings/') or k in ('confirmation_number','reservation_id'):
            out.append(f); continue
        ds=changes.get(k,[])
        attributable=next((d for d in ds if owners.get((c,d.get('after_sent_at','')))==cid),None)
        if basis in ('letter_amend_delta','hms_truth') or basis.startswith('hms'):
            if attributable:
                ch=attributable.get('changes',{})
                src=next((src for src,dst in LETTER.items() if dst==k and src in ch),None)
                if src or (k in ('first_name','last_name') and 'guest_name' in ch):
                    if src: nv=ch[src].get('after')
                    else:
                        words=str(ch['guest_name'].get('after') or '').split(); nv=' '.join(words[:-1]) if k=='first_name' else words[-1]
                    nv=canonical_outcome_value(k,nv)
                    if nv is not None:
                        f.update(value=nv,expectation='expected',basis='letter_amend_delta_attributed',captured_at=attributable.get('after_sent_at'))
                        out.append(f); continue
            # Not nearest preceding request: fall back to the explicit request if present.
            if p in explicit and explicit[p] is not None:
                ev=canonical_outcome_value(k,explicit[p])
                if ev is not None:
                    f.update(value=ev,expectation='expected',basis='luna_evidence',source='email_explicit')
                    f.pop('captured_at',None); out.append(f); continue
            # If nothing later modified the field, a post-action HMS capture is stable confirmation.
            if not ds:
                hv=None; cap=None
                for cp in sorted(tr.anchors.get(c,{}).get('captures',[]),key=lambda x:x.get('captured_at','')):
                    if cp.get('captured_at','')>=at:
                        hv=canonical_outcome_value(k,hms_field_value(cp.get('hms_fields') or {},k)); cap=cp.get('captured_at')
                        if hv is not None: break
                if hv is not None:
                    f.update(value=hv,expectation='expected',basis='hms_post_action_stable',captured_at=cap)
                    out.append(f); continue
            f=unknown_field(f,'amend_delta_unattributable',dict(confirmation=c))
        out.append(f)
    row['gold']=out
    return row

def host_domain(addr):
    return str(addr or '').rpartition('@')[2].strip().strip('<>').lower()

def blocked_domain(domain):
    bits=(domain or '').lower().split('.')
    return next((d for i in range(len(bits)) if (d:='.'.join(bits[i:])) in OTA_DOMAINS),'')

def forwarded_original_domain(card):
    body=str((card.get('selected_email') or {}).get('body_text') or '')
    # Sender-domain rule only: read the forwarded message's original From header.
    m=re.search(r'(?im)^\s*>?\s*From:\s*[^\r\n<>]*?<?([A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+))>?',body)
    return (m[2] or '').lower() if m else ''

def apply_scope(row,card):
    selected=card.get('selected_email') or {}
    sender=host_domain(selected.get('from_address'))
    subject=str(selected.get('subject') or '')
    # Only the selected forward itself is in scope here.  A later human reply whose
    # quoted history contains an OTA header remains a genuine hotel workflow.
    if not re.match(r'(?i)^\s*(?:fw|fwd)\s*:',subject): return row,False
    original=forwarded_original_domain(card)
    domain=blocked_domain(original) or blocked_domain(sender)
    if not domain: return row,False
    row=deepcopy(row)
    row.update(skip=True,not_evaluable=True,expected_action_count=0,expected_disposition='skip',gold=[],scope_exclusion='forwarded_ota_channel_notice',original_sender_domain=original or sender)
    row['v7_note']='out of scope: automated OTA/channel notice identified by original sender domain'
    return row,True

def fix_quote_child_paths(row):
    if row.get('workflow')!='quote': return row
    for f in row.get('gold') or []:
        if str(f.get('path','')).endswith('/child_count'):
            f['path']=str(f['path'])[:-len('/child_count')]+'/children'
            f['basis']=str(f.get('basis',''))+'|v7_quote_children_path'
    return row

def fix_unverified_targets(row):
    for i,f in enumerate(row.get('gold') or []):
        if f.get('basis')=='target_unverified' and f.get('expectation')=='expected' and f.get('value') is None:
            row['gold'][i]=unknown_field(f,'target_unverified')
    return row

def parse_date_text(s,year_hint=None):
    s=str(s or '').strip()
    for fmt in ('%d %B %Y','%d %b %Y','%Y-%m-%d'):
        try: return datetime.strptime(s,fmt).date().isoformat()
        except Exception: pass
    m=re.match(r'(\d{1,2})\s+([A-Za-z]+)\s*(\d{4})?',s)
    if m:
        y=int(m[3] or year_hint or 2026)
        try: return datetime.strptime(f'{m[1]} {m[2]} {y}','%d %B %Y').date().isoformat()
        except Exception: return ''
    return ''

def recover_skipped_creates(tr):
    """Conservative no-inference recovery: explicit booking ask + exactly one matching later original confirmation."""
    recovered={}
    intent=re.compile(r'(?i)\b(?:please\s+assist\s+with\s+(?:a\s+)?(?:booking|reservation)|please\s+book|booking\s+for|reservation\s+for)\b')
    for th in lines(RUN22/'threads.jsonl'):
        for idx,m in enumerate(th['messages']):
            if m.get('direction')!='inbound': continue
            id=cid(m); l=read_label(id)
            if l.get('route')!='skip': continue
            body=m.get('body_text') or ''
            if not intent.search(body): continue
            at=m.get('received_at','')
            nm=re.search(r'(?im)\b(?:Mr|Ms|Mrs|Dr)\.?\s+([A-Z][A-Za-z`-]+)\s+([A-Z][A-Za-z`-]+)\b',body)
            ci=re.search(r'(?im)check\s*-?\s*in\s*:?\s*([0-9]{1,2}\s+[A-Za-z]+(?:\s+[0-9]{4})?)',body)
            co=re.search(r'(?im)check\s*-?\s*out\s*:?\s*([0-9]{1,2}\s+[A-Za-z]+(?:\s+[0-9]{4})?)',body)
            if not (nm and ci and co): continue
            first,last=nm[1],nm[2]; arr=parse_date_text(ci[1],at[:4]); dep=parse_date_text(co[1],at[:4])
            matches=[]
            for c,rows in tr.letters.items():
                r=rows[0] if rows else {}
                if not r.get('sent_at') or not (at<=r['sent_at'] and r['sent_at'][:10]<=dtadd(at,10)): continue
                if name(last) in name(r.get('guest_name')) and iso(r.get('arrival'))==arr and (not dep or iso(r.get('departure'))==dep):
                    matches.append((c,r))
            if len(matches)!=1: continue
            c,r=matches[0]
            entries={}
            for k in ('first_name','last_name','arrival_date','departure_date','adults','child_count','room_type','board','agency_name','organization_name','rate_plan'):
                v,bs,cap=create_action_value(tr,c,k,at)
                if v is not None:
                    entries['/bookings/0/fields/'+k]=field('/bookings/0/fields/'+k,v,bs,None,dict(confirmation=c,captured_at=cap))
            row=dict(workflow='create',skip=False,gold=[entries[k] for k in sorted(entries)],expected_action_count=1,
                     expected_disposition='propose',evidence_quote=(intent.search(body).group(0) if intent.search(body) else ''),
                     doc_kind='none',staff_outcome_only=dict(create_confirmations={'0':c},current_status={}),
                     source_label='v7_skip_recovery:explicit_booking_plus_original_confirmation',slice='dev',v7_recovered_from_skip=True)
            recovered[id]=(row,m,c)
    return recovered

def transform_all(outdir=SHIP_OUT):
    tr=Truth()
    rows=[]; cases={}
    for split,d in SPLITS:
        gold=jload(d/'gold.json')
        for cid,row in gold.items():
            cp=d/cid/'case.json'
            card=jload(cp) if cp.exists() else {'case_id':cid,'as_of':'','selected_email':{}}
            cases[(split,cid)]=card; rows.append((split,cid,deepcopy(row),card))
    owners=amend_attribution(rows,tr)
    output={s:{} for s,_ in SPLITS}; stats={'scope_excluded':[],'quote_child_path':[],'unverified_targets':[],'amend_rewritten':[],'create_rewritten':[]}
    for split,cid,old,card in rows:
        row=deepcopy(old)
        before=stable_value(row)
        row=fix_unverified_targets(row)
        if any(x.get('basis')=='target_unverified' and x.get('expectation')=='no_gold' for x in row.get('gold') or []): stats['unverified_targets'].append(cid)
        row=fix_quote_child_paths(row)
        if row.get('workflow')=='quote' and any('|v7_quote_children_path' in str(x.get('basis','')) for x in row.get('gold') or []): stats['quote_child_path'].append(cid)
        if row.get('workflow')=='create': row=correct_create(row,card,tr)
        if row.get('workflow')=='amend': row=correct_amend(row,card,tr,owners)
        row,excluded=apply_scope(row,card)
        if excluded: stats['scope_excluded'].append(cid)
        if stable_value(row)!=before:
            if row.get('workflow')=='create': stats['create_rewritten'].append(cid)
            if row.get('workflow')=='amend': stats['amend_rewritten'].append(cid)
        output[split][cid]=row
    recovered=recover_skipped_creates(tr)
    for cid,(row,m,c) in recovered.items():
        # Newly recovered dev decisions enter train only; locked validation/test rosters stay immutable.
        output['train'][cid]=row
    diff=make_diff(rows,output,recovered)
    outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
    for split,_ in SPLITS:
        jdump(outdir/f'gold-v7-{split}.json',output[split])
    jdump(outdir/'v6-to-v7-diff.json',diff)
    summary={'counts':{s:len(output[s]) for s,_ in SPLITS},'recovered_skip_count':len(recovered),'recovered_skip_ids':sorted(recovered)[:20],**{k:sorted(set(v))[:20] for k,v in stats.items()}}
    jdump(outdir/'build-summary.json',summary)
    return output,diff,stats,recovered

def make_diff(old_rows,output,recovered):
    buckets=defaultdict(lambda:{'labels_changed':0,'newly_unknown':0,'newly_in_scope':0,'dropped':0,'examples':{'labels_changed':[],'newly_unknown':[],'newly_in_scope':[],'dropped':[]}})
    def ex(bucket,kind,cid):
        if len(bucket['examples'][kind])<5 and cid not in bucket['examples'][kind]: bucket['examples'][kind].append(cid)
    for split,cid,old,card in old_rows:
        new=output[split].get(cid)
        if new is None: continue
        wf=new.get('workflow') or old.get('workflow') or 'unknown'
        if new.get('not_evaluable') and not old.get('not_evaluable'):
            key=f'{wf}:/workflow'; buckets[key]['dropped']+=1; ex(buckets[key],'dropped',cid)
        if (new.get('workflow'),new.get('expected_disposition'))!=(old.get('workflow'),old.get('expected_disposition')):
            key=f'{wf}:/workflow'; buckets[key]['labels_changed']+=1; ex(buckets[key],'labels_changed',cid)
        om={f.get('path'):f for f in old.get('gold') or [] if isinstance(f,dict)}
        nm={f.get('path'):f for f in new.get('gold') or [] if isinstance(f,dict)}
        for p in sorted(set(om)|set(nm)):
            o,n=om.get(p),nm.get(p); key=f'{wf}:{normpath(p)}'
            if o and not n or (n and not o):
                # quote child path rename is a label correction, not loss
                alt=p.replace('/child_count','/children') if o else p.replace('/children','/child_count')
                if (o and alt in nm) or (n and alt in om):
                    buckets[key]['labels_changed']+=1; ex(buckets[key],'labels_changed',cid)
                elif o:
                    buckets[key]['newly_unknown']+=1; ex(buckets[key],'newly_unknown',cid)
                else:
                    buckets[key]['labels_changed']+=1; ex(buckets[key],'labels_changed',cid)
                continue
            if o.get('expectation')!='no_gold' and n.get('expectation')=='no_gold':
                buckets[key]['newly_unknown']+=1; ex(buckets[key],'newly_unknown',cid)
            elif stable_value(o.get('value'))!=stable_value(n.get('value')) or o.get('expectation')!=n.get('expectation') or o.get('path')!=n.get('path'):
                buckets[key]['labels_changed']+=1; ex(buckets[key],'labels_changed',cid)
    for cid in recovered:
        key='create:/workflow'; buckets[key]['newly_in_scope']+=1; ex(buckets[key],'newly_in_scope',cid)
    return {k:v for k,v in sorted(buckets.items())}

if __name__=='__main__' and os.environ.get('GOLD_V7_BUILD')=='1':
    ap=argparse.ArgumentParser(); ap.add_argument('--out',default=str(SHIP_OUT)); ns=ap.parse_args()
    output,diff,stats,recovered=transform_all(ns.out)
    print(json.dumps({'out':ns.out,'counts':{k:len(v) for k,v in output.items()},'recovered':sorted(recovered),'diff_buckets':len(diff)},indent=2))
elif __name__=='__main__':
    print('gold_v7 frozen builder module; run with GOLD_V7_BUILD=1 --out <dir>')
