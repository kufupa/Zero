---
title: Connect Pomerado to this Codex Azure provider
date: 2026-10-28
status: complete
---

# Connect Pomerado to this Codex Azure provider

## Goal and scope

Make the local Pomerado mint MCP available to this Codex session using the same Azure endpoint and credential as Codex, then establish readiness for the owner's separately described mint. Planning only: no configuration changes, model calls, mint, hotel access, or generated integration in this step.

The owner authorizes reuse of the existing Azure endpoint and key and states that the environment is approved for their data. Use the existing credential source; a value need not be copied to this plan, chat, or a configuration file. Do not assert a separately verified retention or compliance status from configuration alone.

## Starting point

- Codex's selected user-level provider is `azure`, uses a Responses API base URL ending in `/openai/v1`, and names `AZURE_FOUNDRY_API_KEY` as its credential variable. The active runtime's access to that variable remains to be checked.
- A global `pomerado` MCP entry already exists in the active Codex home. It uses a private Node 24 installation and the local integrations root; a direct MCP handshake returned all four mint tools and a blank-page Chromium launch succeeded. After the owner's Codex restart, this session exposes all four Pomerado tools.
- The installed `0.4.0-canary.446` package uses the OpenAI SDK's `OPENAI_BASE_URL` and `OPENAI_API_KEY`; an offline synthetic request showed the SDK forming the `/responses` URL. Pomerado's MCP currently forwards only `OPENAI_API_KEY`, not the Azure URL or Azure-named credential.
- The vendor defaults are `gpt-6.1-sol` for the minter and `gpt-6-luna` for Guardian and the outcome reviewer. Whether this Azure resource has those exact deployment names and accepts each required Responses feature is unknown.

## Work sequence

1. **Resolve configuration.** Read the active Codex provider's base URL and its credential-variable name from the existing user-level `config.toml`, considering active profile or runtime overrides. Identify how the Codex process obtains the named credential. Confirm the Pomerado server's actual environment can receive it; do not assume that a shell and the Codex host inherit the same environment. Reuse this endpoint and credential rather than provisioning resources or creating another key.
2. **Wire Pomerado only.** Update the existing `pomerado` MCP entry, preserving other servers and Codex's provider. Supply the Azure v1 base URL as Pomerado's `OPENAI_BASE_URL` and forward the Azure credential by name, mapping it to `OPENAI_API_KEY` in the Pomerado process. Keep Node 24, the integration root and the existing timeout. Ensure a missing endpoint or credential fails explicitly rather than falling back to OpenAI's public endpoint. Do not write credential values into config.
3. **Verify Azure compatibility.** First check the server configuration and run a synthetic offline request that confirms routing and credential-variable mapping without transmitting real credentials. Then use the existing Azure credential for small, non-sensitive Responses API probes for the minter and review deployment names, exercising the tool/schema and model request features Pomerado needs. Record endpoint identity, deployment, response status and any unsupported feature without logging the key. A generic model response alone is not proof a complete mint works. If names or features differ, report the exact failure and select an appropriate provider/deployment mapping; do not silently switch model or provider.
4. **Verify the updated Codex connection.** The four tools are already visible in this session. After changing the Azure configuration, check whether the running MCP server picked up its new environment; if it did not, the owner can reload or restart Codex and resume this conversation. Verify `mint`, `get_job`, `provide_input`, and `cancel_job` in the reloaded session. A configuration listing or direct handshake alone does not prove the running Codex session loaded the updated configuration.
5. **Handoff.** Report what is configured, the model and connection probe outcomes, and any remaining gap. Wait for the owner to describe the intended mint; do not start a public example, access a target site, or create an integration as part of this setup.

## Acceptance checks

- Pomerado's process receives the same Azure endpoint and key source as Codex, without changing other MCPs or storing the key in the config.
- Both stock model roles can complete representative Azure Responses requests, or the precise deployment/feature blocker is reported. The separate outcome-review path uses the configured review provider and must be covered when it is exercised.
- The current or reloaded Codex session can see all four Pomerado tools, and the server starts with the matching Chromium installation.
- No model traffic silently falls back to a different endpoint. No actual mint has run until the owner supplies the task.

## Evidence and caveats

- Pomerado's CLI composes the existing MCP server; its library exposes separate minter, Guardian and outcome-review provider hooks (`typescript/src/standalone/mcp-cli.ts`, `typescript/src/standalone/contracts.ts` in the Pomerado checkout).
- Microsoft documents the Azure v1 `/openai/v1/` endpoint and deployment names in the `model` field: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints.
- The local integration root is an existing symlink into the private Zero trial folder; leave it intact unless the owner chooses another location.
- Pomerado source supports local sign-in but a prior Centurion native attempt failed before publication; this setup plan does not claim the target login or full workflow is proven. See `docs/research/2026-10-28-pomerado-native-codex-trial.md`.

## Execution status — 2026-10-28

- Configured the existing MCP with the active Azure v1 endpoint and `AZURE_FOUNDRY_API_KEY`; other Codex settings were preserved. The three Pomerado model-provider hooks use the same Azure-backed provider.
- Both stock deployments (`gpt-6.1-sol` and `gpt-6-luna`) completed synthetic Responses/tool calls, including through the Agents SDK with Pomerado-style settings. Azure rejected Pomerado's `12h` cache breakpoint; the host launcher adapts it to `30m`, which passed the probes. This can change cache costs.
- The exact configured launcher completed an MCP handshake and exposed all four tools; missing endpoint/key and off-endpoint requests fail closed. Its package version is checked at startup. The existing integration root and Chromium install remain unchanged.
- A Codex reload is still required to replace the already-running MCP process. A full mint, website sign-in, and the outcome-review path have not been exercised.

After Codex restarted, all four Pomerado tools are visible in this session and `get_job` returned the expected unknown-job response. The running launcher has the selected Codex Azure endpoint and matching credential in its environment. No mint was started; an actual mint and outcome review remain untested.

On the owner's request, the launcher now maps every Pomerado model-provider role to Azure `gpt-6.1-terra` (the existing reasoning settings remain unchanged). Both original role model names were exercised through the real Agents provider and sent to Terra successfully. The new launcher exposed all four MCP tools in a fresh process. The current Codex MCP must be restarted before it uses the new mapping. No mint has been run.

The owner also requested `xhigh` reasoning for all three roles. The request adapter now enforces `xhigh`, including Pomerado per-turn configuration updates. Live synthetic Agents SDK calls for both stock role names reached Terra with `xhigh` and completed successfully. Pomerado internal usage labels can still reflect its original settings because the request adapter applies the override. The running Codex MCP still needs a restart.

After the subsequent Codex restart, the active Pomerado MCP process started after the Terra xhigh launcher update, uses the selected Azure endpoint and credential, and exposes all four tools. Hindsight MCP is disabled for Codex; its hooks are removed. No mint has run.
