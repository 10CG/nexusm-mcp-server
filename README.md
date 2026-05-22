# nexusm-mcp-server

Nexusm MCP Server — generic MCP server exposing Nexusm core capabilities (memory, conversation, knowledge, feedback, context) to MCP clients via `@modelcontextprotocol/sdk` stdio + Streamable HTTP transports.

Published to npm as **`@nexusm/mcp-server`**.

> Tracked in Nexusm main repo: [`packages/nexusm-mcp-server`](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/packages/nexusm-mcp-server) (US-037 v7.0).

## Status

**Wave 1 done (2026-05-21)**: MCP server scaffold + auth + errors contract + Forgejo CI workflow shipped (5 commits, ~1283 lines). Wave 2 (tool handlers wired to SDK + error mapping + integration tests) pending — see [proposal](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/proposal.md).

**Known Wave 1 limitations**: (1) CI red until Wave 4 because `@nexusm/sdk@1.3.0` not yet published; (2) `schema_sync.test.ts` runtime check unblocks at Wave 4 SDK publish.
