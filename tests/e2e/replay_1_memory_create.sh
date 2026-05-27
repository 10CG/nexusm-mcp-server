#!/usr/bin/env bash
# TASK-019 Scenario 1: "Remember I prefer TypeScript strict mode" → nexus.memory_create
#
# Simulates what an LLM in Claude Code / Cursor / Windsurf SHOULD do when the
# user expresses a cross-session preference: persist via nexus.memory_create
# with memory_type='semantic' (preferences are semantic facts, not events).
#
# Pass criteria:
#   - Server returns structured result with memory_id (UUID) + created_at
#   - mcp-call.mjs exits 0
#
# Fail modes:
#   - Server protocol error (exit 1) → check server logs / npm package version
#   - Tool returns isError:true with InvalidParams → args mismatch SDK schema
#   - Auth error (401/403 mapped to Unauthorized) → check NEXUS_API_TOKEN
set -euo pipefail

cd "$(dirname "$0")"

echo "=== TASK-019 Scenario 1 — memory_create ==="
echo "User prompt: \"Remember I prefer TypeScript strict mode\""
echo "Expected tool: nexus.memory_create"
echo

node lib/mcp-call.mjs nexus.memory_create '{
  "user_id": "e2e-test-user",
  "content": "Prefers TypeScript strict mode (noImplicitAny, strictNullChecks, etc.)",
  "memory_type": "semantic",
  "metadata": {
    "source": "task-019-replay",
    "scenario": "1"
  }
}'

echo
echo "=== PASS: memory_create returned a result ==="
echo "Manual check: result above should contain memory_id (UUID) + created_at (RFC 3339)"
