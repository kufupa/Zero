try {
  let response;
  for (let attempt=0;attempt<15;attempt++) {
    try {
      response=await fetch('http://127.0.0.1:3107/api/nava/v1/capabilities', {
        headers:{Authorization:`Bearer ${process.env.NAVA_API_TOKEN}`}, signal:AbortSignal.timeout(10_000),
      });
      break;
    } catch (error) {
      if (attempt===14) throw error;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  if (!response.ok) throw Error('CAPABILITIES_UNAVAILABLE');
  const caps=await response.json();
  if (caps.deployed_sha !== process.env.NAVA_DEPLOYED_SHA || caps.configured_hms_slots !== 10 ||
      caps.native_read_slot_cap !== 10 || caps.effective_hms_slots !== 10 ||
      caps.shared_native_admission_verified !== true) throw Error('CAPABILITIES_MISMATCH');
  console.log(`capabilities=PASS sha=${caps.deployed_sha} worker_slots=10 shared_slots=10 effective=10 verified=true`);
} catch {
  console.error('capabilities=FAIL');
  process.exitCode=1;
}
