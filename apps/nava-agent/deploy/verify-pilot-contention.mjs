import { pathToFileURL } from 'node:url';

try {
  let expected='';
  for await (const chunk of process.stdin) expected+=chunk;
  if (!expected || process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL !== expected ||
      process.env.HMS_CREDENTIAL_SESSION_CAP !== '10' || !process.env.DATABASE_URL) throw Error('PILOT_CONFIG_MISMATCH');
  const { acquireCloudCredentialLease }=await import(pathToFileURL(process.argv[2]).href);
  for (const readOnly of [true,false]) {
    let lease;
    try {
      lease=await acquireCloudCredentialLease('HRCEN',{readOnly,priority:'staff',tryOnce:true});
    } catch (error) {
      if (error?.message === 'HMS_CREDENTIAL_LEASE_CONTENDED') continue;
      throw error;
    }
    await lease.release();
    throw Error('PILOT_ADMISSION_NOT_SHARED');
  }
  console.log('pilot_shared_admission=contended');
} catch {
  console.error('pilot_shared_admission=FAIL');
  process.exitCode=1;
}
