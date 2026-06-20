# nexusm-mcp-server

Nexusm MCP Server — generic MCP server exposing Nexusm core capabilities (memory, conversation, knowledge, feedback, context) to MCP clients via `@modelcontextprotocol/sdk` stdio + Streamable HTTP transports.

Published to npm as **`@nexusm/mcp-server`**.

> Tracked in Nexusm main repo: [`packages/nexusm-mcp-server`](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/packages/nexusm-mcp-server) (US-037 v7.0).

## Configuration

Set via environment (e.g. the `env` block of your client's `.mcp.json`):

| Env var | Required | Purpose |
|---------|----------|---------|
| `NEXUS_API_URL` | yes | Base URL of the Nexus REST API. The server **auto-appends `/v1`** if absent, so a bare origin (`http://localhost:8787`) or a local proxy URL works — you don't need to add the suffix manually. Canonical form: `https://your-nexus-host/v1`. |
| `NEXUS_API_TOKEN` | yes | Nexus API key (the product auth contract) |
| `NEXUS_TENANT_ID` | yes | Tenant id for the compound-id isolation |
| `NEXUS_METRICS_PORT` | no | **Opt-in** Prometheus `/metrics` port. **Off by default in stdio mode** — the scrape endpoint is a server-side concern, and a local stdio client (Claude Code / Cursor / Windsurf) has no scraper. Set this only when you actually scrape metrics. (`NEXUS_MCP_TRANSPORT=http` also enables it.) |

> The Nexus API auth contract is `NEXUS_API_TOKEN`. Any deployment-edge access
> control in front of the API (e.g. a reverse proxy / gateway / Cloudflare
> Access) is **not** this client's concern — handle it transparently at the
> network/transport layer (point `NEXUS_API_URL` at a local proxy) so the
> client stays deployment-agnostic. When pointing at a local proxy, set
> `NEXUS_API_URL` to the proxy origin (e.g. `http://localhost:8787`); the
> server will append `/v1` automatically and log a one-line diagnostic to
> stderr confirming the normalization.

## Status

**Wave 2 done (2026-05-22)**: 4 tools fully wired to `@nexusm/sdk` (context_retrieve / memory_search / memory_create / memory_feedback) + full §M-3 HTTP→MCP error mapping (`mapHttpStatusToMcpError` + 2 new error codes Unauthorized/RateLimited) + Prometheus metrics with cardinality guard + cross-substory + E2E + schema_sync integration tests. Wave 3 (nexus-claude-plugin Anthropic marketplace) pending — see [proposal](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/proposal.md).

**Known Wave 2 limitations**: (1) CI red until Gate-1 — `@nexusm/sdk@1.3.0` npm publish pending (user action; SDK rename merged at `1fbdd69` in `nexus-sdk-js` main); (2) integration tests env-gated (require `NEXUS_TEST_API_URL/TOKEN/TENANT_ID` Forgejo secrets, currently dormant); (3) Python backend `mcp.py` metrics defined but emit-site wiring deferred to Wave 3 (FU-MCP-BACKEND-EMIT-WIRING); (4) HTTP transport per-request `server.connect()` is scaffold-only — Wave 3 entry condition (FU-MCP-HTTP-SESSION) before plugin TASK-019 E2E runs.
