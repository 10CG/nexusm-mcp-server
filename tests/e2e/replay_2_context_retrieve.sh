#!/usr/bin/env bash
# TASK-019 Scenario 2: "What did I say about React hooks?" → nexus.context_retrieve
#
# Simulates implicit cross-session recall (no explicit `as_of` time named).
# context_retrieve is preferred over memory_search here because the user
# said "what did I say" — could be memories OR recent conversation; the
# aggregator handles both.
#
# Pass criteria:
#   - Server returns structured result containing `retrieve_id` (UUID)
#   - mcp-call.mjs exits 0
#   - retrieve_id can be captured for Scenario 4 chaining (manual)
#
# Critical: do NOT pass `as_of` — SKILL.md decision row 5 says infer-from-context
# is wrong; only pass `as_of` when user explicitly names a time. This script
# tests the no-as_of path; Scenario 5 (manual) tests the with-as_of path.
set -euo pipefail

cd "$(dirname "$0")"

echo "=== TASK-019 Scenario 2 — context_retrieve ==="
echo "User prompt: \"What did I say about React hooks?\""
echo "Expected tool: nexus.context_retrieve (no as_of)"
echo

node lib/mcp-call.mjs nexus.context_retrieve '{
  "user_id": "e2e-test-user",
  "query": "React hooks"
}'

echo
echo "=== PASS: context_retrieve returned a result ==="
echo "Manual check: result should contain retrieve_id banner in content[0].text"
echo "Save the retrieve_id for use in replay_4_memory_feedback.sh"
