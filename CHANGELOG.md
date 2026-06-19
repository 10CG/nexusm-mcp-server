# Changelog

All notable changes to `@nexusm/mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Fixed

- **stdio metrics opt-in**: `main()` in `src/index.ts` no longer starts the
  Prometheus metrics HTTP server unconditionally.  The server is a scrape
  surface for server-side deployments; local stdio clients (Claude Code,
  Cursor, Windsurf running via `npx`) have no scraper and were crashing on
  port conflicts.  Metrics now start only when explicitly opted in:
  - `NEXUS_METRICS_PORT` env var is set (explicit opt-in for any transport), or
  - `NEXUS_MCP_TRANSPORT=http` (server-side deployment always wants metrics).
  - Default stdio + no `NEXUS_METRICS_PORT` → metrics skipped → no crash.

- **defensive metrics listen**: `startMetricsServer()` in `src/metrics.ts` now
  attaches an `'error'` listener to the HTTP server before calling `listen()`.
  If the port is already in use (`EADDRINUSE`) or any other bind error occurs,
  the function logs a `console.error` warning and **resolves** instead of
  letting the error propagate as an unhandled event that would crash the
  process.  Metrics are auxiliary — they must never crash or block the MCP
  transport.

---

## [0.1.1] — 2026-06-07

### Added

- Wave 2 TASK-014: Prometheus metrics server (`prom-client`).
  Counters: `nexus_mcp_tool_calls_total`, `nexus_mcp_tools_list_calls_total`,
  `nexus_mcp_unknown_client_total`. Histogram: `nexus_mcp_tool_duration_seconds`.
  Gauge: `nexus_mcp_tool_description_version` (schema hash).
- Cardinality guard for `client` label (KNOWN_CLIENTS allowlist).
- `tsconfig.typecheck.json` for strict type-check without emit.

### Changed

- Tool handlers wired to `@nexusm/sdk` 5.x (Wave 1+ TASK-007..010).

---

## [0.1.0] — 2026-05-25

### Added

- Wave 1 scaffold: stdio transport, 4 MVP tools (`nexus.context_retrieve`,
  `nexus.memory_search`, `nexus.memory_create`, `nexus.memory_feedback`),
  `NOT_IMPLEMENTED` stub handlers, auth middleware.
- Initial npm publish as `@nexusm/mcp-server@0.1.0`.
