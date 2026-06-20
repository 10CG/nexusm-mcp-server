# Changelog

All notable changes to `@nexusm/mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [0.1.3] — 2026-06-20

### Fixed

- **NEXUS_API_URL `/v1` auto-normalization** (FU-MCP-API-URL-V1-SUFFIX): The
  MCP server previously passed `NEXUS_API_URL` straight through as the SDK
  `baseUrl`. When set to a bare origin (`http://localhost:8787`), the SDK
  would build `http://localhost:8787/memories` — a path the backend never
  mounts — producing a backend 404 surfaced to the MCP client as a misleading
  `InternalError/-32603`.

  `src/auth.ts` now exports `normalizeApiUrl(raw)` and calls it in
  `loadAuthConfig`. The helper trims whitespace, strips trailing slashes, and
  appends `/v1` when the path does not already end with it. The function is
  idempotent. When normalization appends `/v1`, one diagnostic line is written
  to stderr (never stdout — MCP stdio invariant).

  Bare-origin and local-proxy configurations (`http://localhost:8787`,
  `http://localhost:8787/`) now work without requiring users to add the `/v1`
  suffix manually.

---

## [0.1.2] — 2026-06-19

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
  the function logs a `console.error` warning and **resolves `null`** instead of
  letting the error propagate as an unhandled event that would crash the
  process.  Metrics are auxiliary — they must never crash or block the MCP
  transport.  A non-numeric `NEXUS_METRICS_PORT` is also rejected up front
  (previously coerced to `NaN` → silent ephemeral-port bind).

### Changed

- `startMetricsServer()` returns the listening `http.Server` (or `null` on
  skip/failure) so callers and tests can close the listener.
- The opt-in predicate is now the exported `shouldEnableMetrics(transportMode,
  env)` — a single source of truth imported by both `main()` and the unit tests
  so the decision cannot drift between code and tests.

> Follow-up (FU-MCP-METRICS-FAILLOUD, non-blocking): when metrics are
> *explicitly* opted in (server-side), a bind failure currently warns + resolves
> identically to the stdio auto-skip path. For a scraped server that is a silent
> observability gap; revisit escalating the signal once HTTP transport is no
> longer scaffold-only.

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
