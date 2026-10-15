"""Fake-only local MCP client. Launched inside seccomp no-network sandbox."""
from __future__ import annotations
import asyncio,json,os,sys
from pathlib import Path
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters,stdio_client

async def main():
 root=Path(__file__).resolve().parent
 params=StdioServerParameters(command=sys.executable,args=[str(root/"fake_foresee_server.py")],env={"PATH":os.environ.get("PATH",""),"HOME":os.environ.get("HOME",""),"NAVA_FAKE_AUDIT":os.environ["NAVA_FAKE_AUDIT"],"NAVA_EGRESS_AUDIT":os.environ["NAVA_EGRESS_AUDIT"]})
 async with stdio_client(params) as (read,write):
  async with ClientSession(read,write) as session:
   await session.initialize()
   response=await session.call_tool("quote_insurance",json.loads(sys.stdin.read()))
   if response.is_error:raise RuntimeError("local fake failed")
   text=next(item.text for item in response.content if isinstance(item,TextContent))
   print(json.dumps(json.loads(text),separators=(",",":")))
from mcp.types import TextContent
if __name__=="__main__":asyncio.run(main())
