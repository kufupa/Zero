import concurrent.futures,datetime as dt,hashlib,html,json,os,re,subprocess,zipfile
from pathlib import Path
from statistics import median
from xml.etree import ElementTree as ET
R=Path('/tmp/s5-rates'); D=R/'docs'; rows=[json.loads(x) for x in (R/'messages.jsonl').read_text().split(chr(10)) if x.strip()]
boxes=['transport-centurion','transport-davinci','transport-faith','transport-ayanda','transport-epick','transport-kmgidi']
objs={}
for r in rows:
 for a in r.get('docs') or []:
  k='sha:'+a['sha'] if a.get('sha') else 'key:'+a.get('key','')
  if a.get('key') and k not in objs: objs[k]=a
def path(k,a):
 d=D/hashlib.sha256(k.encode()).hexdigest(); d.mkdir(mode=0o700,exist_ok=True)
 ext='.pdf' if 'pdf' in (a.get('mime') or '').lower() or (a.get('name') or '').lower().endswith('.pdf') else '.xlsx'
 return d/('obj'+ext)
def fetch(it):
 k,a=it; p=path(k,a)
 if p.exists() and p.stat().st_size: return k,True
 try:
  key=a['key']; uri=key if key.startswith('s3://') else 's3://'+os.environ['S3_BUCKET']+'/'+key
  subprocess.run(['aws','s3','cp',uri,str(p),'--only-show-errors'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120,check=True)
  return k,p.exists() and p.stat().st_size>0
 except Exception: return k,False
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex: ok=dict(ex.map(fetch,objs.items()))
def xlsx(p):
 out=[]
 try:
  with zipfile.ZipFile(p) as z:
   ns=set(z.namelist()); ss=[]
   if 'xl/sharedStrings.xml' in ns and z.getinfo('xl/sharedStrings.xml').file_size<30000000:
    rt=ET.fromstring(z.read('xl/sharedStrings.xml')); ss=[''.join(t.text or '' for t in e.iter() if t.tag.endswith('}t')) for e in rt]
   for nm in sorted(n for n in ns if re.fullmatch(r'xl/worksheets/sheet\d+\.xml',n)):
    if z.getinfo(nm).file_size>30000000: continue
    with z.open(nm) as f:
     for _,row in ET.iterparse(f,events=('end',)):
      if row.tag.endswith('}row'):
       vals=[]
       for c in list(row):
        if not c.tag.endswith('}c'): continue
        v=c.find('{*}v'); x=(v.text or '') if v is not None else ''; typ=c.attrib.get('t')
        if typ=='s':
         try:x=ss[int(x)]
         except:x=''
        elif typ=='inlineStr':x=''.join(t.text or '' for t in c.iter() if t.tag.endswith('}t'))
        if x: vals.append(x)
       if vals: out.append(' | '.join(vals))
       row.clear()
 except Exception:return ''
 return '\n'.join(out)[:1000000]
texts={}
for k,a in objs.items():
 p=path(k,a)
 try:
  if not ok.get(k): texts[k]=''
  elif p.suffix=='.pdf':
   z=subprocess.run(['pdftotext','-q','-layout','-enc','UTF-8',str(p),'-'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=35)
   texts[k]=z.stdout[:2000000].decode('utf-8','replace') if z.returncode==0 else ''
  else:texts[k]=xlsx(p)
 except Exception:texts[k]=''
def clean(s):
 s=html.unescape(re.sub(r'<[^>]*>',' ',s or '')); s=re.split(r'(?im)^\s*(?:-{2,}\s*(?:original message|forwarded message)\s*-{2,}|from:\s|on .+wrote:)\s*',s,maxsplit=1)[0]
 return '\n'.join(x for x in s.splitlines() if not x.strip().startswith('>')).strip()
RX={
'BAR':r'\bbest\s+available(?:\s+rate)?\b|\bBAR\s*(?:rate|plan)\b|\bBAR\b',
'STO/net':r'\bSTO\b|\bnet\s+(?:rate|tariff|price)\b|\b(?:rate|tariff)\s*[:=-]?\s*net\b',
'contract/NC':r'\bcontract(?:ed)?\b|\bNC\s*(?:rate|plan)\b|\bcontract\s*/\s*NC\b|\bnon[ -]?commissionable\b',
'wholesale/WS':r'\bwholesale\b|\bWS\s*(?:rate|plan|tariff)\b|\b(?:rate|plan|tariff)\s*[:=-]?\s*WS\b',
'government/GOV':r'\bgovernment\b|\bGOV\s*(?:rate|plan)\b|\bN?GOV[A-Z0-9]{1,}\b',
'airline/AIR':r'\bairline\b|\bair\s*crew\b|\bcrew\s+rate\b|\bAIR\s*(?:rate|plan|code)\b',
'promo':r'\bpromo(?:tional)?\b|\bpromotion\b','corporate':r'\bcorporate\b|\bCORP\s*(?:rate|plan)\b','rack':r'\brack\s+(?:rate|price)\b|\brack\b'}
RX={k:re.compile(v,re.I) for k,v in RX.items()}
MONEY=re.compile(r'\b(?:ZAR|R)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b|\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:ZAR|Rand)\b',re.I)
def vals(t):
 out=[]
 for m in MONEY.finditer(t):
  try:
   v=float((m.group(1) or m.group(2)).replace(',',''))
   if 100<=v<=100000:out.append(round(v,2))
  except:pass
 return out
def labels(t,doc=False):
 out=[]
 for lab,rx in RX.items():
  hits=bool(rx.search(t))
  if lab=='BAR' and hits and not re.search(r'\bbest\s+available\b|\bBAR\s*(?:rate|plan)\b',t,re.I): hits=doc and bool(re.search(r'\b(?:rate|room|ZAR|R\s*\d)',t,re.I))
  if lab=='wholesale/WS' and doc and re.search(r'\bWS\b',t,re.I):hits=True
  if lab=='government/GOV' and doc and re.search(r'\bGOV\b',t,re.I):hits=True
  if lab=='airline/AIR' and doc and re.search(r'\bAIR\b',t,re.I):hits=True
  if lab=='contract/NC' and doc and re.search(r'\bNC\b',t,re.I):hits=True
  if lab=='corporate' and doc and re.search(r'\bCORP\b',t,re.I):hits=True
  if hits:out.append(lab)
 return out
def qdoc(t):return bool(re.search(r'\bquotation\b|\bquote\b|\bproposal\b|valid\s+until|rate\s+per\s+(?:room\s+)?(?:night|day)|nightly\s+rate',t,re.I) or (vals(t) and re.search(r'\b(?:room|suite|single|twin|double)\b',t,re.I) and re.search(r'\b(?:B\s*&\s*B|bed\s*(?:and|&)\s*breakfast|DBB|RO|rate|night)\b',t,re.I)))
def classify(addr,body=''):
 a=(addr or '').lower(); d=a.rsplit('@',1)[-1] if '@' in a else ''; t=(body or '').lower()
 if not a:return 'unknown'
 if d.endswith(('legacyhotels.co.za','legacyhotels.com')):return 'internal'
 if d.endswith('gov.za') or re.search(r'\.(?:gov|govt)\.',d) or re.search(r'\b(government|municipality|ministry|department of|state[- ]owned|public sector)\b',t):return 'government/SOE'
 if re.search(r'airline|airways|aviation',d) or re.search(r'\b(airline crew|crew rate|flight crew)\b',t):return 'airline crew'
 if re.search(r'travel|tours?|safari|holiday|iata|agency|booking|tmc',d) or re.search(r'\b(travel agent|tour operator|TMC|IATA|travel agency)\b',t,re.I):return 'travel agent/TMC'
 if d in {'gmail.com','yahoo.com','yahoo.co.za','outlook.com','hotmail.com','live.com','icloud.com','aol.com','protonmail.com','proton.me','me.com'}:return 'individual/public webmail'
 return 'company domain' if '.' in d else 'unknown'
def emails(v):
 s=json.dumps(v) if not isinstance(v,str) else v
 return sorted(set(x.lower() for x in re.findall(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',s,re.I)))
MONTH={x[:3].lower():i for i,x in enumerate(['January','February','March','April','May','June','July','August','September','October','November','December'],1)}
def features(ib):
 if not ib:return {'sender':'unknown','rooms':None,'lead':None,'nights':None,'named':False,'body':''}
 b=clean(ib.get('body','')); sent=dt.datetime.fromisoformat((ib.get('at') or '').replace(' ','T'))
 dates=[]
 for y,m,d in re.findall(r'\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b',b):
  try: dates.append(dt.date(int(y),int(m),int(d)))
  except:pass
 for d,m,y in re.findall(r'\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?[,]?\s*(20\d{2})?\b',b,re.I):
  try:
   mm=MONTH[m[:3].lower()]; yy=int(y) if y else sent.year; x=dt.date(yy,mm,int(d)); x=x.replace(year=yy+1) if not y and x<sent.date()-dt.timedelta(days=30) else x; dates.append(x)
  except:pass
 dates=sorted(set(x for x in dates if sent.date()-dt.timedelta(days=1)<=x<=sent.date()+dt.timedelta(days=1100)))
 r=[int(x) for x in re.findall(r'\b(\d{1,2})\s*(?:x\s*)?rooms?\b',b,re.I) if 0<int(x)<=100]
 r += [{'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,'nine':9,'ten':10}[x.lower()] for x in re.findall(r'\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+rooms?\b',b,re.I)]
 if not r and re.search(r'\b(?:a|one|single)\s+(?:standard\s+|double\s+|twin\s+|king\s+)?room\b',b,re.I):r=[1]
 n=re.search(r'\b(\d{1,2})\s*nights?\b',b,re.I); nights=int(n.group(1)) if n else ((dates[1]-dates[0]).days if len(dates)>1 and dates[1]>dates[0] else None)
 named=bool(re.search(r'\b(company|agency|corporate|contract(?:ed)?|account|negotiated|preferred|rate|rates|BAR|STO|GOV|government|wholesale|airline|crew|rack|promo)\b',b,re.I))
 return {'sender':classify(ib.get('from',''),b),'rooms':max(r) if r else None,'lead':(dates[0]-sent.date()).days if dates else None,'nights':nights,'named':named,'body':b}
def ratefacts(texts):
 t='\n'.join(texts); room=[]
 for n,p in [('Standard King',r'standard\s+king'),('Standard Queen',r'standard\s+queen'),('Deluxe King',r'deluxe\s+king'),('Executive',r'executive'),('Suite',r'\bsuite\b'),('Twin',r'\btwin\b'),('Deluxe',r'\bdeluxe\b'),('Double',r'\bdouble\b'),('Single',r'\bsingle\b'),('King',r'\bking\b'),('Queen',r'\bqueen\b')]:
  if re.search(p,t,re.I):room.append(n)
 board=[]
 if re.search(r'\bDBB\b|dinner\s*(?:bed|&|and)\s*breakfast',t,re.I):board.append('DBB')
 if re.search(r'\bB\s*&\s*B\b|bed\s*(?:and|&)\s*breakfast',t,re.I):board.append('B&B')
 if re.search(r'\bRO\b|room\s+only',t,re.I):board.append('RO')
 prices=[]; lines=t.splitlines(); unit=re.compile(r'per\s+(?:(?:room|person|pax)\s+)?night|nightly\s+rate|rate\s+per\s+room\s+per\s+night',re.I)
 for i,l in enumerate(lines):
  if re.search(r'\b(dinner|allowance|transfer|shuttle|deposit|tax|levy|total|vat|commission)\b',l,re.I):continue
  if unit.search(l) or (re.search(r'\b(rate|nightly)\b',l,re.I) and unit.search(t)):
   prices+=vals(l)
   if not vals(l):prices+=vals(' '.join(lines[max(0,i-1):i+2]))
 return sorted(set(prices)),sorted(set(room)),sorted(set(board))
groups={}
for r in rows:
 g=groups.setdefault(r['mid'],{'boxes':set(),'docs':{},'body':[],'ib':[],'to':[],'sent':r.get('sent','')}); g['boxes'].add(r['transport']);g['body'].append(clean(r.get('body','')));g['to']+=emails(r.get('to'))
 if r.get('inbound'):g['ib'].append(r['inbound'])
 for a in r.get('docs') or []:g['docs']['sha:'+a['sha'] if a.get('sha') else 'key:'+a['key']]=a
quotes=[]; qword=re.compile(r'\b(?:quote|quotation|proposal)\b',re.I)
for mid,g in groups.items():
 body=max(g['body'],key=len) if g['body'] else ''; docs=[]; al=set(); dseen=False
 for k,a in g['docs'].items():
  t=texts.get(k,'')
  if t and qdoc(t):dseen=True;docs.append(t);al.update(labels(t,True))
  elif t and re.search(r'\b(?:quote|quotation|proposal)\b',a.get('name',''),re.I) and (vals(t) or re.search(r'\broom\b',t,re.I)):
   dseen=True;docs.append(t);al.update(labels(t,True))
 inline=bool(vals(body) and re.search(r'\b(room|suite|single|twin|double)\b',body,re.I) and re.search(r'\b(night|stay|arrival|check[ -]?in|B\s*&\s*B|DBB)\b',body,re.I))
 if not(qword.search(body) or dseen or inline):continue
 bl=set(labels(body,False)); labs=bl|al; ib=max(g['ib'],key=lambda x:x.get('at','')) if g['ib'] else None; f=features(ib)
 tc=sorted(set(classify(x) for x in g['to']));tc=[x for x in tc if x!='internal'] or (['internal'] if tc else ['unknown'])
 price,room,board=ratefacts(docs+[body]); quotes.append({'boxes':sorted(g['boxes']),'labels':labs,'bl':bl,'al':al,'f':f,'to':tc,'date':g['sent'][:10],'price':price,'room':room,'board':board})
labels_order=list(RX); classes=['travel agent/TMC','government/SOE','airline crew','company domain','individual/public webmail','internal','unknown']; bybox={b:[] for b in boxes}
for q in quotes:
 for b in q['boxes']:
  if b in bybox:bybox[b].append(q)
print('WINDOW raw_outbound=%d unique_mid_or_fallback=%d duplicate_copies=%d quote_replies=%d' %(len(rows),len(groups),len(rows)-len(groups),len(quotes)))
print('ATTACHMENTS docs=%d unique_binaries=%d downloaded=%d failures=%d parsed_text=%d' %(sum(len(r.get('docs') or []) for r in rows),len(objs),sum(ok.values()),sum(not x for x in ok.values()),sum(bool(x) for x in texts.values())))
print('SCAN mailbox|out_distinct|quotes|label_found|body_label|attachment_label|unlabelled')
for b in boxes:
 q=bybox[b]; rs=[r for r in rows if r['transport']==b]; print('SCAN %s|%d|%d|%d|%d|%d|%d' %(b[10:],len(set(r['mid'] for r in rs)),len(q),sum(bool(x['labels']) for x in q),sum(bool(x['bl']) for x in q),sum(bool(x['al']) for x in q),sum(not x['labels'] for x in q)))
print('MAILBOX_LABEL mailbox|'+'|'.join(labels_order))
for b in boxes:print('MAILBOX_LABEL %s|%s' %(b[10:],'|'.join(str(sum(l in x['labels'] for x in bybox[b])) for l in labels_order)))
print('MAILBOX_LABEL total|%s' %'|'.join(str(sum(l in x['labels'] for x in quotes)) for l in labels_order))
print('PREDICT label|n|sender(TA/GOV/AIR/CO/WEB/INT/?)|rooms_med|lead_med|nights_med|ask_named_x/y|room_types|boards|night_ZAR_med_n')
for lab in labels_order:
 q=[x for x in quotes if lab in x['labels']]
 if not q:continue
 f=[x['f'] for x in q]; cc=[sum(z['sender']==c for z in f) for c in classes]; rooms=[z['rooms'] for z in f if z['rooms'] is not None]; leads=[z['lead'] for z in f if z['lead'] is not None]; nights=[z['nights'] for z in f if z['nights'] is not None]; nm=[z['named'] for z in f if z['body']]
 rm={v:sum(v in x['room'] for x in q) for v in sorted(set(v for x in q for v in x['room']))}; bd={v:sum(v in x['board'] for x in q) for v in sorted(set(v for x in q for v in x['board']))}; ps=[p for x in q for p in x['price']]
 fmt=lambda a:'%.1f(n=%d)'%(median(a),len(a)) if a else '—(n=0)'
 print('PREDICT %s|%d|%s|%s|%s|%s|%d/%d|%s|%s|%s' %(lab,len(q),','.join(map(str,cc)),fmt(rooms),fmt(leads),fmt(nights),sum(nm),len(nm),','.join('%s:%d'%z for z in rm.items()) or 'unparsed',','.join('%s:%d'%z for z in bd.items()) or 'unparsed',('%.0f(n=%d)'%(median(ps),len(ps))) if ps else 'unparsed(n=0)'))
rules=[('government/SOE=>GOV','government/SOE','government/GOV'),('airline-crew=>AIR','airline crew','airline/AIR'),('travel-agent=>WS','travel agent/TMC','wholesale/WS'),('travel-agent=>STO/net','travel agent/TMC','STO/net'),('company-domain=>corporate','company domain','corporate'),('named-company/rate=>contract/NC','named','contract/NC'),('public-webmail=>BAR','individual/public webmail','BAR')]
print('RULE cue=>label|hits/eligible|n')
for name,pred,lab in rules:
 pool=[x for x in quotes if (x['f']['named'] and x['f']['body'])] if pred=='named' else [x for x in quotes if x['f']['sender']==pred]
 if pool:print('RULE %s|%d/%d|%s' %(name,sum(lab in x['labels'] for x in pool),len(pool),'thin n<10' if len(pool)<10 else ''))
ws=sorted([x for x in quotes if 'wholesale/WS' in x['labels']],key=lambda x:(x['date'],x['boxes']))
print('WHOLESALE n=%d; anonymized rows=mailboxes,date,to-class,asker-class,source,room,board,nightlyZAR,askedrooms,lead,nights,named' %len(ws))
for i,x in enumerate(ws,1):
 src='both' if 'wholesale/WS' in x['bl'] and 'wholesale/WS' in x['al'] else 'body' if 'wholesale/WS' in x['bl'] else 'attachment'; f=x['f']
 print('WS W%03d|%s|%s|to:%s|ask:%s|%s|%s|%s|%s|rooms:%s|lead:%s|nights:%s|named:%s' %(i,','.join(b[10:] for b in x['boxes']),x['date'],','.join(x['to']),f['sender'],src,','.join(x['room']) or '—',','.join(x['board']) or '—',','.join(str(int(v)) for v in x['price']) or '—',f['rooms'] if f['rooms'] is not None else '—',f['lead'] if f['lead'] is not None else '—',f['nights'] if f['nights'] is not None else '—','Y' if f['named'] else 'N'))
print('QC inbound_matched=%d/%d multi_label=%d body_only=%d attachment_only=%d unlabeled=%d with_price=%d with_room=%d with_board=%d shared_mids=%d' %(sum(bool(x['f']['body']) for x in quotes),len(quotes),sum(len(x['labels'])>1 for x in quotes),sum(bool(x['bl']) and not x['al'] for x in quotes),sum(bool(x['al']) and not x['bl'] for x in quotes),sum(not x['labels'] for x in quotes),sum(bool(x['price']) for x in quotes),sum(bool(x['room']) for x in quotes),sum(bool(x['board']) for x in quotes),sum(len(x['boxes'])>1 for x in quotes)))
