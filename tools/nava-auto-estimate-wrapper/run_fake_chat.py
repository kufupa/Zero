"""Deterministic scripted demo over local fake MCP; timings are not Foresee latency."""
from __future__ import annotations
import asyncio,csv,json,os,sys,time,tempfile
from pathlib import Path
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters,stdio_client
from mcp.types import TextContent
ROOT=Path(__file__).resolve().parent
AUDIT_DIR=ROOT/".offline-audit";AUDIT_DIR.mkdir(exist_ok=True)
PROFILE=Path.home()/".hermes/profiles/nava-car/nava-auto-estimate"
FAKE_ARGS={"profile":{"zip_code":"94110","age":34,"auto":{"drivers":[{"relation":"self","years_licensed":15,"accidents":[],"violations":[]}],"vehicles":[{"year":2021,"make":"Toyota","model":"Prius","annual_mileage":8000}]}},"lines":{"auto":{"bi":"100/300","pd":100,"coll_deductible":500,"comp_deductible":500}}}
SCRIPTED_TURNS=[("User","I want a price for car insurance."),("Assistant","This simulated demo uses invented details only. Real estimates send selected details to Foresee; its published privacy notice says submitted estimate records are retained for 24 months. A real estimate requires accurate facts from an actual shopper. Want an offline-only demonstration?"),("User","Yes, offline only. Use a fictional adult driver and a five-year-old Prius."),("Assistant","Offline only: invented ZIP 94110, age 34, 2021 Toyota Prius, 8,000 miles per year, and sample auto limits. No data goes to Foresee."),("User","Run the simulated request."),("Assistant","Local fake service returned a simulated example, not an insurer estimate: Example Mutual (SIMULATED), $119.33 monthly, $1,432 annual. No carrier lookup occurred."),("User","Who powers real estimates?"),("Assistant","Nava is the demo interface; Foresee powers the real estimate service. Actual estimate forwarding is currently disabled until an exact-payload approval flow exists. Estimates are non-binding.")]
async def main():
 PROFILE.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix="nava-fake-audit-",dir=AUDIT_DIR) as temp_audit:
  audit=Path(temp_audit)/"audit.json"
  env={"PATH":os.environ.get("PATH",""),"HOME":str(Path.home()),"PYTHONPATH":str(ROOT),"NAVA_TEST_FAKE_UPSTREAM":"1","NAVA_FAKE_AUDIT":str(audit)}
  params=StdioServerParameters(command=sys.executable,args=[str(ROOT/"offline_fake_runner.py"),str(ROOT/"server.py")],env=env)
  timings=[];start=time.perf_counter()
  async with stdio_client(params) as (r,w):
   async with ClientSession(r,w) as session:
    t=time.perf_counter();await session.initialize();timings.append(("mcp_initialize",(time.perf_counter()-t)*1000))
    t=time.perf_counter();catalog=await session.list_tools();timings.append(("tools_list",(time.perf_counter()-t)*1000))
    assert [tool.name for tool in catalog.tools]==["get_auto_estimate"]
    t=time.perf_counter();response=await session.call_tool("get_auto_estimate",FAKE_ARGS);timings.append(("fake_estimate_tool_call",(time.perf_counter()-t)*1000))
  timings.append(("total_protocol_flow",(time.perf_counter()-start)*1000))
  assert not response.is_error
  result=json.loads(next(c.text for c in response.content if isinstance(c,TextContent)))
  assert result["result"]["simulated"] is True and audit.exists()
  assert json.loads(audit.read_text())=={"calls":1,"field_names":["lines","profile"]}
  egress=json.loads(audit.with_name("egress.json").read_text());assert egress["internet_socket_creation_blocked"] is True
 transcript=["# Simulated Nava Auto Estimate Chat","","**Offline fixture only.** Not a live model conversation or real insurance estimate. Fake details/result below never went to Foresee. Actual estimate forwarding is disabled until payload-bound human approval exists.",""]
 transcript.extend(f"**{role}:** {text}" for role,text in SCRIPTED_TURNS)
 (PROFILE/"simulated_conversation.md").write_text("\n\n".join(transcript)+"\n")
 with (PROFILE/"timings.csv").open("w",newline="") as f:
  writer=csv.writer(f,lineterminator="\n");writer.writerow(["phase","elapsed_ms","measurement_scope"]);writer.writerows((name,f"{ms:.1f}","local offline fake MCP; not Foresee latency") for name,ms in timings)
 print(json.dumps({"transcript":str(PROFILE/"simulated_conversation.md"),"timings":str(PROFILE/"timings.csv"),"fake_calls":1,"simulated":True,"foresee_quote_calls":0,"egress_blocked":True}))
if __name__=="__main__":asyncio.run(main())
