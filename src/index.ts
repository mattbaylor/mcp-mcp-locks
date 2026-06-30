#!/usr/bin/env node

// mcp-mcp-locks — MCP server wrapping the mcp-locks CLI.
//
// Exposes mcp-locks operations as native MCP tools so AI agents in OpenCode,
// Claude Code, and other MCP clients can coordinate access to single-resource
// MCP instances (Playwright Chromium profiles, figma-desktop port, etc.)
// through their tool surface rather than shell invocation.
//
// All operations shell out to `mcp-locks --json` — this server is a thin
// adapter that keeps concurrency, owner detection, reaping, and state
// authority owned by the upstream binary.
//
// Repo:    https://github.com/mattbaylor/mcp-mcp-locks
// Wraps:   https://github.com/mattbaylor/mcp-locks
// License: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Path to the mcp-locks binary. Defaults to the unqualified name so it's
 * resolved against the spawned process's PATH; override with MCP_LOCKS_BIN
 * when the binary is installed somewhere PATH doesn't include (common in
 * sandboxed agent runtimes where the MCP server's environment is minimal).
 */
const MCP_LOCKS_BIN = process.env.MCP_LOCKS_BIN || "mcp-locks";

/**
 * Optional environment passthroughs. mcp-locks honors MCP_LOCKS_HOME,
 * MCP_LOCKS_STATE_DIR, MCP_LOCKS_REGISTRY_DIR for non-standard installs
 * (tests, devcontainers). The spawned process inherits the parent's env
 * by default; this is mostly documentation.
 */

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run mcp-locks with the given args. Always passes `--json` first so every
 * response is a structured envelope. Captures stdout/stderr/exit-code.
 *
 * Never throws on non-zero exit — the caller decides whether to surface as a
 * tool error or pass the envelope through. mcp-locks exit codes (per its
 * usage):
 *   0 success
 *   1 usage error
 *   2 denied (claim on owned, release with wrong owner, unknown instance)
 *   3 state lock acquisition timeout
 */
function runMcpLocks(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(MCP_LOCKS_BIN, ["--json", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("error", (err) => {
      // ENOENT etc. — surface as a clear error rather than a silent failure.
      reject(
        new Error(
          `Failed to spawn ${MCP_LOCKS_BIN}: ${err.message}. ` +
            `Set MCP_LOCKS_BIN env var if the binary lives outside the default PATH.`
        )
      );
    });

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Envelope shaping
// ---------------------------------------------------------------------------

interface EnvelopeOk {
  ok: true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

interface EnvelopeErr {
  ok: false;
  error: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  denied?: any;
}

type Envelope = EnvelopeOk | EnvelopeErr;

/**
 * Parse stdout as an mcp-locks JSON envelope. If parsing fails (binary
 * missing --json support, version mismatch), wrap the raw stdout in a
 * synthetic error envelope so the caller still gets a structured response.
 */
function parseEnvelope(stdout: string): Envelope {
  if (!stdout) {
    return { ok: false, error: "empty stdout from mcp-locks" };
  }
  try {
    return JSON.parse(stdout) as Envelope;
  } catch {
    return {
      ok: false,
      error:
        `mcp-locks did not return JSON. Either the installed binary predates ` +
        `--json support (upgrade to a version that includes it) or stdout was ` +
        `garbled. Raw stdout: ${stdout.slice(0, 500)}`,
    };
  }
}

/**
 * Render a tool response. Always returns the envelope plus the underlying
 * exit code and any stderr, so the agent sees both the structured outcome
 * and any diagnostics the CLI emitted (WARN: takeover messages, etc.).
 */
function toolResponse(result: RunResult) {
  const envelope = parseEnvelope(result.stdout);
  const payload = {
    ...envelope,
    exitCode: result.exitCode,
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new McpServer({
  name: "mcp-mcp-locks",
  version: "0.1.0",
});

// --- Tool: list -------------------------------------------------------------

mcp.tool(
  "list",
  "List all registered MCP instances and their current claim status. Returns an array of records: each includes instance name, owner (or null if free), owner_pid, claimed_at, expires_at, note, age_seconds, ttl_remaining_seconds, alive (PID liveness), and status (free|claimed|expired|dead_pid). Use this to see what's available before claiming.",
  {},
  async () => {
    const result = await runMcpLocks(["list"]);
    return toolResponse(result);
  }
);

// --- Tool: who --------------------------------------------------------------

mcp.tool(
  "who",
  "Get detail on a single MCP instance: who owns it, when it was claimed, how much TTL remains, and whether the owning PID is still alive. Exit code 0 if owned, 1 if free, 2 if the instance name is not registered. Useful before claiming to decide whether to wait, pick a different instance, or force-steal.",
  {
    instance: z
      .string()
      .min(1)
      .describe(
        "Instance name as registered in mcp-locks (e.g. 'playwright', 'playwright2', 'figma-desktop'). Use the `list` tool to discover registered instances."
      ),
  },
  async ({ instance }) => {
    const result = await runMcpLocks(["who", instance]);
    return toolResponse(result);
  }
);

// --- Tool: claim ------------------------------------------------------------

mcp.tool(
  "claim",
  "Acquire (or refresh) a lock on an MCP instance. Returns ok:true with action=claimed (fresh) or refreshed (same owner re-claiming). If another owner holds the lock, returns ok:false with error=denied and details about the current owner — pick a different instance or pass force=true to steal (use sparingly; the current holder will get unexpected behavior). Owner is auto-detected from the calling session (OpenCode run ID, Claude Code session ID, or shell PPID); pass explicit owner to override. Default TTL is 30 minutes.",
  {
    instance: z
      .string()
      .min(1)
      .describe("Instance name to claim (e.g. 'playwright2')."),
    ttl: z
      .string()
      .optional()
      .describe(
        "How long to hold the claim. Format: <number><unit> where unit is s/m/h, e.g. '30m', '2h', '45s'. Raw integers are interpreted as seconds. Defaults to 30m."
      ),
    note: z
      .string()
      .optional()
      .describe(
        "Free-form note attached to the claim, visible in list/who output. Useful for explaining why a long claim is held (e.g. 'PR #123 side-by-side comparison')."
      ),
    owner: z
      .string()
      .optional()
      .describe(
        "Explicit owner identifier. Omit to let mcp-locks auto-detect from the calling session's env vars. Pass to coordinate with a non-MCP caller or to take ownership on behalf of a different session."
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "Steal the lock from its current owner. The displaced owner is not notified and will get DENIED on its next operation. Use only with good reason."
      ),
  },
  async ({ instance, ttl, note, owner, force }) => {
    const args = ["claim", instance];
    if (ttl) args.push("--ttl", ttl);
    if (note) args.push("--note", note);
    if (owner) args.push("--owner", owner);
    if (force) args.push("--force");
    const result = await runMcpLocks(args);
    return toolResponse(result);
  }
);

// --- Tool: release ----------------------------------------------------------

mcp.tool(
  "release",
  "Release a previously-claimed lock so other sessions can claim it. Returns ok:true with action=released (or already_free if it wasn't claimed). If the lock is owned by someone else, returns ok:false with error=owner_mismatch — pass force=true to override (rare; usually a sign you should let the real owner finish). Owner is auto-detected the same way as claim.",
  {
    instance: z
      .string()
      .min(1)
      .describe("Instance name to release (e.g. 'playwright2')."),
    owner: z
      .string()
      .optional()
      .describe(
        "Explicit owner identifier. Omit to let mcp-locks auto-detect. Must match the current owner unless force=true."
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "Release even if the lock is owned by a different session. Use only when you know the actual owner is gone and cleanup didn't happen automatically."
      ),
  },
  async ({ instance, owner, force }) => {
    const args = ["release", instance];
    if (owner) args.push("--owner", owner);
    if (force) args.push("--force");
    const result = await runMcpLocks(args);
    return toolResponse(result);
  }
);

// --- Tool: reap -------------------------------------------------------------

mcp.tool(
  "reap",
  "Clean up expired claims, dead-PID claims (for session-based owners), orphaned Chromium processes from prior MCP runs, and stale SingletonLock files. Idempotent — safe to call any time. Returns counts of what was cleaned up. Run this if `doctor` reports reap_recommended=true, or after a client crash leaves locks/processes behind.",
  {},
  async () => {
    const result = await runMcpLocks(["reap"]);
    return toolResponse(result);
  }
);

// --- Tool: doctor -----------------------------------------------------------

mcp.tool(
  "doctor",
  "Report the health of mcp-locks: state file paths, active claim count, expired claims, dead-PID claims, Chromium process and SingletonLock counts, and whether reap is recommended. Use this for diagnostics when claims aren't behaving as expected, or as a quick liveness check.",
  {},
  async () => {
    const result = await runMcpLocks(["doctor"]);
    return toolResponse(result);
  }
);

// --- Tool: kill -------------------------------------------------------------

mcp.tool(
  "kill",
  "Kill Playwright-MCP Chromium processes on demand. Three modes: " +
    "(1) mode='orphans' — kills only Chromiums whose parent process is gone (PPID=init/launchd). Subset of what reap does. " +
    "(2) mode='all', safety='idle-only' — safe bulk cleanup. Refuses (ok:false, error='instances_claimed', exit 2) if any instance is currently claimed in mcp-locks state; otherwise kills every matching Chromium. Use end-of-day or after a known-clean checkpoint. " +
    "(3) mode='all', safety='force' — nuclear. Kills every matching Chromium regardless of claim state. Use only when you're certain nothing is in flight, or to recover from a stuck claim. " +
    "After a kill, the next *_browser_* MCP tool call against an affected slot fails once with 'Target page has been closed', then succeeds as the MCP server lazily respawns Chromium. " +
    "Per-instance kill (mode='instance') is NOT implemented in v1 — returns a clear error.",
  {
    mode: z
      .enum(["orphans", "all", "instance"])
      .describe(
        "Which kill mode. 'orphans' kills only orphaned Chromiums. 'all' kills every matching Chromium (requires safety flag). 'instance' is not implemented in v1."
      ),
    safety: z
      .enum(["idle-only", "force"])
      .optional()
      .describe(
        "Required when mode='all'. 'idle-only' refuses to kill if any instance is claimed (safe default). 'force' kills regardless of claim state (nuclear). Ignored for mode='orphans'."
      ),
    instance: z
      .string()
      .optional()
      .describe(
        "Required when mode='instance'. Currently returns a not-implemented error in v1."
      ),
  },
  async ({ mode, safety, instance }) => {
    const args = ["kill"];
    if (mode === "orphans") {
      args.push("--orphans");
    } else if (mode === "all") {
      args.push("--all");
      if (safety === "idle-only") {
        args.push("--idle-only");
      } else if (safety === "force") {
        args.push("--force");
      } else {
        // Surface the upstream's own error message rather than fabricating one
        // here — keeps the contract single-sourced in mcp-locks.
      }
    } else if (mode === "instance") {
      if (!instance) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "mode='instance' requires the 'instance' arg, but it's also not implemented in v1 — upstream will return a not-implemented error.",
                  exitCode: 1,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      args.push(instance);
    }
    const result = await runMcpLocks(args);
    return toolResponse(result);
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  // Sanity-check that mcp-locks is callable before connecting the MCP
  // transport — fail loudly here rather than silently registering broken tools.
  try {
    const check = await runMcpLocks(["doctor"]);
    if (check.exitCode !== 0) {
      console.error(
        `mcp-locks doctor exited with code ${check.exitCode}. ` +
          `stderr: ${check.stderr}`
      );
      // Don't exit — the tools will surface the error per call. But warn
      // loudly so the agent knows things are off from the start.
    }
  } catch (err) {
    console.error(
      `Could not invoke mcp-locks (${MCP_LOCKS_BIN}). ` +
        `Install from https://github.com/mattbaylor/mcp-locks or set ` +
        `MCP_LOCKS_BIN to the binary path. Underlying error: ${
          err instanceof Error ? err.message : String(err)
        }`
    );
    // Still register — the MCP client may want the error surfaced via tools.
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("mcp-mcp-locks MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
