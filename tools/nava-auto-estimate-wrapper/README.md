# Nava-local auto estimate wrapper

One local stdio MCP server exposes only Nava-named `get_auto_estimate` to profile `nava-car`. It allows only fixed Foresee `quote_insurance` schema fields; however **real forwarding is disabled** until the host implements human confirmation bound to the exact payload and destination. `trust: untrusted` alone is not proof that a person approved the request.

## Run and test

```bash
python3 -m unittest discover -s tools/nava-auto-estimate-wrapper -p 'test_*.py' -v
python3 tools/nava-auto-estimate-wrapper/run_fake_chat.py
python3 tools/nava-auto-estimate-wrapper/check_connections.py
hermes -p nava-car mcp test nava
```

The unit/protocol test exercises the wrapper against a local fake fixture inside a subprocess that blocks Internet socket creation through seccomp; profile config never enables the fake flag. Fake ZIP, age, vehicle, limits, and insurer/price exist only in test code and the clearly labeled simulated transcript. Timings measure local fake MCP phases, never Foresee latency. The live connection checker issues only `initialize` and `tools/list`, without applicant inputs or `tools/call`.

The server accepts requests only over stdio. It does not store applicant values/results or log them; stderr timing diagnostics contain phase, elapsed milliseconds, and outcome. Foresee retains details sent in a real request under its published policy; a local wrapper does not make that data private/offline.

## Profile config

Registration is explicitly profile-scoped and exposes only `get_auto_estimate`, with resources, prompts, and sampling disabled:

```bash
hermes -p nava-car config set 'mcp_servers.nava' '{command: /home/ubuntu/hermes-releases/current/agent/venv/bin/python, args: [/home/ubuntu/projects/zero/tools/nava-auto-estimate-wrapper/server.py], timeout: 60, connect_timeout: 15, trust: untrusted, tools: {include: [get_auto_estimate], resources: false, prompts: false}, sampling: {enabled: false}}'
```

Never set `NAVA_TEST_FAKE_UPSTREAM=1` in profile config. Do not register Foresee directly in the profile. Existing `codegraph` and `exa` servers must remain unchanged.
