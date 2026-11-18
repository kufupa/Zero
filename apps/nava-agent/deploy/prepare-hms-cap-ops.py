#!/usr/bin/env python3
"""Prepare cap-aware copies; installing them is a separate operator action."""
from pathlib import Path
import subprocess
import sys

ops = Path(sys.argv[1] if len(sys.argv) > 1 else '/home/orca/.local/state/nava-v7-ops')
output = ops / 'hms-cap-ready'
output.mkdir(mode=0o700, exist_ok=True)
guard = "if(!['4','10'].includes(e.NAVA_HMS_SLOTS) || e.HMS_CREDENTIAL_SESSION_CAP!==e.NAVA_HMS_SLOTS)throw Error('invalid HMS caps');"
files = {
    'hotfix-close-intake.sh': [
        ("const e=process.env, sha=process.argv[2];", "const e=process.env, sha=process.argv[2];" + guard),
        ("NAVA_HMS_SLOTS:'4',HMS_CREDENTIAL_SESSION_CAP:'4',", ''),
    ],
    'start-reviewed-worker.sh': [
        ("const e=process.env, sha=process.argv[2];", "const e=process.env, sha=process.argv[2];" + guard),
        ("NAVA_HMS_SLOTS:'4',HMS_CREDENTIAL_SESSION_CAP:'4',", ''),
        ("console.log('identical_node_env_loader=PASS slots=4 lease_cap=4 prepare_only=1 save=absent sha='+sha);",
         "console.log('identical_node_env_loader=PASS slots='+e.NAVA_HMS_SLOTS+' lease_cap='+e.HMS_CREDENTIAL_SESSION_CAP+' prepare_only=1 save=absent sha='+sha);"),
    ],
}
for name, replacements in files.items():
    text = (ops / name).read_text()
    for old, new in replacements:
        if text.count(old) != 1:
            raise SystemExit(f'{name}: expected source pattern not found exactly once')
        text = text.replace(old, new, 1)
    destination = output / name
    destination.write_text(text)
    destination.chmod(0o700)
    subprocess.run(['bash', '-n', str(destination)], check=True)
    print(f'prepared={destination}')
