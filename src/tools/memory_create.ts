/**
 * Tool: nexus.memory_create
 *
 * Persist a new memory.
 * Schema locked in proposal §"R2 工具 Schema 锁定" Tool 3.
 *
 * Wave 1 (TASK-003): scaffold only — handler returns NOT_IMPLEMENTED.
 * Wave 1+ (TASK-009): wire to `nexus-sdk-js` MemoryService.create().
 */

import { notImplementedResult, type ToolDefinition } from './types.js';

const NAME = 'nexus.memory_create';

export const memoryCreateTool: ToolDefinition = {
  name: NAME,
  description:
    "Persist a new memory. Use when user explicitly asks to 'remember X' or when storing structured facts (preferences, decisions, code snippets with language tag). Set memory_type to 'episodic' for events, 'semantic' for facts, 'procedural' for how-tos.",
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'string' },
      content: { type: 'string' },
      memory_type: {
        type: 'string',
        enum: ['episodic', 'semantic', 'procedural'],
        default: 'semantic',
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description:
          "Free-form structured tags (e.g., {language: 'python', tags: ['snippet', 'react-hooks']}). Cardinality unbounded — keep value list reasonable per memory.",
      },
      valid_until: { type: 'string', format: 'date-time', nullable: true },
      valid_until_source: {
        type: 'string',
        enum: [
          'permanent',
          'extracted',
          'sdk_provided',
          'extraction_failed',
          'superseded_by_conflict',
        ],
        nullable: true,
        description:
          "v6 US-035 temporal validity (backend ValidUntilSource Literal, 5 values). MCP client typically passes 'sdk_provided' (user-declared) or omits to let backend worker auto-extract.",
      },
      agent_id: { type: 'string', nullable: true },
    },
    required: ['user_id', 'content'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      memory_id: { type: 'string', format: 'uuid' },
      created_at: { type: 'string', format: 'date-time' },
      conflict_resolution: {
        type: 'object',
        nullable: true,
        description:
          'If v6 US-036 ConflictResolver is enabled (per-tenant feature flag), resolution_status echoed here (resolved_merge / resolved_keep_both / failed_nli / etc.). NULL when feature flag disabled.',
        properties: {
          status: { type: 'string' },
          superseded_memory_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    required: ['memory_id', 'created_at'],
  },
  handler: async (_args) => notImplementedResult(NAME),
};
