# Exa MCP and Dynamic Highlights audit — 2026-10-19

## Conclusion

Claude Code, Cursor CLI, Antigravity CLI, and Codex CLI do not share one local MCP registry. They have four separate user-global Exa registrations that point to the same hosted Exa MCP URL and explicit four-tool allowlist. Read-only comparison found that all four resolve to the same actual API key. Three use the `EXA_API_KEY` environment reference; Antigravity stores the same key inline in its config.

The current hosted tool surface does not expose Dynamic Highlights. Exa's Search API feature requires both `contents.highlights.dynamic: true` and `Exa-Beta: dynamic-highlights-2026-08-28`. The inspected upstream Exa MCP search implementation sends ordinary highlights, not the dynamic field or beta header. A client config or CLI version bump cannot add this request behavior. The hosted MCP's deployed version is vendor-managed and not exposed in these registrations.

## Evidence

| Question | Read-only observation | Interpretation / limit |
|---|---|---|
| What is installed? | `claude` 2.1.304; `cursor-agent` 2026.10.18-ea085cb; `agy` 1.4.2; `codex` 0.163.0. `cursor` is the IDE launcher, not the installed Cursor CLI. | Antigravity's command on this host is `agy`. These binary versions are not the Exa hosted MCP version. |
| Where is Exa registered? | Claude Code user config (`~/.claude.json`); Cursor user config (`~/.cursor/mcp.json`); Antigravity user config (`~/.gemini/config/mcp_config.json`); Codex user config (`~/.codex/config.toml`). | Separate client-specific registrations; no project Exa entry was found in the inspected Zero worktree. |
| Do they target the same server/tools? | All four point to `https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run`. The client-reported names include those four tools. Claude, Antigravity, and Codex reported ready; Cursor successfully returned the tool list. | Same hosted endpoint and allowlist, but not a shared config file. Readiness is a dated snapshot. |
| Do they share the key? | Claude references `$EXA_API_KEY`; Cursor references `${env:EXA_API_KEY}`; Codex maps its HTTP header to `EXA_API_KEY`; Antigravity's inline value compared equal to the current process's `EXA_API_KEY`. Comparison output contained only equality booleans, never the credential. | Yes, on this host at audit time. The environment variable was present in the current CLI process; its durable provisioning source was not established. |
| Does the current Exa MCP support Dynamic Highlights? | Cursor's `tools/list` schema had no `dynamic`, `contents`, or beta option. Upstream simple search builds `contents: { highlights: true }`; upstream advanced search exposes standard highlight controls and its request path has no dynamic field/header. | No, not through the observed hosted MCP surface. The hosted implementation can change without a local version signal. |
| What API contract is needed? | Exa's Dynamic Highlights docs specify `contents.highlights.dynamic: true` plus `Exa-Beta: dynamic-highlights-2026-08-28`; the feature is a research preview. No stable preview-rejection signature was established. | Both body and header must be sent. Do not guess an error classifier or retry/downgrade; use the pinned unmodified upstream package as operational rollback. |
| What is “latest”? | npm registry reported `exa-mcp-server` `3.4.1` as latest at audit time; GitHub Releases had no published release signal, and a tag lookup found no `3.4.1`/`v3.4.1` tag. The published package supports Node >=20, stdio, `EXA_API_KEY`, and an `ENABLED_TOOLS` allowlist; npm `latest` is mutable. This host had Node `v22.23.1` / npm `10.9.8`. | Recheck npm and source when implementing. Record tarball integrity and prove source-to-package mapping before patching. `3.4.1` is a local-package baseline, not proof of the hosted endpoint's deployed version. |
| Can the package preserve the tool set and restrict process env? | Upstream stdio reads `EXA_API_KEY` and `ENABLED_TOOLS` (with `TOOLS` as an alias); its package README documents optional `web_search_advanced_exa` and `agent_run`. | Configure the explicit four-tool allowlist. A launcher/env boundary must be tested against the published package; do not blindly pass unrelated ambient secrets. |
| Where can the package live? | No existing local host-tools repo for this adapter was found; the Zero repo's guidance says host tooling does not belong in product code. `/home/orca/projects/exa-mcp-dynamic-highlights` is currently absent. | Plan proposes a dedicated host-owned Git repository there, created only during explicitly authorized implementation. |
| How should preview rejection work? | The preview docs specify the body field and beta header, but the research did not establish a stable error signature that safely means “unsupported preview.” | Do not guess a classifier or silently downgrade. Surface a sanitized error and use the pinned upstream package as operational rollback. |
| Was any config changed? | No. This pass read configs and CLI status only. No API key was printed or saved to this report. | Planning/research only. |

## Method

- Read the installed CLIs' help and MCP status/list commands, with output handling that did not display credential values.
- Compared the four user-global config shapes and normalized endpoint/tool query. Compared the configured key values to the current process environment without printing either side.
- Retrieved the live tool schema through Cursor CLI and checked connection status through all four clients.
- Read Exa's Dynamic Highlights, hosted MCP, and client MCP documentation; inspected the Exa MCP npm metadata/README, stdio entry point/environment configuration, relevant upstream search sources, Node/npm versions, npm install prefix, and matching Git tags/releases.
- Did not edit client configs, install packages, rotate credentials, invoke Exa Agent, or run a live search on behalf of a client.

## Costs and limits

No Exa Agent call or client-side Exa search was run during this audit. The research-search tool displayed `$0.007` for one search result; aggregate research-search spend was not exposed. This audit does not establish the durable source that provisions `EXA_API_KEY`, whether every future GUI-launched client inherits it, or the current deployed version behind Exa's hosted MCP endpoint.

## Sources

- Exa [Dynamic Highlights API reference](https://exa.ai/docs/search/highlights) and [research-preview announcement](https://exa.ai/blog/dynamic-highlights).
- Exa [hosted MCP reference](https://exa.ai/docs/reference/exa-mcp); [`exa-mcp-server` npm latest metadata](https://registry.npmjs.org/exa-mcp-server/latest) and [package README](https://github.com/exa-labs/exa-mcp-server/blob/main/README.md).
- Exa source: [`package.json`](https://github.com/exa-labs/exa-mcp-server/blob/main/package.json), [`stdio.ts`](https://github.com/exa-labs/exa-mcp-server/blob/main/src/stdio.ts), [`stdio-cli.ts`](https://github.com/exa-labs/exa-mcp-server/blob/main/src/stdio-cli.ts), [`webSearch.ts`](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/webSearch.ts), and [`webSearchAdvanced.ts` at inspected commit](https://github.com/exa-labs/exa-mcp-server/blob/ad888a188cdefbe832c9feed2c3a97d1cb93cb35/src/tools/webSearchAdvanced.ts).
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp); [Cursor CLI MCP docs](https://cursor.com/docs/cli/mcp); [Antigravity CLI MCP docs](https://antigravity.google/docs/cli/mcp/); [Codex MCP docs](https://developers.openai.com/codex/mcp/).

## Refresh triggers

Recheck the Exa package/API source and preview header immediately before implementation. Refresh client config behavior if any of the four CLIs changes MCP transport, child-process environment inheritance, or user-global config handling. Do not treat this dated local status as authorization to change any client config.
