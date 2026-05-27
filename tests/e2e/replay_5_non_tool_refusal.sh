#!/usr/bin/env bash
# TASK-019 Scenario 5: "Now let's switch to my work project" → (no nexus tool)
#
# DOCUMENTATION-ONLY SCRIPT — cannot be automated.
#
# Why no executable test:
#   This scenario asserts the LLM does NOT call any nexus tool. A CLI replay
#   script doesn't have an LLM to make that decision; running mcp-call.mjs
#   without a tool argument is meaningless.
#
#   This is exactly the negative-case scenario where SKILL.md's break-tie
#   rules (especially R1.5 — "Anthropic built-in auto-memory partition") are
#   tested most directly. The LLM should fall back to its built-in scratch /
#   TodoWrite / CLAUDE.md project-level guidance, not invoke nexus.
#
# What you do instead:
#   In each of the 3 LLM clients (Claude Code / Cursor / Windsurf):
#     1. Open a session where you previously called nexus tools (so the
#        client knows nexus is available)
#     2. Type the user prompt verbatim:
#          "Now let's switch to my work project"
#     3. Observe whether the client invokes any `nexus.*` tool
#     4. PASS if no nexus tool call; FAIL if it calls any
#     5. Record the result in cross-client-e2e-results-<date>.md row 5
#
# Common failure modes (record in results doc):
#   - LLM calls nexus.memory_create thinking "remember switch to work" is an
#     instruction → SKILL.md decision row 10 missed
#   - LLM calls nexus.context_retrieve looking up "work project" → SKILL.md
#     "within-session context switch" rule missed
#   - LLM calls nexus.memory_search → same as above
#
# Recovery if scenario 5 fails in 2+ clients:
#   SKILL.md needs a explicit decision row for "context switch within session"
#   → use CLAUDE.md project-level instead of cross-session memory. File as
#   SKILL.md amendment PR.

set -euo pipefail

cat <<'EOF'
=== TASK-019 Scenario 5 — NON-TOOL REFUSAL (manual-only) ===

User prompt to type in each LLM client:
    "Now let's switch to my work project"

Expected behaviour:
    NO nexus.* tool call. Client falls back to built-in / CLAUDE.md.

Record results in:
    nexus main repo:
    openspec/changes/us-037-mcp-server-exposure/cross-client-e2e-results-<date>.md
    row 5

This script is documentation-only and does NOT exercise the mcp-server.
Exit 0 to allow scripted "for f in replay_*.sh; do ./$f; done" to continue.
EOF
exit 0
