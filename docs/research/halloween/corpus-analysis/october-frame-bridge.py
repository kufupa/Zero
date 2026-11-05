#!/usr/bin/env python3
"""Compare the old local corpus with fresh Centurion snapshots by day and IDs.

Only counts and hashes leave EC2. The optional private result supports a later
incremental export without silently mixing different corpus frames.
"""

import hashlib
import json
import os
import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
LOCAL = ROOT / '.private/halloween-centurion-data-d5ce222c-f68e-435b-84ad-f95dccab0945/corpus.jsonl'
RESULT = ROOT / '.private/centurion-opportunity-october-20261101/frame-bridge-audit.json'
START = '2026-09-25T22:00:00+00:00'
END = '2026-10-30T15:00:00+00:00'
SNAPSHOTS = ['centurion-nine-day-bfcd9949-591f-4c9a-b061-3679ec793b51',
             'centurion-nine-day-8774dd09-e874-46f8-bed7-a24e4c282711']


def summarize(groups):
    return {key: {'count': len(values),
                  'sha256': hashlib.sha256('\n'.join(sorted(values)).encode()).hexdigest()}
            for key, values in sorted(groups.items())}


def main():
    start, end = datetime.fromisoformat(START), datetime.fromisoformat(END)
    local = defaultdict(list)
    for line in LOCAL.open():
        record = json.loads(line)
        if record.get('recordType') != 'thread':
            continue
        for message in record.get('messages', []):
            try:
                when = datetime.fromisoformat(str(message.get('timestamp')).replace('Z', '+00:00'))
            except ValueError:
                continue
            if not start <= when < end:
                continue
            for row in message.get('sourceRows', []):
                private = row.get('privateMessage') or {}
                if ('active_transport' not in (row.get('scopeMembership') or []) or
                    (private.get('sourceMetadata') or {}).get('transportId') != 'transport-centurion'):
                    continue
                local[f'{when.date()}:{private.get("direction")}'].append(row['sourceRowId'])
    local = summarize(local)

    remote = '''import hashlib,json\nfrom collections import defaultdict\nfrom datetime import datetime\nfrom pathlib import Path\nbase=Path("/home/ubuntu/repos/zero/.private/connected-mailbox-corpus")\nstart=datetime.fromisoformat(START); end=datetime.fromisoformat(END); buckets=defaultdict(list)\nfor name in SNAPSHOTS:\n for line in (base/name/"messages.jsonl").open():\n  row=json.loads(line)\n  if row.get("scope")!="in_window" or not row.get("eventAt"): continue\n  when=datetime.fromisoformat(row["eventAt"].replace("Z","+00:00"))\n  if start<=when<end:buckets[f\'{when.date()}:{row.get("direction")}\'].append(row["id"])\nout={k:{"count":len(v),"sha256":hashlib.sha256("\\n".join(sorted(v)).encode()).hexdigest()} for k,v in sorted(buckets.items())}\nprint(json.dumps(out,separators=(",",":")))\n'''
    code = f'START={START!r}\nEND={END!r}\nSNAPSHOTS={SNAPSHOTS!r}\n' + remote
    command = "python3 - <<'PY'\n" + code + '\nPY'
    result = subprocess.run(['bash', str(ROOT / 'apps/server-pilot/deploy/ssm-run-command.sh'), command],
                            text=True, capture_output=True, timeout=100)
    if result.returncode:
        raise SystemExit('snapshot comparison failed')
    invocation = json.loads(result.stdout)
    if invocation.get('Status') != 'Success':
        raise SystemExit('snapshot comparison was not successful')
    fresh = json.loads(invocation['Stdout'])
    differences = [{'day_and_direction': key, 'local': local.get(key, {}).get('count', 0),
                    'fresh': fresh.get(key, {}).get('count', 0)}
                   for key in sorted(set(local) | set(fresh)) if local.get(key) != fresh.get(key)]
    audit = {'start': START, 'end': END, 'snapshots': SNAPSHOTS,
             'local': local, 'fresh': fresh, 'differences': differences}
    fd = os.open(RESULT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(audit, out, indent=2)
    print(json.dumps({'matching_day_direction_groups': len(set(local) | set(fresh)) - len(differences),
                      'differences': differences}))


if __name__ == '__main__':
    main()
