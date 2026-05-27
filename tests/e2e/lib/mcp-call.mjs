#!/usr/bin/env node
/**
 * Shared MCP client helper for TASK-019 cross-client E2E replay scripts.
 *
 * Spawns @nexusm/mcp-server (default: published npm package via npx) and
 * exercises one tools/call round-trip with the given args, then prints
 * the structured result + exit. Used by `replay_<N>_<slug>.sh` scripts as
 * a thin reproducible driver.
 *
 * Usage (from replay shell scripts):
 *   node lib/mcp-call.mjs <tool-name> <args-json>
 *
 * Examples:
 *   node lib/mcp-call.mjs nexus.context_retrieve '{"user_id":"u1","query":"react hooks"}'
 *   node lib/mcp-call.mjs nexus.memory_create '{"user_id":"u1","content":"prefer TS strict"}'
 *
 * Server source selection (env var):
 *   MCP_SERVER_SRC=published  → npx -y @nexusm/mcp-server (default, true E2E)
 *   MCP_SERVER_SRC=local      → node ../../dist/index.js (fast dev iteration)
 *
 * Required server env vars (read by mcp-server's loadAuthConfig):
 *   NEXUS_API_URL, NEXUS_API_TOKEN, NEXUS_TENANT_ID
 *
 * Exit codes:
 *   0 — tools/call returned a result (even an error in the structured body)
 *   1 — protocol error (initialize failed, server crashed, etc.)
 *   2 — usage error (wrong args)
 *
 * Not a vitest test — this is a plain Node script invoked from bash for
 * reproducible re-record of demo videos / cross-client comparison runs.
 * Per TASK-019 deliverable: "tests/e2e/replay_<scenario>.sh × 5 (mcp-cli
 * 可重录脚本, R2.1 schema 演进时重录 GIF)".
 */

import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error('Usage: node mcp-call.mjs <tool-name> [args-json]');
  process.exit(2);
}
const [toolName, argsJsonRaw] = argv;
let toolArgs = {};
if (argsJsonRaw !== undefined && argsJsonRaw !== '') {
  try {
    toolArgs = JSON.parse(argsJsonRaw);
  } catch (e) {
    console.error(`args-json must be valid JSON: ${e.message}`);
    process.exit(2);
  }
}

// Server source: published npm package (default) or local dist.
const SERVER_SRC = process.env.MCP_SERVER_SRC || 'published';
let serverCommand, serverArgs;
if (SERVER_SRC === 'local') {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distPath = resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
  serverCommand = 'node';
  serverArgs = [distPath];
} else {
  // Default: pin to the version the plugin references, so replay is reproducible.
  const PKG = process.env.MCP_SERVER_PKG || '@nexusm/mcp-server@0.1.1';
  serverCommand = 'npx';
  serverArgs = ['-y', PKG];
}

// Fail fast if mcp-server env vars are missing — the server itself would
// process.exit(1) but a clearer error here saves debug time.
const requiredEnv = ['NEXUS_API_URL', 'NEXUS_API_TOKEN', 'NEXUS_TENANT_ID'];
const missing = requiredEnv.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('Set them and re-run. See tests/e2e/README.md.');
  process.exit(2);
}

// Transport: stdio (matches .mcp.json default per plugin Wave 3 Phase 1).
//
// cwd: when serverCommand=npx, run from os.tmpdir() to avoid npm's
// local-name-collision lookup. If npx is invoked with cwd inside the
// package's own source repo (i.e. /path/to/nexusm-mcp-server/...), npm
// detects the matching `name` in the local package.json and tries to
// resolve the bin via local node_modules/.bin/ — which doesn't have the
// symlink (npx -y skips local bin-link creation), so the shell falls
// through and exits 127 with "sh: 1: nexusm-mcp-server: not found".
// Running from /tmp sidesteps the entire local-package check.
// (For MCP_SERVER_SRC=local we already use an absolute `node <distPath>`
// invocation that's independent of cwd, but setting cwd uniformly keeps
// behaviour predictable across both code paths.)
const transport = new StdioClientTransport({
  command: serverCommand,
  args: serverArgs,
  cwd: tmpdir(),
  env: {
    ...process.env,
    // Strip MCP_SERVER_* env vars from child to avoid driver var leaking
    // into the server's own env (harmless but noisy).
    MCP_SERVER_SRC: undefined,
    MCP_SERVER_PKG: undefined,
  },
  stderr: 'inherit', // server logs go straight to our stderr for debug
});

const client = new Client({ name: 'tests-e2e-replay', version: '1.0.0' }, { capabilities: {} });

const start = Date.now();
try {
  await client.connect(transport);
  console.error(`[mcp-call] connected to MCP server in ${Date.now() - start}ms`);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  if (!toolNames.includes(toolName)) {
    console.error(`[mcp-call] tool "${toolName}" not found. Available: ${toolNames.join(', ')}`);
    process.exit(1);
  }

  const callStart = Date.now();
  const result = await client.callTool({
    name: toolName,
    arguments: toolArgs,
  });
  console.error(`[mcp-call] ${toolName} returned in ${Date.now() - callStart}ms`);

  // Print structured result as JSON on stdout (parseable by shell wrappers).
  console.log(JSON.stringify(result, null, 2));

  await client.close();
  process.exit(0);
} catch (err) {
  console.error(`[mcp-call] PROTOCOL ERROR: ${err.message}`);
  if (err.stack) console.error(err.stack);
  try {
    await client.close();
  } catch {
    /* ignore close errors */
  }
  process.exit(1);
}
