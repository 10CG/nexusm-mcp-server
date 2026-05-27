# tests/e2e — Cross-client E2E replay scripts

US-037 TASK-019 deliverable. 5 shell scripts that drive the published `@nexusm/mcp-server@0.1.1` end-to-end via stdio MCP protocol, one per user scenario from the spec.

## Why these exist

The TASK-019 cross-client E2E gate requires **5 user scenarios × 3 LLM-driven clients** (Claude Code + Cursor + one of Windsurf/Cline) with ≥80% routing-correctness hit rate. The LLM-judgment part requires a real human-in-the-loop in each client — Claude can't drive Cursor or Windsurf.

But the **protocol layer** can and should be tested deterministically — these scripts do exactly that. They simulate what the LLM **should** have done (correct tool + plausible args for each scenario) and verify the server returns sensible responses. Use them to:

- **Smoke-test** post-`npm publish` that `npx -y @nexusm/mcp-server@0.1.1` actually runs
- **Re-record** demo GIFs when SKILL.md / schema evolves (per R2.1)
- **Compare** server behaviour against Claude Code / Cursor logs when debugging cross-client routing discrepancies

## Setup

Requires:

- Node 18+ (any LTS)
- `npx` (bundled with npm)
- Network access to npmjs.com (for `npx -y @nexusm/mcp-server@0.1.1`)
- Reachable Nexus API + valid credentials

Set 3 env vars (same ones the plugin's `.mcp.json` reads):

```bash
export NEXUS_API_URL="https://nexus-dev.10cg.pub"          # or your prod URL
export NEXUS_API_TOKEN="nx_live_..."                       # API key from /v1/tenants/<id>/api-keys
export NEXUS_TENANT_ID="..."                               # UUID from /v1/tenants response
```

## Run

```bash
# From this directory (packages/nexusm-mcp-server/tests/e2e/):
./replay_1_memory_create.sh
./replay_2_context_retrieve.sh
./replay_3_memory_search.sh
./replay_4_memory_feedback.sh
./replay_5_non_tool_refusal.sh    # documentation-only; no executable test

# Or run all 4 callable scripts in sequence + capture output:
for f in replay_{1,2,3,4}_*.sh; do
  echo "=== $f ==="
  ./$f > "/tmp/${f%.sh}.log" 2>&1 && echo "PASS" || echo "FAIL (see /tmp/${f%.sh}.log)"
done
```

## Server source

Scripts default to `npx -y @nexusm/mcp-server@0.1.1` (published npm package — true E2E). For fast local iteration:

```bash
MCP_SERVER_SRC=local ./replay_1_memory_create.sh   # uses ../../dist/index.js, requires `npm run build`
```

For a different mcp-server version:

```bash
MCP_SERVER_PKG=@nexusm/mcp-server@0.2.0 ./replay_1_memory_create.sh
```

## Scenario ↔ tool map (per TASK-019 spec)

| #   | User intent (paraphrase)                   | Expected tool                        | Why                                                                            |
| --- | ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | "Remember I prefer TypeScript strict mode" | `nexus.memory_create`                | Cross-session preference persistence                                           |
| 2   | "What did I say about React hooks?"        | `nexus.context_retrieve`             | Implicit cross-session recall                                                  |
| 3   | "Show me all my memories about Rust"       | `nexus.memory_search` mode=hybrid    | Targeted memory-only search                                                    |
| 4   | "That memory wasn't useful"                | `nexus.memory_feedback` (rating=1-2) | Negative feedback with prior `retrieve_id`                                     |
| 5   | "Now let's switch to my work project"      | **(no nexus tool)**                  | Context switch — falls under CLAUDE.md project-level, not cross-session memory |

Scenario 5 is intentionally a **negative case** — the SKILL.md break-tie rule should keep the LLM from invoking any nexus tool. This can't be tested by a deterministic replay script (you can't "assert absence of a tool call" from a CLI that doesn't have an LLM); it's documented here for completeness and exercised manually in each LLM client.

## Gate (per TASK-019 spec)

For LLM-client column results (recorded in `cross-client-e2e-results-<date>.md` in nexus main repo):

1. **Total ≥ 80%** — at least 12 of 15 (5 scenarios × 3 clients) cases pass
2. **Per-client ≥ 60%** — no single client below 3/5
3. **No scenario all-fail** — no scenario fails in all 3 clients (would expose SKILL.md systemic gap)

mcp-cli replay results are infrastructure smoke, NOT counted toward the gate. They verify the server protocol works; LLM clients verify the routing decision.

## See also

- TASK-019 spec: nexus `openspec/changes/us-037-mcp-server-exposure/detailed-tasks.yaml` line 756
- Sibling dogfood scenarios (TASK-028 prep, similar 5-scenario probe for SKILL.md): nexus `openspec/changes/us-037-mcp-server-exposure/dogfood-scenarios.md`
- Plugin under test: https://forgejo.10cg.pub/10CG/nexus-claude-plugin
- mcp-server source: this repo's `src/`
