#!/usr/bin/env python3
"""Recover text and attachment names for selected bodyless Centurion emails.

Reads exported message IDs and existing S3 objects; never writes to the mailbox.
Private results contain cleaned text and attachment metadata, not attachment bytes.
SSM carries transfer metadata only; private results use the expiring S3 path.
"""
import argparse
import base64
import importlib.util
import json
import os
import uuid
import zlib
from pathlib import Path

from private_s3_transfer import (
    BUCKET as TRANSFER_BUCKET,
    EXPECTED_BUCKET_OWNER,
    REGION as TRANSFER_REGION,
    delete_transfer,
    ensure_private_transfer_bucket,
    fetch_payload,
    transfer_key,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DIRECTORY = ROOT / '.private/centurion-opportunity-october-20261101/bulk-sep26-v7'
OUTPUT = DIRECTORY / 'empty-mime-recovery.json'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


REMOTE = r'''
import base64,hashlib,html,json,os,re,subprocess,unicodedata,zlib
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
import boto3
from botocore.config import Config

class Visible(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.parts=[]; self.hidden=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style'): self.hidden.append(tag)
        elif not self.hidden and tag in ('br','p','div','tr','td','li'): self.parts.append('\n')
    def handle_endtag(self,tag):
        if self.hidden and self.hidden[-1]==tag: self.hidden.pop()
        elif not self.hidden and tag in ('p','div','tr','td','li'): self.parts.append('\n')
    def handle_data(self,data):
        if not self.hidden: self.parts.append(data)

def clean(value):
    t=html.unescape(''.join(c for c in str(value or '') if unicodedata.category(c)!='Cf'))
    t=re.sub(r'https?://\S+','[link]',t,flags=re.I)
    t=re.sub(r'(?i)\b(authori[sz]ation\s+code|card\s+(?:number|no)|card\s+expiry|expir(?:y|ation)\s+date|cvv|cvc|account\s+(?:number|no)|iban|password|passcode|pin|api[ _-]?key|verification code|security code|otp)\b\s*(?:is|:|=|-)\s*\S+',r'\1: [removed]',t)
    t=re.sub(r'(?im)^\s*(?=[a-z0-9-]{4,12}\s*$)(?=[a-z0-9-]*\d)[a-z0-9-]+\s*$','[code removed]',t)
    t=re.sub(r'(?<!\d)(?:\d[ -]?){13,19}(?!\d)','[number removed]',t)
    return re.sub(r'\n{3,}','\n\n',t.replace('\r\n','\n').replace('\r','\n')).strip()

target=json.loads(base64.b64decode(TARGET).decode())
by_id={rid:case for case,ids in target.items() for rid in ids}
locators={}
base=Path('/home/ubuntu/repos/zero/.private/connected-mailbox-corpus')
for snapshot in ('centurion-nine-day-bfcd9949-591f-4c9a-b061-3679ec793b51','centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711'):
    for line in (base/snapshot/'messages.jsonl').open():
        r=json.loads(line); case=by_id.get(r.get('id'))
        if case and r.get('rawMimeLocator') and case not in locators: locators[case]=r['rawMimeLocator']
processes=json.loads(subprocess.check_output(['pm2','jlist']))
en=next(p['pm2_env'] for p in processes if p.get('name')=='http')
for key in ('AWS_REGION','AWS_DEFAULT_REGION','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE'):
    value=en.get(key) or (en.get('env') or {}).get(key)
    if value: os.environ.setdefault(key,str(value))
bucket=en.get('S3_BUCKET') or (en.get('env') or {}).get('S3_BUCKET')
if not bucket: raise SystemExit('S3 bucket unavailable')
client=boto3.client('s3',region_name=en.get('AWS_REGION') or 'af-south-1',config=Config(connect_timeout=5,read_timeout=20,retries={'max_attempts':1}))

def recover(item):
    case,key=item
    if not key: return case,{'status':'locator_missing','body':'','attachments':[]}
    try:
        response=client.get_object(Bucket=bucket,Key=key)
        if response.get('ContentLength',0)>15000000:
            response['Body'].close(); return case,{'status':'too_large','body':'','attachments':[]}
        msg=BytesParser(policy=policy.default).parsebytes(response['Body'].read())
        bodies={'text/plain':[],'text/html':[]}; attachments=[]
        for part in msg.walk():
            if part.is_multipart(): continue
            mime=part.get_content_type(); name=part.get_filename(); disp=part.get_content_disposition()
            if disp=='attachment' or (name and (disp!='inline' or not part.get('Content-ID'))):
                attachments.append({'name':clean(name or 'unnamed')[:160],'content_type':mime})
            elif mime in bodies:
                try: text=part.get_content()
                except Exception: continue
                if isinstance(text,str): bodies[mime].append(text)
        body='\n'.join(bodies['text/plain'])
        if not body and bodies['text/html']:
            parser=Visible();parser.feed('\n'.join(bodies['text/html']));body=''.join(parser.parts)
        return case,{'status':'ok','body':clean(body)[:6000],'attachments':attachments[:20]}
    except Exception:
        return case,{'status':'read_error','body':'','attachments':[]}
with ThreadPoolExecutor(max_workers=4) as pool:
    output=dict(pool.map(recover,[(case,locators.get(case)) for case in target]))
payload=zlib.compress(json.dumps(output,ensure_ascii=False).encode(),9)
transfer_path=Path('/tmp')/('nava-empty-mime-recovery-'+TRANSFER_TOKEN+'.payload')
try:
    fd=os.open(transfer_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as out:out.write(payload)
    uploaded=subprocess.run(['aws','s3api','put-object','--bucket',TRANSFER_BUCKET,
        '--key',TRANSFER_KEY,'--body',str(transfer_path),'--region',TRANSFER_REGION,
        '--expected-bucket-owner',TRANSFER_OWNER,'--server-side-encryption','AES256',
        '--query','ServerSideEncryption','--output','text'],capture_output=True,text=True,timeout=120)
    if uploaded.returncode or uploaded.stdout.strip()!='AES256':raise RuntimeError('private_transfer_upload_failed')
finally:
    transfer_path.unlink(missing_ok=True)
print(json.dumps({'key':TRANSFER_KEY,'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest(),
    'server_side_encryption':'AES256'}))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(DIRECTORY.resolve()):
        raise SystemExit('output must stay in the private run directory')
    if output.exists():
        raise SystemExit('private recovery output already exists')
    target = {}
    for line in (DIRECTORY / 'inbound.jsonl').open():
        row = json.loads(line)
        mail = row['inbound']
        domains = {a.rsplit('@', 1)[-1].casefold() for a in mail.get('from', []) if '@' in a}
        selected = (row['case'] in args.case) if args.case else (
            not (mail.get('message') or '').strip() and not (mail.get('quoted_context') or '').strip()
            and 'grfeedback-b.com' not in domains)
        if selected:
            target[row['case']] = row['_source']['row_ids']
    if not target or (args.case and set(target) != set(args.case)):
        raise SystemExit('selected cases missing or empty')
    tail = module('tail_recover', HERE / 'centurion-recent-tail.py')
    token = uuid.uuid4().hex
    expected_key = transfer_key(token)
    target_encoded = base64.b64encode(json.dumps(target).encode()).decode()
    code = ('TARGET=' + repr(target_encoded) + '\n'
            + 'TRANSFER_TOKEN=' + repr(token) + '\n'
            + 'TRANSFER_KEY=' + repr(expected_key) + '\n'
            + 'TRANSFER_BUCKET=' + repr(TRANSFER_BUCKET) + '\n'
            + 'TRANSFER_REGION=' + repr(TRANSFER_REGION) + '\n'
            + 'TRANSFER_OWNER=' + repr(EXPECTED_BUCKET_OWNER) + '\n' + REMOTE)
    ensure_private_transfer_bucket()
    try:
        metadata = json.loads(tail.ssm("python3 - <<'REMOTE'\n" + code + "\nREMOTE"))
        compressed = fetch_payload(metadata, expected_key)
    finally:
        delete_transfer(expected_key)
    data = json.loads(zlib.decompress(compressed))
    if set(data) != set(target):
        raise SystemExit('recovery case mismatch')
    cleaner = module('range_recover', HERE / 'centurion-range-prepare.py')
    pilot = module('pilot_recover', HERE / 'pilot-250-review.py')
    for result in data.values():
        result['body'] = cleaner.scrub(result.get('body') or '')
        for attachment in result.get('attachments', []):
            attachment['name'] = cleaner.scrub(attachment.get('name') or '')
        if pilot._contains_sensitive_payment_data(result):
            result.update(status='withheld_sensitive', body='', attachments=[])
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    print(json.dumps({'selected': len(target), 'read_ok': sum(r['status']=='ok' for r in data.values()),
                      'with_body': sum(bool(r['body']) for r in data.values()),
                      'with_attachments': sum(bool(r['attachments']) for r in data.values()),
                      'other_statuses': sorted({r['status'] for r in data.values() if r['status']!='ok'})}))


if __name__ == '__main__':
    main()
