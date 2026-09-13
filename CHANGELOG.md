# Changelog

All notable changes to `@nexusm/mcp-server` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Fixed

- **The §M-3 HTTP→MCP error mapping never ran in production — every SDK
  failure surfaced as `InternalError`** (issue #32, the wider hole behind it).
  All four tool handlers gated the mapping behind `isAxiosLikeError(err)`, but
  `@nexusm/sdk` has wrapped every axios failure into its own typed classes
  (`ApiError` and subclasses, `TimeoutError`, `NetworkError`) since its v1.0.0
  rewrite — before this server ever pinned it (1.3.0). None of those carries
  `isAxiosError`, so a real 401 / 403 / 404 / 422 / 429 / 5xx fell through to
  the generic branch: `Unauthorized (-32011)`, `RateLimited (-32012)`,
  `retry_after_seconds` and `retryable` were unreachable, and a client could
  only ever see `-32603`. This is "never worked", not a regression. The unit
  and cross-substory tests were green because they rejected with
  `{ isAxiosError: true, ... }` fakes the SDK never throws.

  A second, independent link was dead on the wire: `@modelcontextprotocol/sdk`
  serialises a thrown handler error as
  `{ code: Number.isSafeInteger(err.code) ? err.code : -32603, message, data }`
  and `NexusError` had no `code` property — so even an error that *was* mapped
  correctly reached the client as `-32603`. `NexusError.code` now aliases
  `mcpErrorCode`; `toJSON()` is unchanged.

  Fix: one bridge, `mapSdkErrorToMcpError(err, toolName)` in `src/errors.ts`,
  used by every tool's catch block. It matches the SDK classes by `instanceof`
  (compile-time lock against a renamed class) with the SDK's documented `code`
  string as the fallback criterion, then feeds `mapHttpStatusToMcpError`. The
  old `isAxiosLikeError` path is kept only as a fallback for a raw axios error.

  - `UpstreamInterceptError` (SDK 5.2.0: auth edge / proxy answered instead of
    Nexus — a 3xx, or a 2xx whose body is not JSON) → `Unauthorized (-32011)`,
    `retryable=false`, `data.upstream_intercept=true`, `data.http_status`, and
    `data.redirect_host` / `data.content_type` lifted from the SDK message
    when present. The message says the request never reached Nexus and points
    at the local credential (e.g. an expired Cloudflare Access service token)
    or `NEXUS_API_URL` — it no longer looks like a Nexus outage. Distinguish it
    from a real 401 by `data.upstream_intercept`. No header, token or edge
    body is ever serialised.
  - `TimeoutError` → `RequestTimeout (-32001)`, `data.timeout=true`;
    `NetworkError` → `InternalError`, `data.network=true`. Both keep the SDK's
    own detail (`connect ECONNREFUSED 127.0.0.1:8001`) in the message.
  - `ApiError` family → the §M-3 table by `statusCode`;
    `RateLimitError.retryAfter` → `data.retry_after_seconds`.
  - `InputValidationError` (client-side zod) → `InvalidParams`.
  - Anything else → `InternalError`, `retryable=false`, message kept. It is
    deliberately **not** labelled `network=true` any more (three of the four
    handlers used to do that): "retry, Nexus is down" for an unknown failure
    is the same misdiagnosis #32 is about.

  Tests now construct the real `@nexusm/sdk` error classes (the `vi.mock`
  factories spread the original module so only `NexusClient` is faked), and a
  new loopback integration test (`tests/integration/sdk_error_bridge_loopback.test.ts`)
  drives the real SDK interceptor against a local HTTP server — 302, 200+HTML,
  401, 404, 429+Retry-After, 500, timeout, connection refused — through the
  tool handlers, plus one stdio round-trip asserting the JSON-RPC `error.code`
  a client actually receives.

### Changed

- `@nexusm/sdk` dependency raised to `^5.2.0` (lock: 5.0.0 → 5.2.0). `npx`
  users already resolved 5.2.0 through the old `^5.0.0` range, so the
  `UpstreamInterceptError` behaviour above was live on the user-facing surface
  before this server knew the class existed.

- **Unit tests no longer inherit the host machine's `NEXUS_*` environment**
  (issue #34). On a dev machine that has the nexus MCP plugin configured, the
  shell exports `NEXUS_API_URL` / `NEXUS_API_TOKEN` / `NEXUS_TENANT_ID` /
  `NEXUS_DEFAULT_USER_ID`; the vitest workers inherited them, so the code under
  test read the developer's live config instead of the fixtures the test set up.
  `npm run test:unit` was red on such machines (2 failed / 129 passed in
  `tests/unit/tools/memory_search.test.ts` — `resolveUserId` returned the host
  pin and overrode the `user_id` the test passed) while staying green on CI,
  where the runner environment is clean.

  Fix is structural rather than per-variable: `tests/setup/env-isolation.ts`
  strips every `NEXUS_*` / `MCP_*` key **by prefix** before each test file loads,
  then installs a small controlled baseline for the three vars `loadAuthConfig()`
  requires. A new variable added to `src/` later is covered automatically.
  Behaviour-changing optional vars (`NEXUS_DEFAULT_USER_ID`,
  `NEXUS_METRICS_PORT`, `NEXUS_MCP_*`) are deliberately left unset so tests
  exercise the default branches.

  `tests/unit/env_isolation.test.ts` locks the isolation, including a scan of
  `src/**` that fails if anyone adds an environment-variable read the policy
  does not cover.

  Test-only change — no runtime/`dist/` impact.

- **`npm test` runs the two config-driven passes instead of a bare `vitest run`**
  (review follow-up on the above). `setupFiles` hangs off `vitest.unit.config.ts`
  / `vitest.integration.config.ts`, which only the `--config` entry points load.
  Bare `vitest run` therefore got no isolation at all, while
  `tests/unit/env_isolation.test.ts` asserts the isolation is active — so this
  change made `npm test` fail even in a clean environment (on a clean checkout
  of the pre-fix branch head, with the four `NEXUS_*` vars unset: 1 failed /
  192 passed / 17 skipped), and RUNBOOK §5 named `npm test` as the local
  repro for the CI `test:unit` step. `test` is now
  `npm run test:unit && npm run test:integration` and `test:watch` carries
  `--config vitest.unit.config.ts`, so `npm test` is by construction the same
  surface CI runs.

  Two further deviations disappear with it, both from bare vitest using its
  default include glob instead of ours: a working-tree copy under
  `.claude/worktrees/<id>/` was being collected as real tests (every test ran
  twice — `.gitignore` does not affect vitest's default exclude), and
  `tests/unit/schema_sync.test.ts` ran despite `vitest.unit.config.ts`
  deliberately excluding it in favour of the deep version in
  `tests/integration/`.

- **The `src/**` coverage scan in `tests/unit/env_isolation.test.ts` no longer
  misses destructured reads.** `const { SOME_VAR } = process.env` — an idiomatic
  TS form — produces neither a property access nor a string literal, so it
  slipped past both existing patterns: injecting one into `src/metrics.ts` left
  the lock green while `src/` genuinely held an uncovered read. A third pattern
  covers the destructuring form (plain, renamed, and defaulted bindings), and the
  file walker's suffix whitelist widened from `.ts` only to
  `.ts/.mts/.cts/.js/.mjs/.cjs` so a non-TS helper landing in `src/` cannot take
  a whole file out of the scan. Re-running the same injection now fails the lock.

- **Meta-test failures no longer echo host environment values.** The baseline and
  cleanup assertions compared with `.toBe(value)` / `.toBeUndefined()`, which put
  the *received* side — the host machine's real value — into the assertion diff,
  and the set being asserted over includes `NEXUS_API_TOKEN`. The token stayed
  out of the output only because `Object.entries(UNIT_ENV_BASELINE)` happened to
  throw on `NEXUS_API_URL` first, which is incidental ordering, not a design.
  Both now compare outside the assertion and pass a boolean in; the message still
  names the offending key. Verified with canary values: the pre-fix file printed
  them, the current one produces zero occurrences across the full run output.
  Same lesson as the parent repo's `SecretStr` rule — one ordinary assertion
  failure is enough to put a credential into a CI job log.

- **Integration tests: same isolation, with `NEXUS_TEST_*` preserved** (those are
  the suite's deliberate inputs, injected as Forgejo secrets in CI). This also
  closes a latent leak in `tests/integration/mcp_protocol.test.ts`, which built
  the spawned server's environment from `{ ...process.env, <3 explicit
  overrides> }` — a host `NEXUS_DEFAULT_USER_ID` slipped through the spread and
  would have pinned `user_id` inside the server under E2E assertions that expect
  `e2e-test-user-001`.

### Removed

- `NEXUS_METRICS_DISABLED` from the E2E spawn environment in
  `tests/integration/mcp_protocol.test.ts`. It was a dead variable — nothing in
  `src/` ever read it, so the comment claiming it prevented metrics port
  conflicts was false. The real predicate is `shouldEnableMetrics()`: under
  stdio, metrics start only when `NEXUS_METRICS_PORT` is present. Scrubbing that
  var in the setup file is what actually keeps metrics off now.

## [0.1.4] — 2026-06-21

### Added

- **Server-side `user_id` pin via `NEXUS_DEFAULT_USER_ID`** (single-user mode):
  Operators running a single-user deployment can now set `NEXUS_DEFAULT_USER_ID`
  to a fixed value and the MCP server will use it as the `user_id` for every tool
  call, regardless of whatever `user_id` the LLM supplies. This solves the dogfood
  problem where the LLM picks inconsistent user IDs across sessions, causing
  memories written in one session to be invisible in the next.

  - `NEXUS_DEFAULT_USER_ID` is **optional** and was NOT added to `REQUIRED_ENV_VARS`.
    When absent or empty, behavior is unchanged — per-call `args.user_id` is
    required and validated as before.
  - When set, one diagnostic line is written to stderr at startup confirming
    single-user mode is active (value is printed so the operator can verify the
    pin; token is never involved).
  - The logic is centralised in a new exported pure helper `resolveUserId(auth,
    rawArgsUserId)` in `src/auth.ts`. All four tool handlers call it instead of
    reading `args.user_id` directly.

---

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
