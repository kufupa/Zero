"""Local-only fake Foresee MCP server, test-only."""
from __future__ import annotations
import asyncio,json,os,socket
from pathlib import Path
from typing import Any
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult,ListToolsResult,TextContent,Tool
from fake_foresee import FAKE_RESULT
AUDIT_PATH=Path(os.environ["NAVA_FAKE_AUDIT"])
async def _list_tools(_context:Any,_params:Any)->ListToolsResult:
 return ListToolsResult(tools=[Tool(name="quote_insurance",description="Local fixture only",input_schema={"type":"object","properties":{"profile":{"type":"object"},"lines":{"type":"object"}},"required":["profile","lines"],"additionalProperties":False})])
async def _call_tool(_context:Any,params:Any)->CallToolResult:
 if params.name!="quote_insurance":return CallToolResult(content=[TextContent(type="text",text="unsupported fake tool")],is_error=True)
 AUDIT_PATH.write_text(json.dumps({"calls":1,"field_names":sorted(params.arguments)}))
 return CallToolResult(content=[TextContent(type="text",text=json.dumps(FAKE_RESULT,separators=(",",":")))])
server=Server("fake-foresee",version="test-only",on_list_tools=_list_tools,on_call_tool=_call_tool)
async def main():
 try:socket.socket(socket.AF_INET,socket.SOCK_STREAM)
 except OSError:pass
 else:raise RuntimeError("test subprocess lacks Internet-socket block")
 Path(os.environ["NAVA_EGRESS_AUDIT"]).write_text(json.dumps({"internet_socket_creation_blocked":True}))
 async with stdio_server() as (read,write):
  await server.run(read,write,server.create_initialization_options())
 # The fake peer serves exactly one quote and then exits so nested MCP stdio
 # clients cannot orphan it after the outer response is delivered.
 sys.exit(0)
if __name__=="__main__":asyncio.run(main())
