#!/usr/bin/env python3
"""Export cleaned normalized rows from named, read-only mailbox snapshots.

Snapshots are on the configured EC2 host. Source rows remain there; this sends
only bounded cleaned text and metadata to a new owner-private JSONL file. The
snapshot must already identify the intended mailbox and scope.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PRIVATE_ROOT = ROOT / '.private'
CHUNK_SIZE = 18_000
MAX_TRANSFER = 50_000_000

REMOTE_EXPORT = r'''
import base64,datetime,hashlib,html,json,os,re,unicodedata,zlib
from html.parser import HTMLParser
from pathlib import Path

class Visible(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.parts=[]; self.hidden=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style'): self.hidden.append(tag); return
        if not self.hidden and tag in ('br','p','div','tr','td','li'): self.parts.append('\n')
    def handle_endtag(self,tag):
        if self.hidden and self.hidden[-1]==tag: self.hidden.pop()
        elif not self.hidden and tag in ('p','div','tr','td','li'): self.parts.append('\n')
    def handle_data(self,data):
        if not self.hidden: self.parts.append(data)

def mask_card(match):
    digits=[int(c) for c in match.group() if c.isdigit()]
    if not 13<=len(digits)<=19: return match.group()
    total=0
    for index,digit in enumerate(reversed(digits)):
        doubled=digit*2 if index%2 else digit
        total+=doubled-9 if doubled>9 else doubled
    return '[card removed]' if total%10==0 else match.group()

def clean(value,subject='',limit=16000):
    text=value if isinstance(value,str) else ''
    if re.search(r'(?i)<(?:html|body|p|div|br|table)\b',text):
        parser=Visible(); parser.feed(text); text=''.join(parser.parts)
    text=html.unescape(''.join(c for c in text if unicodedata.category(c)!='Cf'))
    text=text.replace('\r\n','\n').replace('\r','\n').replace('\xa0',' ')
    text=re.sub(r'(?i)\b(?:https?://|www\.)\S+','[link]',text)
    text=re.sub(r'(?i)\b(authori[sz]ation\s+code|card\s+(?:number|no)|card\s+expiry|expir(?:y|ation)\s+date|cvv|cvc|account\s+(?:number|no)|iban)\s*[:=]\s*[^\s]+',r'\1: [removed]',text)
    text=re.sub(r'(?<!\d)(?:\d[ -]?){13,19}(?!\d)',mask_card,text)
    text=re.sub(r'(?i)\b(otp|passcode|password|pin|api[ _-]?key|verification code|security code)(\s*(?:is|:|=|-)\s*)(?=[a-z0-9-]*\d)[a-z0-9-]{4,32}',r'\1\2[removed]',text)
    if re.search(r'(?i)\b(?:otp|one[ -]time password|verification code|security code)\b',subject+' '+text):
        text=re.sub(r'(?im)^\s*(?=[a-z0-9-]{4,12}\s*$)(?=[a-z0-9-]*\d)[a-z0-9-]+\s*$','[verification code removed]',text)
    text=re.sub(r'(?i)\b(?:password|passcode|one[ -]?time code|otp|pin|cvv|cvc|security code|card number)\b[^\n]{0,40}\b\d{3,19}\b|\b\d{3,19}\b[^\n]{0,40}\b(?:password|passcode|one[ -]?time code|otp|pin|cvv|cvc|security code|card number)\b','[sensitive detail removed]',text)
    text=re.sub(r'(?im)^\s*\[cid:[^\]]+\]\s*$','',text)
    return re.sub(r'\n{3,}','\n\n',text).strip()[:limit]

base=Path('/home/ubuntu/repos/zero/.private/connected-mailbox-corpus')
start=datetime.datetime.fromisoformat(START); end=datetime.datetime.fromisoformat(END)
rows=[]; skipped=0; by_snapshot={}
for name in SNAPSHOTS:
    count=0
    for line in (base/name/'messages.jsonl').open():
        row=json.loads(line)
        if row.get('scope')!='in_window': continue
        try:
            at=datetime.datetime.fromisoformat(str(row.get('eventAt') or '').replace('Z','+00:00'))
            if at.tzinfo is None: raise ValueError('naive timestamp')
        except ValueError:
            skipped+=1; continue
        if not start<=at<end: continue
        if row.get('direction') not in ('inbound','outbound') or not row.get('id'):
            skipped+=1; continue
        subject=clean(str(row.get('subject') or ''),str(row.get('subject') or ''),300)
        rows.append({'id':row['id'],'thread':row.get('threadId'),'when':at.isoformat(),
                     'direction':row['direction'],'message_id':row.get('messageId'),
                     'in_reply_to':row.get('inReplyTo'),'subject':subject,
                     'body':clean(row.get('textBody') or row.get('htmlBody') or '',subject),
                     'from':row.get('from') or [],'to':row.get('to') or [],'cc':row.get('cc') or []})
        count+=1
        if LIMIT and len(rows)>=LIMIT: break
    by_snapshot[name]=count
    if LIMIT and len(rows)>=LIMIT: break
payload={'rows':rows,'skipped_invalid':skipped,'by_snapshot':by_snapshot}
encoded=base64.b64encode(zlib.compress(json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode(),9))
folder=Path('/home/ubuntu/repos/zero/.private/mailbox-research-transfer')
folder.mkdir(mode=0o700,parents=True,exist_ok=True)
target=folder/(TOKEN+'.b64')
fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as output: output.write(encoded)
print(json.dumps({'file':str(target),'bytes':len(encoded),'sha256':hashlib.sha256(encoded).hexdigest(),
                  'rows':len(rows),'skipped_invalid':skipped,'by_snapshot':by_snapshot}))
'''


def ssm(command: str) -> str:
    process = subprocess.run(['bash', str(ROOT / 'apps/server-pilot/deploy/ssm-run-command.sh'), command],
                             text=True, capture_output=True, timeout=150)
    if process.returncode:
        raise RuntimeError('ssm_command_failed')
    invocation = json.loads(process.stdout)
    if invocation.get('Status') != 'Success':
        raise RuntimeError('ssm_command_not_successful')
    return invocation['Stdout'].strip()


def aware_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('timezone_required')
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', action='append', required=True, help='snapshot name, repeat oldest to newest')
    parser.add_argument('--start', required=True, help='inclusive timezone-aware ISO timestamp')
    parser.add_argument('--end', required=True, help='exclusive timezone-aware ISO timestamp')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sample-limit', type=int, default=0, help='optional small smoke-test limit')
    args = parser.parse_args()
    try:
        if aware_time(args.start) >= aware_time(args.end) or args.sample_limit < 0:
            raise ValueError('invalid_limits')
        if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', name) or '..' in name for name in args.snapshot):
            raise ValueError('invalid_snapshot')
        root = PRIVATE_ROOT.resolve(strict=True)
        parent = args.output.absolute().parent.resolve(strict=True)
        output_path = parent / args.output.name
        if not parent.is_relative_to(root) or output_path.exists() or output_path.is_symlink():
            raise ValueError('output_not_new_private_path')
        token = uuid.uuid4().hex
        prelude = (f'SNAPSHOTS={args.snapshot!r}\nSTART={args.start!r}\nEND={args.end!r}\n'
                   f'LIMIT={args.sample_limit!r}\nTOKEN={token!r}\n')
        metadata = json.loads(ssm("python3 - <<'PY'\n" + prelude + REMOTE_EXPORT + "\nPY"))
        remote = f'/home/ubuntu/repos/zero/.private/mailbox-research-transfer/{token}.b64'
        size = metadata.get('bytes')
        if metadata.get('file') != remote or not isinstance(size, int) or not 0 < size < MAX_TRANSFER:
            raise ValueError('invalid_transfer_metadata')

        def fetch(offset: int) -> bytes:
            code = f'from pathlib import Path\nf=Path({remote!r}).open("rb")\nf.seek({offset})\nprint(f.read({CHUNK_SIZE}).decode())'
            return ssm("python3 - <<'PY'\n" + code + "\nPY").encode()

        with ThreadPoolExecutor(max_workers=3) as pool:
            encoded = b''.join(pool.map(fetch, range(0, size, CHUNK_SIZE)))
        if len(encoded) != size or hashlib.sha256(encoded).hexdigest() != metadata.get('sha256'):
            raise ValueError('transfer_integrity_failed')
        payload = json.loads(zlib.decompress(base64.b64decode(encoded, validate=True)))
        rows = payload.get('rows')
        if not isinstance(rows, list) or len(rows) != metadata.get('rows'):
            raise ValueError('transfer_row_count_failed')
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            for row in rows:
                output.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
        # Remove only this invocation's random-token transfer after integrity verification.
        ssm("python3 - <<'PY'\nfrom pathlib import Path\nPath(" + repr(remote) + ").unlink(missing_ok=True)\nPY")
        print(json.dumps({'rows': len(rows), 'by_snapshot': metadata.get('by_snapshot'),
                          'skipped_invalid': metadata.get('skipped_invalid'),
                          'compressed_transfer_bytes': size, 'sha256': metadata.get('sha256')}, sort_keys=True))
    except (ValueError, OSError, RuntimeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        code = str(exc) if isinstance(exc, (ValueError, RuntimeError)) and re.fullmatch(r'[a-z_]+', str(exc)) else 'export_failed'
        raise SystemExit(code) from None


if __name__ == '__main__':
    main()
