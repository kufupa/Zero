// Run after both stacks have drained and stopped; the runtime file supplies the shared URL.
import { constants } from 'node:fs';
import { copyFile, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

try {
  const cap=process.argv[2], url=process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL;
  if (!['4','10'].includes(cap) || !url || /[\r\n\0]/.test(url)) throw Error('INPUT_INVALID');
  for (const unit of ['start','worker']) {
    try { execFileSync('systemctl',['is-active','--quiet',`nava-agent@${unit}.service`]); throw Error('NAVA_ACTIVE'); }
    catch (error) { if (error.message === 'NAVA_ACTIVE' || error.status !== 3) throw error; }
  }
  const pm2=JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8'}));
  if (pm2.some(app=>['http','worker','ai-worker','hms-ai-worker','remote-http'].includes(app.name) &&
      !['stopped','errored'].includes(app.pm2_env?.status))) throw Error('PILOT_ACTIVE');
  const root='/home/ubuntu/repos/zero/apps/server-pilot';
  const paths=[`${root}/.env.production`,`${root}/.env.remote-common`];
  const quoted=value=>`'${value.replace(/'/g,"'\\''")}'`;
  const updates=[];
  for (const path of paths) {
    const stat=await lstat(path);
    if (!stat.isFile() || stat.uid!==process.getuid() || (stat.mode & 0o777)!==0o600) throw Error('PILOT_ENV_PERMISSIONS');
    const lines=(await readFile(path,'utf8')).split(/\r?\n/)
      .filter(line=>!/^\s*(?:export\s+)?(?:HMS_CREDENTIAL_LEASE_DATABASE_URL|HMS_CREDENTIAL_SESSION_CAP)=/.test(line));
    while (lines.at(-1)==='') lines.pop();
    lines.push(`HMS_CREDENTIAL_LEASE_DATABASE_URL=${quoted(url)}`,`HMS_CREDENTIAL_SESSION_CAP=${quoted(cap)}`);
    updates.push({path,text:lines.join('\n')+'\n'});
  }
  for (const {path,text} of updates) {
    const suffix=`${Date.now()}-${process.pid}`;
    await copyFile(path,`${path}.before-hms-cap-${suffix}`,constants.COPYFILE_EXCL);
    const temp=`${path}.hms-cap-${suffix}`;
    await writeFile(temp,text,{mode:0o600,flag:'wx'});
    await rename(temp,path);
  }
  console.log(`pilot_shared_admission=configured cap=${cap} protected_files=2`);
} catch (error) {
  console.error(`pilot_shared_admission=FAIL reason=${/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'CONFIG_ERROR'}`);
  process.exitCode=1;
}
