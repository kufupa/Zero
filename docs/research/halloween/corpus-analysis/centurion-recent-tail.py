#!/usr/bin/env python3
"""Fetch the late-October tail of a verified, read-only Centurion snapshot.

The old local corpus is already available. `october-frame-bridge.py` checks
which dates agree; this fetch supplies the dates that may differ. The SSM
output contains transfer metadata only. Cleaned messages move through the
private one-day S3 transfer path and are kept in owner-private files.
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
OUT = ROOT / '.private/centurion-opportunity-october-20261101/fresh-tail.json'
SNAPSHOT = 'centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711'

REMOTE_PREPARE = r'''
import base64,datetime,hashlib,html,json,os,re,subprocess,unicodedata,zlib
from html.parser import HTMLParser
from pathlib import Path

class Visible(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.parts=[]; self.hidden=[]
    def handle_starttag(self,tag,attrs):
        if tag in ("script","style"): self.hidden.append(tag); return
        if not self.hidden and tag in ("br","p","div","tr","td","li"): self.parts.append("\n")
    def handle_endtag(self,tag):
        if self.hidden and self.hidden[-1]==tag: self.hidden.pop()
        elif not self.hidden and tag in ("p","div","tr","td","li"): self.parts.append("\n")
    def handle_data(self,data):
        if not self.hidden:self.parts.append(data)

def clean(body,subject):
    text=body if isinstance(body,str) else ""
    if re.search(r"(?i)<(?:html|body|p|div|br|table)\b",text):
        parser=Visible();parser.feed(text);text="".join(parser.parts)
    text=html.unescape("".join(c for c in text if unicodedata.category(c)!="Cf"))
    text=text.replace("\r\n","\n").replace("\r","\n").replace("\xa0"," ")
    text=re.sub(r"(?i)\b(authori[sz]ation\s+code|card\s+(?:number|no)|card\s+expiry|expir(?:y|ation)\s+date|cvv|cvc|account\s+(?:number|no)|iban)\s*[:=]\s*[^\s]+",r"\1: [removed]",text)
    text=re.sub(r"https?://\S+","[link]",text,flags=re.I)
    text=re.sub(r"(?i)\b(password|passcode|pin|api[ _-]?key)\s*[:=]\s*\S+",r"\1: [removed]",text)
    if re.search(r"(?i)\b(?:otp|one[ -]time password|verification code|security code)\b",subject+" "+text):
        text=re.sub(r"(?im)^\s*(?=[a-z0-9-]{4,12}\s*$)(?=[a-z0-9-]*\d)[a-z0-9-]+\s*$","[verification code removed]",text)
        text=re.sub(r"(?i)\b(otp|passcode|password|pin|verification code|security code)(\s*(?:is|:|=)\s*)(?=[a-z0-9-]*\d)[a-z0-9-]{4,12}",r"\1\2[removed]",text)
    text=re.sub(r"[ \t]{2,}"," ",text)
    text=re.sub(r"\n{3,}","\n\n",text).strip()
    return text[:16000]

base=Path("/home/ubuntu/repos/zero/.private/connected-mailbox-corpus")
source=base/SNAPSHOT/"messages.jsonl"
start=datetime.datetime.fromisoformat("2026-10-29T00:00:00+00:00")
end=datetime.datetime.fromisoformat("2026-10-30T15:00:00+00:00")
records=[]
for line in source.open():
    row=json.loads(line)
    if row.get("scope")!="in_window" or not row.get("eventAt"):continue
    when=datetime.datetime.fromisoformat(row["eventAt"].replace("Z","+00:00"))
    if not start<=when<end:continue
    subject=str(row.get("subject") or "")
    records.append({"id":row["id"],"thread":row.get("threadId"),"when":row["eventAt"],
        "direction":row.get("direction"),"message_id":row.get("messageId"),
        "in_reply_to":row.get("inReplyTo"),"references":row.get("references"),
        "subject":subject[:300],"body":clean(row.get("textBody") or row.get("htmlBody") or "",subject),
        "from":row.get("from") or [],"to":row.get("to") or [],"cc":row.get("cc") or [],
        "raw_mime_present":bool(row.get("rawMimeLocator"))})
encoded=base64.b64encode(zlib.compress(json.dumps({"snapshot":SNAPSHOT,"records":records},ensure_ascii=False).encode(),9))
folder=Path("/home/ubuntu/repos/zero/.private/centurion-opportunity-research-transfer")
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
    "records":len(records)}))
'''


def ssm(command):
    result = subprocess.run(['bash', str(ROOT / 'apps/server-pilot/deploy/ssm-run-command.sh'), command],
                            text=True, capture_output=True, timeout=100)
    if result.returncode:
        raise RuntimeError('SSM command failed')
    invocation = json.loads(result.stdout)
    if invocation.get('Status') != 'Success':
        raise RuntimeError('SSM command not successful')
    return invocation['Stdout'].strip()


def main():
    if OUT.exists():
        raise SystemExit('private output already exists')
    token = uuid.uuid4().hex
    expected_key = transfer_key(token)
    code = (f'SNAPSHOT={SNAPSHOT!r}\nTOKEN={token!r}\n'
            f'TRANSFER_KEY={expected_key!r}\nTRANSFER_BUCKET={TRANSFER_BUCKET!r}\n'
            f'TRANSFER_REGION={TRANSFER_REGION!r}\nTRANSFER_OWNER={EXPECTED_BUCKET_OWNER!r}\n'
            + REMOTE_PREPARE)
    ensure_private_transfer_bucket()
    try:
        meta = json.loads(ssm("python3 - <<'PY\n" + code + "\nPY"))
        encoded = fetch_payload(meta, expected_key)
    finally:
        delete_transfer(expected_key)

    data = json.loads(zlib.decompress(base64.b64decode(encoded, validate=True)))
    if len(data.get('records', [])) != meta['records']:
        raise SystemExit('record count mismatch')
    fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
    print(json.dumps({'records': len(data['records']),
                      'compressed_transfer_bytes': meta['bytes']}))


if __name__ == '__main__':
    main()
