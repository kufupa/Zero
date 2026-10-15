"""Only enable local fake after explicit isolated test-process configuration."""
from __future__ import annotations
import asyncio,json,os,subprocess,sys
from pathlib import Path
from typing import Any
ROOT=Path(__file__).resolve().parent
async def call_fake_upstream(tool_name: str,arguments: dict[str,Any])->Any:
 if os.environ.get("NAVA_TEST_FAKE_UPSTREAM")!="1":raise RuntimeError("offline fake disabled")
 if tool_name!="quote_insurance":raise RuntimeError("unexpected fake tool")
 env={"PATH":os.environ.get("PATH",""),"HOME":os.environ.get("HOME",""),"NAVA_FAKE_AUDIT":os.environ["NAVA_FAKE_AUDIT"],"NAVA_EGRESS_AUDIT":str(Path(os.environ["NAVA_FAKE_AUDIT"]).with_name("egress.json"))}
 process=await asyncio.create_subprocess_exec(sys.executable,str(ROOT/"offline_fake_runner.py"),str(ROOT/"fake_client.py"),env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 stdout,stderr=await asyncio.wait_for(process.communicate(json.dumps(arguments).encode()),timeout=15)
 if process.returncode:raise RuntimeError("offline fake subprocess failed: "+stderr.decode(errors="replace")[-300:])
 return json.loads(stdout.decode())
