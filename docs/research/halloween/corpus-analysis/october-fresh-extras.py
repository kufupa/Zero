#!/usr/bin/env python3
"""Fetch the newly sampled cases from the fresh read-only EC2 snapshot.

SSM carries transfer metadata only. The cleaned sample moves through the
private one-day S3 transfer path; the owner-only output may contain client
email and stays under .private.
"""

import base64
import json
import os
import subprocess
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


ROOT = Path(__file__).resolve().parents[4]
PRIVATE = ROOT / '.private/centurion-opportunity-october-20261101'
SNAPSHOT = 'centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711'
OUTPUT = PRIVATE / 'fresh-extra-packets.json'

REMOTE_CODE = r'''
import base64, datetime, email.utils, hashlib, html, json, os, re, subprocess, unicodedata, zlib
from html.parser import HTMLParser
from pathlib import Path

snapshot = Path("/home/ubuntu/repos/zero/.private/connected-mailbox-corpus") / SNAPSHOT
manifest = json.loads((snapshot / "manifest.json").read_text())
assert manifest["snapshotId"] == SNAPSHOT
requested = json.loads(base64.b64decode(IDS).decode())

class Visible(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.parts=[]; self.hidden=[]
    def handle_starttag(self, tag, attrs):
        if tag in ("script","style"): self.hidden.append(tag); return
        if not self.hidden and tag in ("br","p","div","tr","td","li"): self.parts.append("\n")
    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag: self.hidden.pop()
        elif not self.hidden and tag in ("p","div","tr","td","li"): self.parts.append("\n")
    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)

def clean(body):
    text = body if isinstance(body, str) else ""
    if re.search(r"(?i)<(?:html|body|p|div|br|table)\b", text):
        parser=Visible(); parser.feed(text); text="".join(parser.parts)
    text=html.unescape(text)
    text="".join(c for c in text if unicodedata.category(c)!="Cf")
    text=text.replace("\r\n","\n").replace("\r","\n").replace("\xa0"," ")
    text=re.sub(r"[ \t]{2,}"," ",text)
    text=re.sub(r"https?://\S+","[link]",text,flags=re.I)
    text=re.sub(r"(?i)\b(password|passcode|pin)\s*[:=]\s*\S+",r"\1: [removed]",text)
    if re.search(r"(?i)\b(?:otp|one[ -]time password|verification code|security code)\b",text):
        text=re.sub(r"(?im)^\s*(?=[a-z0-9-]{4,12}\s*$)(?=[a-z0-9-]*\d)[a-z0-9-]+\s*$","[verification code removed]",text)
        text=re.sub(r"(?i)\b(otp|passcode|password|pin|verification code|security code)(\s*(?:is|:|=)\s*)(?=[a-z0-9-]*\d)[a-z0-9-]{4,12}",r"\1\2[removed]",text)
    text=re.sub(r"(?m)^[ \t]+$","",text)
    text=re.sub(r"\n{3,}","\n\n",text).strip()
    return text[:16000]

def parts(row, limit=1100):
    text=clean(row.get("textBody") or row.get("htmlBody") or "")
    chunks=re.split(r"(?im)^\s*(?=From:\s*[^\n]+\n\s*Sent:|On .{5,120} wrote:)",text,maxsplit=1)
    return chunks[0][:limit].strip(), chunks[1][:900].strip() if len(chunks)>1 else ""

def addr(values):
    return {a.casefold() for _,a in email.utils.getaddresses(values or []) if "@" in a}

def timestamp(row):
    try:return datetime.datetime.fromisoformat(str(row.get("eventAt") or "").replace("Z","+00:00"))
    except ValueError:return None

rows=[json.loads(line) for line in (snapshot/"messages.jsonl").open()]
incoming={r["id"]:r for r in rows if r.get("scope")=="in_window" and str(r.get("direction","")).lower()=="inbound" and r["id"] in requested}
assert set(incoming)==set(requested)
outbound=[r for r in rows if str(r.get("direction","")).lower()=="outbound" and timestamp(r)]
packets=[]
for index, row_id in enumerate(requested,1):
    r=incoming[row_id]; when=timestamp(r); sender=addr(r.get("from")); candidates=[]
    for out in outbound:
        delta=(timestamp(out)-when).total_seconds()/60
        same=bool(r.get("threadId")) and r.get("threadId")==out.get("threadId")
        to=addr((out.get("to") or [])+(out.get("cc") or []))
        if not ((same and -20<=delta<=7*24*60) or (sender & to and -20<=delta<=72*60)): continue
        candidates.append(((0 if same else 1,abs(delta)),out,delta,same,to))
    candidates.sort(key=lambda value:value[0]); replies=[]
    for ri,(_,out,delta,same,to) in enumerate(candidates[:3],1):
        body,_=parts(out,1000)
        replies.append({"reply_id":f"R{ri}","same_thread":same,"minutes_after_inbound":round(delta),
                        "from":sorted(addr(out.get("from"))),"to":sorted(to),
                        "subject":clean(out.get("subject") or "")[:300],"body":body,
                        "confirmation_pdf_filename":None,
                        "confirmation_subject_candidate":"confirmation letter" in (out.get("subject") or "").casefold()})
    body,quoted=parts(r)
    packets.append({"case":f"N{index:02d}","cohort":"random","source_row_id":row_id,
                    "inbound":{"date":when.isoformat(),"from":sorted(sender),"subject":clean(r.get("subject") or "")[:300],
                               "message":body,"quoted_context":quoted},"candidate_replies":replies})
encoded=base64.b64encode(zlib.compress(json.dumps({"sample":packets},ensure_ascii=False).encode(),9))
folder=Path("/home/ubuntu/repos/zero/.private/mailbox-research-transfer")
folder.mkdir(mode=0o700,parents=True,exist_ok=True)
target=folder/(TOKEN+".b64")
try:
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"wb") as out:out.write(encoded)
    result=subprocess.run(["aws","s3api","put-object","--bucket",TRANSFER_BUCKET,
        "--key",TRANSFER_KEY,"--body",str(target),"--region",TRANSFER_REGION,
        "--expected-bucket-owner",TRANSFER_OWNER,"--server-side-encryption","AES256",
        "--query","ServerSideEncryption","--output","text"],capture_output=True,text=True,timeout=120)
    if result.returncode or result.stdout.strip()!="AES256": raise RuntimeError("private_transfer_upload_failed")
finally:
    target.unlink(missing_ok=True)
print(json.dumps({"key":TRANSFER_KEY,"bytes":len(encoded),
    "sha256":hashlib.sha256(encoded).hexdigest(),"server_side_encryption":"AES256",
    "sample":len(packets)}))
'''


def main():
    selection = json.loads(json.loads((PRIVATE / 'fresh-selection-ssm.json').read_text())['Stdout'])
    selected = selection['ids']
    old = json.loads((PRIVATE / 'packets-v4.json').read_text())['sample']
    existing = {case['source_row_id'] for case in old if case['cohort'] == 'random'}
    missing = [value for value in selected if value not in existing]
    for value in missing:
        uuid.UUID(value)
    if OUTPUT.exists():
        raise SystemExit('output already exists')
    encoded_ids = base64.b64encode(json.dumps(missing).encode()).decode()
    transfer_token = uuid.uuid4().hex
    expected_key = transfer_key(transfer_token)
    remote_code = (f'SNAPSHOT = {SNAPSHOT!r}\nIDS = {encoded_ids!r}\nTOKEN = {transfer_token!r}\n'
                   f'TRANSFER_KEY = {expected_key!r}\nTRANSFER_BUCKET = {TRANSFER_BUCKET!r}\n'
                   f'TRANSFER_REGION = {TRANSFER_REGION!r}\nTRANSFER_OWNER = {EXPECTED_BUCKET_OWNER!r}\n'
                   + REMOTE_CODE)
    payload = "python3 - <<'PY'\n" + remote_code + "\nPY"
    ensure_private_transfer_bucket()
    try:
        result = subprocess.run(['bash', str(ROOT / 'apps/server-pilot/deploy/ssm-run-command.sh'), payload],
                                text=True, capture_output=True, timeout=100)
        if result.returncode:
            raise SystemExit('SSM sample fetch failed')
        invocation = json.loads(result.stdout)
        if invocation.get('Status') != 'Success':
            raise SystemExit('SSM sample fetch did not succeed')
        metadata = json.loads(invocation['Stdout'].strip())
        compressed = fetch_payload(metadata, expected_key)
    finally:
        delete_transfer(expected_key)
    sample = json.loads(zlib.decompress(base64.b64decode(compressed, validate=True)))
    if len(sample['sample']) != len(missing):
        raise SystemExit('sample count mismatch')
    fd = os.open(OUTPUT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump({'snapshot': SNAPSHOT, 'frame_inbound': selection['frame'],
                   'sample': sample['sample']}, out, ensure_ascii=False, indent=2)
    print(json.dumps({'new_cases': len(missing),
                      'cases_with_reply_candidates': sum(bool(p['candidate_replies']) for p in sample['sample'])}))


if __name__ == '__main__':
    main()
