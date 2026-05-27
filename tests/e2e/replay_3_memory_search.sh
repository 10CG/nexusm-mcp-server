#!/usr/bin/env bash
# TASK-019 Scenario 3: "Show me all my memories about Rust" → nexus.memory_search mode=hybrid
#
# Simulates explicit memory-only search (user says "memories about X" — they
# want stored memories, not conversation context). SKILL.md decision row 6:
# memory_search with mode=hybrid (R2 M-11 + A2-D-1 default).
#
# Pass criteria:
#   - Server returns structured result with a list of memories (may be empty
#     for a fresh test tenant — that's still a PASS at protocol layer)
#   - mcp-call.mjs exits 0
#
# Notes:
#   - mode=hybrid combines semantic + keyword + trigram; mode=keyword would
#     also be valid but hybrid is the default per spec
#   - score_threshold not set; backend uses its default
set -euo pipefail

cd "$(dirname "$0")"

echo "=== TASK-019 Scenario 3 — memory_search ==="
echo "User prompt: \"Show me all my memories about Rust\""
echo "Expected tool: nexus.memory_search mode=hybrid"
echo

node lib/mcp-call.mjs nexus.memory_search '{
  "user_id": "e2e-test-user",
  "query": "Rust",
  "mode": "hybrid",
  "limit": 10
}'

echo
echo "=== PASS: memory_search returned a result ==="
echo "Manual check: result should contain memories array (empty array is OK for fresh tenant)"
