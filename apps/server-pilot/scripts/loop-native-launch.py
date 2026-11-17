import fcntl
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

os.umask(0o077)
run = Path(sys.argv[1]).resolve()
pilot = Path('/home/ubuntu/repos/zero/apps/server-pilot')
nodebin = Path('/home/ubuntu/.nvm/versions/node/v22.23.1/bin')
cleanup_complete = False
def trusted_pg_bin(directory):
    try:
        for path in [directory, *directory.parents]:
            info = path.lstat()
            sticky_tmp = path == Path('/tmp') and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o022 and not sticky_tmp):
                return False
        for name in ('initdb', 'pg_ctl'):
            info = (directory / name).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022 or not info.st_mode & 0o111:
                return False
        return True
    except OSError:
        return False

pgbin = next((p for p in [Path(os.environ.get('LOOP_PGBIN', '/usr/lib/postgresql/16/bin')),
                           Path('/tmp/nava-pgtest-20261102.WzDOzKK2/unpacked/usr/lib/postgresql/16/bin')]
              if p.is_absolute() and trusted_pg_bin(p)), None)

def call(args, **kwargs):
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs).stdout
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"{Path(args[0]).name} exited {error.returncode}") from error

def main():
    global cleanup_complete
    pg = run / 'pg'
    request = json.loads((run / 'input.json').read_text())
    source_only = request.get('selectionOnly') or (request.get('candidate') or {}).get('kind') == 'mail_candidate'
    started = False
    try:
        isolated = ''
        if not source_only:
            if not pgbin:
                raise RuntimeError('isolated_postgresql_unavailable')
            password = secrets.token_hex(24)
            pwfile = run / 'pg-password'
            pwfile.write_text(password + '\n')
            os.chmod(pwfile, 0o600)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            call([str(pgbin / 'initdb'), '-D', str(pg), '--auth-local=trust', '--auth-host=scram-sha-256',
                  '--pwfile=' + str(pwfile), '--no-locale', '--encoding=UTF8'])
            pwfile.unlink()
            call([str(pgbin / 'pg_ctl'), '-D', str(pg), '-l', str(run / 'postgres.log'), '-o',
                  f'-k {run} -p {port} -c listen_addresses=127.0.0.1 -c ssl=off -c unix_socket_permissions=0700', '-w', 'start'])
            started = True
            isolated = f'postgresql://ubuntu:{quote(password)}@127.0.0.1:{port}/postgres?sslmode=disable'
        entries = json.loads(call([str(nodebin / 'pm2'), 'jlist']))
        http = [entry for entry in entries if entry.get('name') == 'http' and entry.get('pm2_env', {}).get('status') == 'online']
        if len(http) != 1:
            raise RuntimeError('deployed_http_not_available')
        raw = Path('/proc', str(http[0]['pid']), 'environ').read_bytes().split(b'\0')
        env = dict(item.decode().split('=', 1) for item in raw if b'=' in item)
        if not env.get('DATABASE_URL'):
            raise RuntimeError('deployed_lease_configuration_missing')
        env.pop('TEST_DATABASE_URL', None)
        env.pop('VITEST_ALLOW_PILOT_RDS', None)
        env.pop('NODE_OPTIONS', None)
        env.pop('NODE_CHANNEL_FD', None)
        env.pop('NODE_CHANNEL_SERIALIZATION_MODE', None)
        env.update(PATH=str(nodebin) + ':/home/ubuntu/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin',
                   LOOP_PILOT_ROOT=str(pilot), LOOP_ISOLATED_DATABASE_URL=isolated, NAVA_HMS_CHILD_PRIORITY='background')
        migrate = """import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
const db=postgres(process.env.LOOP_ISOLATED_DATABASE_URL,{max:1});
try { await migrate(drizzle(db),{migrationsFolder:'./drizzle'}); } finally { await db.end(); }
"""
        if not source_only:
            call([str(nodebin / 'node'), '--import', 'tsx', '--input-type=module', '-e', migrate], cwd=pilot, env=env, timeout=120)
        output = run / 'output'
        process = subprocess.Popen([str(nodebin / 'node'), '--import', 'tsx', str(run / 'runner.mjs'),
                                    str(run / 'input.json'), str(output)], cwd=pilot, env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        _, error = process.communicate()
        if process.returncode:
            match = re.search(rb'(?m)^Error: ([a-zA-Z0-9_:-]{1,100})$', error or b'')
            raise RuntimeError('native_case_failed' + (':' + match.group(1).decode() if match else ''))
        files = []
        fast_transfer = request.get('fastTransfer') is True
        for path in output.iterdir():
            entry = {'name': path.name, 'size': path.stat().st_size}
            if fast_transfer:
                bucket = env.get('S3_BUCKET')
                if not bucket:
                    raise RuntimeError('mail_storage_unavailable')
                uri = f's3://{bucket}/ops-dumps/loop-files/{run.name}/{path.name}'
                call(['aws', 's3', 'cp', str(path), uri, '--region', 'af-south-1', '--sse', 'AES256', '--only-show-errors'], env=env, timeout=120)
                entry['uri'] = uri
            files.append(entry)
        sha = call(['git', '-C', str(pilot), 'rev-parse', 'HEAD']).strip()
        print('LOOP_OUTPUT ' + json.dumps({'files': files, 'runtimeSha': sha}))
    finally:
        if started:
            call([str(pgbin / 'pg_ctl'), '-D', str(pg), '-m', 'fast', '-w', 'stop'], timeout=40)
        cleanup_complete = True
        shutil.rmtree(pg, ignore_errors=True)

try:
    with open('/home/ubuntu/.nava-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        main()
except Exception as error:
    marker = 'LOOP_ERROR ' if cleanup_complete else 'LOOP_UNCERTAIN '
    print(marker + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
    sys.exit(1)
finally:
    try:
        if cleanup_complete and json.loads((run / 'input.json').read_text()).get('fastTransfer') is True:
            shutil.rmtree(run, ignore_errors=True)
    except (OSError, ValueError):
        pass
