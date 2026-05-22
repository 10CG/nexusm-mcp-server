# nexusm-mcp-server

Nexusm MCP Server — generic MCP server exposing Nexusm core capabilities (memory, conversation, knowledge, feedback, context) to MCP clients via `@modelcontextprotocol/sdk` stdio + Streamable HTTP transports.

Published to npm as **`@nexusm/mcp-server`**.

> Tracked in Nexusm main repo: [`packages/nexusm-mcp-server`](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/packages/nexusm-mcp-server) (US-037 v7.0).

## Status

**Wave 2 done (2026-05-22)**: 4 tools fully wired to `@nexusm/sdk` (context_retrieve / memory_search / memory_create / memory_feedback) + full §M-3 HTTP→MCP error mapping (`mapHttpStatusToMcpError` + 2 new error codes Unauthorized/RateLimited) + Prometheus metrics with cardinality guard + cross-substory + E2E + schema_sync integration tests. Wave 3 (nexus-claude-plugin Anthropic marketplace) pending — see [proposal](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/proposal.md).

**Known Wave 2 limitations**: (1) CI red until Gate-1 — `@nexusm/sdk@1.3.0` npm publish pending (user action; SDK rename merged at `1fbdd69` in `nexus-sdk-js` main); (2) integration tests env-gated (require `NEXUS_TEST_API_URL/TOKEN/TENANT_ID` Forgejo secrets, currently dormant); (3) Python backend `mcp.py` metrics defined but emit-site wiring deferred to Wave 3 (FU-MCP-BACKEND-EMIT-WIRING); (4) HTTP transport per-request `server.connect()` is scaffold-only — Wave 3 entry condition (FU-MCP-HTTP-SESSION) before plugin TASK-019 E2E runs.
