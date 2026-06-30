# mcp-mcp-locks

An [MCP](https://modelcontextprotocol.io) server that wraps the [`mcp-locks`](https://github.com/mattbaylor/mcp-locks) CLI, exposing its coordination primitives as native MCP tools.

**Use case:** Multiple AI agents (across OpenCode, Claude Code, devcontainer/sandboxed runtimes, etc.) need to coordinate access to MCP instances that hold exclusive OS resources — Playwright Chromium profile dirs, the figma-desktop port, any future single-resource MCP server. `mcp-locks` solves this via a host-global state file and a small bash CLI. This server makes its operations discoverable in every MCP client's tool surface, so an agent that's been told "use Playwright instance X" can also see `claim`/`release` as first-class tools rather than something to remember to shell out to.

## Why a wrapper?

The `mcp-locks` CLI works fine from a shell. But rules like "agents must claim before using" have been re-discovered as broken across many sessions because the agent has to know the convention exists and remember to invoke it. Exposing the operations as MCP tools puts them directly in the agent's function roster — claim/release/list/who become discoverable the same way `playwright_browser_navigate` is. Discoverability is the highest-leverage fix for "agent forgot the convention."

This server is **thin by design**: every tool shells out to `mcp-locks --json` and returns the structured envelope. State, locking, owner detection, and reaping all stay owned by the upstream binary (single source of truth).

## Prerequisites

- Node.js 20+
- [`mcp-locks`](https://github.com/mattbaylor/mcp-locks) installed and on PATH (or its path passed via the `MCP_LOCKS_BIN` env var). The wrapper requires a version that supports `--json` output.

## Install

```bash
git clone https://github.com/mattbaylor/mcp-mcp-locks.git
cd mcp-mcp-locks
npm install
npm run build
```

## Configure your MCP client

### OpenCode (`opencode.json` or `opencode.jsonc`)

```jsonc
{
  "mcp": {
    "mcp-locks": {
      "type": "local",
      "command": ["node", "/path/to/mcp-mcp-locks/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Claude Code (`.claude.json`)

```json
{
  "mcpServers": {
    "mcp-locks": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-mcp-locks/dist/index.js"]
    }
  }
}
```

### Custom `mcp-locks` binary location

If `mcp-locks` is not on the spawned process's PATH (common in sandboxed agent runtimes with minimal env), set `MCP_LOCKS_BIN`:

```jsonc
{
  "mcp": {
    "mcp-locks": {
      "type": "local",
      "command": ["node", "/path/to/mcp-mcp-locks/dist/index.js"],
      "enabled": true,
      "environment": {
        "MCP_LOCKS_BIN": "/Users/you/bin/mcp-locks"
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `list` | Array of all registered instances with current status, owners, TTLs |
| `who` | Detail on a single instance (free / claimed / expired / dead_pid) |
| `claim` | Acquire or refresh a lock (default 30m TTL); auto-detects owner |
| `release` | Release a claim; owner-checked unless `force: true` |
| `reap` | Clean up expired claims, dead-PID claims, orphaned Chromium, stale SingletonLocks |
| `doctor` | Health report; recommends reap when needed |
| `kill` | Kill Playwright-MCP Chromium processes on demand (`mode: 'orphans' \| 'all' \| 'instance'`, plus `safety: 'idle-only' \| 'force'` for `all` mode). Per-instance kill is not implemented in v1. |

Every tool returns the upstream `mcp-locks --json` envelope augmented with `exitCode` and (if present) `stderr`:

```json
// success
{ "ok": true, "data": { ... }, "exitCode": 0 }

// denied
{ "ok": false, "error": "denied", "denied": { ... }, "exitCode": 2 }
```

## Typical agent flow

```
1. agent calls list           -> sees which instances are free
2. agent calls claim          -> ok:true; agent proceeds with the corresponding browser tools
3. agent does its work
4. agent calls release        -> ok:true
```

For conflict cases:

```
1. agent calls claim playwright2
2. response: { ok: false, error: "denied", denied: { current_owner: "...", ttl_remaining_seconds: 1200 } }
3. agent either: claims a different instance, waits, or asks the human whether to force-steal
```

## Sub-agent pattern

When dispatching a sub-agent to do parallel work:

- **Parent claims** the instance and passes the assigned name to the sub-agent
- **Sub-agent uses** the assigned instance's browser tools (e.g. `playwright3_browser_*`)
- **Sub-agent does NOT** call `claim` or `release` — the parent owns the lifecycle

This avoids the sub-agent's claim expiring mid-work due to a TTL shorter than the parent's task.

## How it relates to `mcp-locks`

This server is one of several possible interfaces to the underlying coordination layer. Other valid callers:

- The `mcp-locks` CLI directly from a shell or script
- Any tool reading the state file at `~/.local/state/mcp-locks/state.json` (read-only; never write)
- CI scripts that gate execution on a lock

All callers share the same state and the same concurrency guarantees — this wrapper doesn't add a second source of truth.

## License

MIT
