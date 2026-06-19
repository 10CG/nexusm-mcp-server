/**
 * Prometheus metrics for the Nexus MCP server (US-037 Wave 2 TASK-014).
 *
 * Layer
 * =====
 * This file measures the **MCP protocol dispatch layer** — every `tools/call`
 * and `tools/list` JSON-RPC request the MCP server handles. It is NOT the
 * same as the Python-side `src/nexus/observability/metrics/mcp.py` which
 * measures the **backend REST attribution layer** (post-MCP-dispatch).
 *
 * Both metric families share the `nexus_mcp_*` prefix but observe different
 * events at different layers, so:
 *   - TS metric names use `nexus_mcp_tool_*` (this file)
 *   - Python metric names use `nexus_mcp_backend_*` (the backend mirror)
 *   - Alert rules and Grafana panels must NOT sum across both — they would
 *     double-count a single user action
 *   - See ADR-001 + Wave 2 mid_audit tech-lead Important #2 (2026-05-22)
 *
 * Design notes
 * ============
 * - Spins up an **independent** HTTP listener on `NEXUS_METRICS_PORT` (default
 *   9090) so the Prometheus scrape endpoint never touches stdin/stdout — the
 *   stdio MCP transport monopolises those streams.
 * - Uses `prom-client` for registry management; all metric instances are
 *   module-level singletons (CollectorRegistry deduplication).
 * - Cardinality guard (R2 ai D-5): the `client` label is limited to a fixed
 *   allowlist; anything outside the list is coerced to `'unknown'` and a
 *   separate debug counter tracks the raw string so operators can promote a
 *   client to the allowlist without restarting the server.
 *
 * Startup integration
 * ===================
 * Call `startMetricsServer()` once from `src/index.ts` main() — it is a
 * fire-and-forget async function that opens the HTTP port and logs to stderr.
 * (Parent session must wire this call; see TASK-014 note.)
 *
 * prom-client npm dep note
 * ========================
 * Add `"prom-client": "^15.1.0"` to `dependencies` in `package.json`.
 * This subagent does not modify package.json per task constraints.
 */

import * as http from 'node:http';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// ---------------------------------------------------------------------------
// 1. Isolated Prometheus registry
//    Using a custom registry so default-metrics labels (process, v8) stay
//    clean and tests can create isolated registries without global pollution.
// ---------------------------------------------------------------------------

export const registry = new Registry();

// Collect default Node.js process metrics into our registry.
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// 2. Allowlist for the `client` label (R2 ai D-5 cardinality guard)
// ---------------------------------------------------------------------------

const KNOWN_CLIENTS = new Set<string>(['claude-code', 'cursor', 'windsurf', 'cline', 'mcp-cli']);

/**
 * Normalise a raw client identifier to an allowlisted value.
 * Returns `'unknown'` if the client is not in the allowlist.
 */
function normaliseClient(raw: string): string {
  return KNOWN_CLIENTS.has(raw) ? raw : 'unknown';
}

// ---------------------------------------------------------------------------
// 3. Metric definitions
// ---------------------------------------------------------------------------

/**
 * nexus_mcp_tool_calls_total — counts every tools/call dispatch.
 *
 * Labels:
 *   tool   — MCP tool name (e.g. `nexus.memory_search`)
 *   status — `'success'` | `'error'` | `'not_implemented'`
 *   client — normalised client name from KNOWN_CLIENTS (or `'unknown'`)
 */
export const MCP_TOOL_CALLS_TOTAL = new Counter({
  name: 'nexus_mcp_tool_calls_total',
  help: 'Total number of MCP tool/call requests dispatched, labelled by tool name, outcome, and client identity',
  labelNames: ['tool', 'status', 'client'],
  registers: [registry],
});

/**
 * nexus_mcp_tool_duration_seconds — latency histogram per tool.
 *
 * Buckets cover sub-millisecond to 10 s to capture both local (fast) and
 * remote Nexus API (network-bound) call distributions.
 *
 * Labels:
 *   tool — MCP tool name
 */
export const MCP_TOOL_DURATION_SECONDS = new Histogram({
  name: 'nexus_mcp_tool_duration_seconds',
  help: 'Latency of MCP tool/call handler execution in seconds',
  labelNames: ['tool'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * nexus_mcp_tools_list_calls_total — counts every tools/list request.
 *
 * Labels:
 *   client — normalised client name
 */
export const MCP_TOOLS_LIST_CALLS_TOTAL = new Counter({
  name: 'nexus_mcp_tools_list_calls_total',
  help: 'Total number of MCP tools/list requests, labelled by client identity',
  labelNames: ['client'],
  registers: [registry],
});

/**
 * nexus_mcp_tool_description_version — Info-style gauge exposing the schema hash.
 *
 * Set to 1.0 with a `hash` label containing the first 8 characters of the
 * SHA-256 of the concatenated tool description strings.  Alerts fire when
 * the hash drifts between replicas or between server restarts.
 *
 * Labels:
 *   hash — 8-char hex prefix of SHA-256(all tool descriptions)
 */
export const MCP_TOOL_DESCRIPTION_VERSION = new Gauge({
  name: 'nexus_mcp_tool_description_version',
  help: 'Info metric: always 1, label hash identifies the tool-description schema version (SHA-256 prefix)',
  labelNames: ['hash'],
  registers: [registry],
});

/**
 * nexus_mcp_unknown_client_total — debug counter for cardinality guard.
 *
 * Incremented when a raw client name is not in KNOWN_CLIENTS.  The `raw`
 * label carries the original string so operators can identify clients to
 * add to the allowlist.
 *
 * Labels:
 *   raw — the raw client identifier as received (verbatim)
 */
export const MCP_UNKNOWN_CLIENT_TOTAL = new Counter({
  name: 'nexus_mcp_unknown_client_total',
  help: 'Debug counter: raw client identifiers that were not in the known-client allowlist',
  labelNames: ['raw'],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// 4. Public helper functions
// ---------------------------------------------------------------------------

/**
 * Record a tool/call dispatch.
 *
 * @param tool   - MCP tool name (e.g. `'nexus.memory_search'`)
 * @param status - outcome string (`'success'`, `'error'`, `'not_implemented'`)
 * @param client - raw client identifier; normalised internally against the allowlist
 */
export function emitToolCall(tool: string, status: string, client: string): void {
  const normClient = normaliseClient(client);
  MCP_TOOL_CALLS_TOTAL.inc({ tool, status, client: normClient });
  if (normClient === 'unknown') {
    emitUnknownClient(client);
  }
}

/**
 * Record a tools/list request.
 *
 * @param client - raw client identifier; normalised internally against the allowlist
 */
export function emitToolsList(client: string): void {
  const normClient = normaliseClient(client);
  MCP_TOOLS_LIST_CALLS_TOTAL.inc({ client: normClient });
  if (normClient === 'unknown') {
    emitUnknownClient(client);
  }
}

/**
 * Record an observation in the tool duration histogram.
 *
 * Call this with `tool` and the elapsed time in seconds.  Designed so callers
 * wrap their handler with `Date.now()` before/after and pass
 * `(end - start) / 1000`.
 *
 * @param tool        - MCP tool name
 * @param durationSec - elapsed time in seconds
 */
export function emitToolDuration(tool: string, durationSec: number): void {
  MCP_TOOL_DURATION_SECONDS.observe({ tool }, durationSec);
}

/**
 * Increment the debug counter for an unknown client.
 *
 * Called internally by `emitToolCall` and `emitToolsList`; exposed so callers
 * can also emit directly if they detect the anomaly before dispatching.
 *
 * @param rawName - raw client string that was not in the allowlist
 */
export function emitUnknownClient(rawName: string): void {
  MCP_UNKNOWN_CLIENT_TOTAL.inc({ raw: rawName });
}

/**
 * Register the tool-description schema hash in the Info gauge.
 *
 * Set this once during startup after the tool registry is built.  Pass the
 * first 8 hex characters of SHA-256(concatenated tool descriptions) as `hash`.
 *
 * @param hash - 8-char hex prefix of the schema hash
 */
export function setDescriptionHash(hash: string): void {
  MCP_TOOL_DESCRIPTION_VERSION.set({ hash }, 1);
}

// ---------------------------------------------------------------------------
// 5. Metrics HTTP server (independent of stdio/HTTP MCP transport)
// ---------------------------------------------------------------------------

/**
 * Start the Prometheus metrics scrape endpoint.
 *
 * Opens an HTTP server on `process.env.NEXUS_METRICS_PORT ?? 9090`.  The
 * server only handles `GET /metrics`; all other paths return 404.
 *
 * Design intent: metrics is a server-side scrape surface; it must never crash
 * the MCP transport.  Two guarantees:
 *   1. main() in index.ts only calls this function when metrics are explicitly
 *      opted in (NEXUS_METRICS_PORT set, or HTTP transport mode).
 *   2. If listen() fails (e.g. EADDRINUSE), this function logs a warning and
 *      resolves — it never rejects or throws — so the MCP transport continues.
 */
export async function startMetricsServer(): Promise<void> {
  const port = Number.parseInt(process.env.NEXUS_METRICS_PORT ?? '9090', 10);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        const output = await registry.metrics();
        const contentType = registry.contentType;
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(output);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`metrics collection error: ${msg}`);
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });

  await new Promise<void>((resolve) => {
    // Defensive: if the port is already in use (EADDRINUSE) or any other
    // listen error occurs, log a warning and resolve so main() can continue
    // starting the MCP transport.  Metrics are auxiliary — they must never
    // crash or block the primary MCP process.
    server.on('error', (err: NodeJS.ErrnoException) => {
      console.error(
        `nexusm-mcp-server metrics server failed to start on port ${port} (${err.code ?? err.message}) — metrics disabled, MCP transport unaffected`,
      );
      resolve();
    });

    server.listen(port, () => {
      console.error(`nexusm-mcp-server metrics listening on http://0.0.0.0:${port}/metrics`);
      resolve();
    });
  });
}
