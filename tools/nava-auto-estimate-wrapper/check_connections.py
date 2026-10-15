"""Profile/catalog + live upstream discovery checks. No tools/call is issued."""
from __future__ import annotations
import asyncio,json,subprocess
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async def live_discovery():
 async with streamable_http_client("https://mcp.go-foresee.com/mcp") as (r,w):
  async with ClientSession(r,w) as session:
   initialized=await session.initialize();catalog=await session.list_tools()
   quote=next((t for t in catalog.tools if t.name=="quote_insurance"),None)
   if quote is None:raise RuntimeError("Foresee quote_insurance missing")
   schema=quote.input_schema;profile=(schema.get("$defs") or {}).get("QuoteProfile",{})
   assert "profile" in schema.get("required",[])
   assert "zip_code" in profile.get("required",[])
   return {"initialized":bool(initialized.server_info.name),"tool_names":[t.name for t in catalog.tools],"quote_required":schema.get("required",[]),"profile_required":profile.get("required",[]),"quote_calls":0}

if __name__=="__main__":
 result=asyncio.run(live_discovery())
 p=subprocess.run(["hermes","-p","nava-car","mcp","list"],capture_output=True,text=True,timeout=60)
 if p.returncode:raise SystemExit("profile MCP listing failed")
 lines=p.stdout.splitlines();row=next((x for x in lines if "nava" in x.lower()),"")
 result["nava_server_configured"]="nava" in row.lower();result["nava_server_enabled"]="enabled" in row.lower();result["selected_tool_count_one"]="1 selected" in row
 print(json.dumps(result,separators=(",",":")))
