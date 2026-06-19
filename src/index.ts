#!/usr/bin/env node
/**
 * @nexusm/mcp-server — MCP server entry point.
 *
 * Exposes 4 MVP tools (nexus.context_retrieve, nexus.memory_search,
 * nexus.memory_create, nexus.memory_feedback) over the Model Context
 * Protocol. Schemas are locked in
 * `openspec/changes/us-037-mcp-server-exposure/proposal.md` §"R2 工具 Schema 锁定".
 *
 * Transport selection (proposal §M-14 dual transport):
 *   - Default: stdio (StdioServerTransport)
 *   - Optional: Streamable HTTP via env var `NEXUS_MCP_TRANSPORT=http`
 *
 * SDK package note: package.json depends on `@modelcontextprotocol/sdk`
 * ^1.29 (v1 single package). The proposal §52 mentions a future v2 split
 * (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`); when the
 * SDK migrates, update the import subpaths below — schema definitions and
 * handler shapes are insulated in `src/tools/`.
 *
 * Logging discipline: stdio transport multiplexes JSON-RPC over stdin/stdout,
 * so ALL diagnostic output must go to stderr (`console.error`). Never write
 * to stdout outside the transport.
 *
 * Wave 1 (TASK-003): tool handlers return NOT_IMPLEMENTED. Wave 1+ (TASK-007..010)
 * wires each handler to nexus-sdk-js. Auth (TASK-004) lives in src/auth.ts.
 */

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { tools, toolsByName } from './tools/index.js';
import {
  startMetricsServer,
  shouldEnableMetrics,
  emitToolCall,
  emitToolDuration,
  emitToolsList,
} from './metrics.js';

/**
 * Extract the calling MCP client identifier from a request, with fallback.
 *
 * MCP `request._meta.clientInfo.name` is the standard JSON-RPC carrier when
 * the client cooperates (Claude Code, Cursor, mcp-cli all set it). When the
 * field is missing, fall back to env var `NEXUS_MCP_CLIENT_NAME` (set by
 * launchers that wrap nexusm-mcp-server) and finally `unknown`. Cardinality
 * is guarded inside `metrics.ts` via a whitelist (R2 ai D-5).
 */
function extractClient(request: { _meta?: { clientInfo?: { name?: unknown } } }): string {
  const fromMeta = request._meta?.clientInfo?.name;
  if (typeof fromMeta === 'string' && fromMeta.length > 0) {
    return fromMeta;
  }
  const fromEnv = process.env.NEXUS_MCP_CLIENT_NAME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'unknown';
}

// Read version from package.json without `import assert` (Node 18+ compat).
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const SERVER_NAME = 'nexus';
const SERVER_VERSION = pkg.version;

function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list — return the locked input/output schemas verbatim.
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    emitToolsList(extractClient(request as { _meta?: { clientInfo?: { name?: unknown } } }));
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      })),
    };
  });

  // tools/call — dispatch to handler by tool name. Unknown tool names surface
  // as protocol-level errors (per CallToolResult spec: "errors in _finding_
  // the tool ... should be reported as an MCP error response").
  // Wraps emitToolCall + emitToolDuration around the handler so metrics fire
  // on both success + failure (R1 mid_audit C-2 + tech-lead Important #1).
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const client = extractClient(request as { _meta?: { clientInfo?: { name?: unknown } } });
    const tool = toolsByName.get(name);
    if (!tool) {
      emitToolCall(name, 'unknown_tool', client);
      throw new Error(`Unknown tool: ${name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const startNs = process.hrtime.bigint();
    try {
      const result = await tool.handler(args);
      emitToolCall(name, 'success', client);
      return result;
    } catch (err) {
      emitToolCall(name, 'error', client);
      throw err;
    } finally {
      const durNs = process.hrtime.bigint() - startNs;
      emitToolDuration(name, Number(durNs) / 1e9);
    }
  });

  return server;
}

async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`nexusm-mcp-server ${SERVER_VERSION} listening on stdio`);
}

async function startHttp(server: Server): Promise<void> {
  // Lazy import so stdio installs aren't forced to bundle the HTTP transport.
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createServer: createHttpServer } = await import('node:http');

  const port = Number.parseInt(process.env.NEXUS_MCP_HTTP_PORT ?? '3000', 10);
  // TODO(wave-2): per-request `server.connect()` + per-request transport
  // is scaffold-only. Production HTTP transport needs session-keyed Server
  // lifecycle per MCP spec (see TASK-014 integration tests + TASK-018
  // middleware in detailed-tasks.yaml).
  const httpServer = createHttpServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, () => {
    console.error(`nexusm-mcp-server ${SERVER_VERSION} listening on http://0.0.0.0:${port}/`);
  });
}

async function main(): Promise<void> {
  const server = createServer();
  const transportMode = (process.env.NEXUS_MCP_TRANSPORT ?? 'stdio').toLowerCase();

  // Metrics opt-in: the Prometheus scrape endpoint is a server-side deployment
  // concern.  In local stdio mode (the common case for Claude Code / Cursor /
  // Windsurf users running `npx @nexusm/mcp-server`) nobody scrapes :9090, and
  // binding an extra port risks EADDRINUSE crashes on developer machines.
  // Default stdio + no NEXUS_METRICS_PORT → metrics skipped → no crash.
  // The decision lives in shouldEnableMetrics() (single source of truth, also
  // unit-tested) so the predicate cannot drift between code and tests.
  if (shouldEnableMetrics(transportMode)) {
    await startMetricsServer();
  }

  if (transportMode === 'http') {
    await startHttp(server);
  } else if (transportMode === 'stdio') {
    await startStdio(server);
  } else {
    console.error(`Unknown NEXUS_MCP_TRANSPORT="${transportMode}" (expected "stdio" or "http")`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Never let an unhandled error leak credentials. stderr only.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`nexusm-mcp-server fatal: ${msg}`);
  process.exit(1);
});
