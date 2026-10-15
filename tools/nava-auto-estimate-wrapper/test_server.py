"""Acceptance tests: synthetic valid examples remain kernel-isolated."""
from __future__ import annotations
import asyncio,importlib.util,json,os,sys,tempfile,unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters,stdio_client
from mcp.types import TextContent
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("nava_wrapper_server",ROOT/"server.py");assert spec and spec.loader
wrapper=importlib.util.module_from_spec(spec);sys.modules[spec.name]=wrapper;spec.loader.exec_module(wrapper)
FAKE_ARGS={"profile":{"zip_code":"94110","age":34,"auto":{"drivers":[{"relation":"self","years_licensed":15,"accidents":[],"violations":[]}],"vehicles":[{"year":2021,"make":"Toyota","model":"Prius","annual_mileage":8000}]}},"lines":{"auto":{"bi":"100/300","pd":100,"coll_deductible":500,"comp_deductible":500}}}
class WrapperTests(unittest.TestCase):
 def test_schema_declares_nested_fields_types_and_required_coverage(self):
  schema=wrapper.tool_spec().input_schema;profile=schema["properties"]["profile"];auto=profile["properties"]["auto"]
  driver=auto["properties"]["drivers"]["items"];vehicle=auto["properties"]["vehicles"]["items"];coverage=schema["properties"]["lines"]["properties"]["auto"]
  self.assertEqual(wrapper.tool_spec().name,"get_auto_estimate");self.assertEqual(profile["required"],["zip_code","age","auto"])
  self.assertEqual(auto["required"],["vehicles"]);self.assertEqual(vehicle["required"],["year","make","model"])
  self.assertEqual(vehicle["properties"]["year"]["type"],"integer");self.assertEqual(vehicle["properties"]["make"]["type"],"string")
  self.assertFalse(driver["additionalProperties"]);self.assertEqual(set(coverage["required"]),wrapper.REQUIRED_COVERAGE)
  self.assertEqual(coverage["properties"]["bi"]["type"],"string")
 def test_unknown_identity_contact_and_nested_keys_rejected(self):
  for field in ({"first_name":"fake"},{"street_address":"fake"},{"vin":"fake"},{"unknown":"x"}):
   args=json.loads(json.dumps(FAKE_ARGS));args["profile"].update(field)
   with self.subTest(field=next(iter(field))),self.assertRaises(wrapper.InvalidInput):wrapper._validated_payload(args)
 def test_malformed_values_rejected(self):
  mutations=(lambda a:a["profile"].update(age=None),lambda a:a["profile"].update(zip_code="9411"),lambda a:a["profile"]["auto"].update(vehicles=[]),lambda a:a["profile"]["auto"]["vehicles"][0].pop("model"),lambda a:a["profile"]["auto"]["vehicles"][0].update(year="2021"),lambda a:a["profile"]["auto"]["vehicles"][0].update(year=None),lambda a:a["profile"]["auto"]["vehicles"][0].update(make=2021),lambda a:a["profile"]["auto"]["vehicles"][0].update(annual_mileage="lots"),lambda a:a["profile"]["auto"]["drivers"][0].update(age_first_licensed=-1),lambda a:a["lines"]["auto"].update(bi=200000),lambda a:a["lines"]["auto"].update(bi=None),lambda a:a["lines"]["auto"].update(bi=""),lambda a:a["lines"]["auto"].update(pd=-1),lambda a:a["lines"]["auto"].clear(),lambda a:a["lines"]["auto"].pop("bi"))
  for index,mutate in enumerate(mutations):
   args=json.loads(json.dumps(FAKE_ARGS));mutate(args)
   with self.subTest(mutation=index),self.assertRaises(wrapper.InvalidInput):wrapper._validated_payload(args)
 def test_live_forwarding_is_disabled_and_transport_not_called(self):
  async def run():
   with patch.object(wrapper,"streamable_http_client") as transport:
    with self.assertRaisesRegex(RuntimeError,"disabled"):await wrapper._call_foresee("quote_insurance",FAKE_ARGS)
    transport.assert_not_called()
  asyncio.run(run())
 def test_error_diagnostics_exclude_inputs_and_upstream_error(self):
  async def upstream(_tool,_args):raise ValueError("SENSITIVE-TEST-CANARY")
  async def run():
   stream=StringIO()
   with redirect_stderr(stream),self.assertRaisesRegex(RuntimeError,"not logged"):await wrapper.get_auto_estimate(FAKE_ARGS,upstream=upstream)
   self.assertNotIn("SENSITIVE-TEST-CANARY",stream.getvalue());self.assertNotIn("94110",stream.getvalue())
  asyncio.run(run())
 def test_offline_fake_protocol_flow_with_kernel_inet_block(self):
  async def run():
   with tempfile.TemporaryDirectory(prefix="nava-offline-") as tmp:
    audit=Path(tmp)/"audit.json";isolated=ROOT/".offline-audit";isolated.mkdir(exist_ok=True)
    env={"PATH":os.environ.get("PATH",""),"HOME":str(Path.home()),"PYTHONPATH":str(ROOT),"NAVA_TEST_FAKE_UPSTREAM":"1","NAVA_FAKE_AUDIT":str(audit)}
    params=StdioServerParameters(command=sys.executable,args=[str(ROOT/"offline_fake_runner.py"),str(ROOT/"server.py")],env=env)
    with patch.dict(os.environ,{"NAVA_TEST_FAKE_UPSTREAM":"1","NAVA_FAKE_AUDIT":str(audit)}):
     async with stdio_client(params) as (read,write):
      async with ClientSession(read,write) as session:
       await session.initialize();self.assertEqual([x.name for x in (await session.list_tools()).tools],["get_auto_estimate"])
       response=await session.call_tool("get_auto_estimate",FAKE_ARGS);self.assertFalse(response.is_error)
       result=json.loads(next(x.text for x in response.content if isinstance(x,TextContent)))
    self.assertEqual(json.loads(audit.read_text()),{"calls":1,"field_names":["lines","profile"]})
    self.assertTrue(json.loads(audit.with_name("egress.json").read_text())["internet_socket_creation_blocked"])
    self.assertTrue(result["result"]["simulated"]);self.assertEqual(result["estimate_type"],"non-binding estimate")
  asyncio.run(run())
if __name__=="__main__":unittest.main(verbosity=2)
