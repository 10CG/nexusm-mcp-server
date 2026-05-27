#!/usr/bin/env bash
# TASK-019 Scenario 4: "That memory wasn't useful" → nexus.memory_feedback (negative)
#
# Simulates negative feedback on a prior retrieve. Requires `retrieve_id`
# from a recent context_retrieve call — this script accepts it via the
# RETRIEVE_ID env var (caller chains from Scenario 2).
#
# Usage:
#   # First run Scenario 2 and grab the retrieve_id from the output:
#   ./replay_2_context_retrieve.sh > /tmp/s2.json
#   # Then extract + use it:
#   export RETRIEVE_ID=$(cat /tmp/s2.json | jq -r '.content[0].text' | grep -oE '[0-9a-f-]{36}' | head -1)
#   ./replay_4_memory_feedback.sh
#
# Or pass directly:
#   RETRIEVE_ID=00000000-0000-0000-0000-000000000001 ./replay_4_memory_feedback.sh
#
# Pass criteria:
#   - Server returns structured result with `accepted: true` (or status='accepted')
#   - mcp-call.mjs exits 0
#
# Common failures:
#   - 404 retrieve_id not found → ran with a stale or made-up UUID; re-run Scenario 2
#   - 410 retrieve_id expired (>7 days) → re-run Scenario 2 first
#   - 409 duplicate feedback → this retrieve_id already has feedback; pick a fresh one
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${RETRIEVE_ID:-}" ]; then
  echo "ERROR: RETRIEVE_ID env var not set."
  echo "Run replay_2_context_retrieve.sh first and export RETRIEVE_ID from its output."
  echo "See script header for the one-liner."
  exit 2
fi

echo "=== TASK-019 Scenario 4 — memory_feedback (negative) ==="
echo "User prompt: \"That memory wasn't useful\""
echo "Expected tool: nexus.memory_feedback with rating=1-2"
echo "retrieve_id: $RETRIEVE_ID"
echo

node lib/mcp-call.mjs nexus.memory_feedback "$(cat <<EOF
{
  "user_id": "e2e-test-user",
  "retrieve_id": "$RETRIEVE_ID",
  "rating": 2,
  "expected_missing": "user expected a specific Rust ownership pattern that wasn't returned"
}
EOF
)"

echo
echo "=== PASS: memory_feedback returned a result ==="
echo "Manual check: result should contain feedback_id (UUID) + status='accepted'"
