# Agents: MCP and CLI

Sluice is agent-neutral: anything that can run a command or speak MCP works.

## MCP server

```sh
pnpm build
node surfaces/mcp/bin/sluice-mcp.js       # stdio; SLUICE_CWD=<project> to point it at a repo
```

Claude Code:

```sh
claude mcp add sluice -- node /path/to/sluice/surfaces/mcp/bin/sluice-mcp.js
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.sluice]
command = "node"
args = ["/path/to/sluice/surfaces/mcp/bin/sluice-mcp.js"]
```

Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "sluice": { "command": "node", "args": ["/path/to/sluice/surfaces/mcp/bin/sluice-mcp.js"] } } }
```

Tools (see the [reference](/reference/cli#mcp-tools)): `sluice_gate_status`,
`sluice_gate_propose_scenarios`, `sluice_gate_run`, `sluice_rules_check`,
`sluice_work_claim`, `sluice_work_update`, `sluice_lease_sync`,
`sluice_inbox_ask`, `sluice_inbox_check`, `sluice_hello`.

Deliberately **not** tools: approving scenarios, approving step-up requests,
answering inbox decisions. Those stay with humans.

## Credentials

Give agents broker tokens, not real credentials:

```sh
sluice policy serve &                                   # holds the real tokens (env)
TOKEN=$(sluice policy grant --task CANCEL-1 --agent codex \
  --scope github:acme/billing:contents:read --scope github:acme/billing:pull_requests:write --ttl 900)
GITHUB_API_URL=http://127.0.0.1:4700/github GITHUB_TOKEN=$TOKEN codex …
```
