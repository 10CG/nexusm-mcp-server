/**
 * Tool: nexus.memory_search
 *
 * Targeted semantic search over memories.
 * Schema locked in proposal §"R2 工具 Schema 锁定" Tool 2.
 *
 * Wave 1 (TASK-003): scaffold only — handler returns NOT_IMPLEMENTED.
 * Wave 1+ (TASK-008): wire to `nexus-sdk-js` MemoryService.search().
 */

import { notImplementedResult, type ToolDefinition } from './types.js';

const NAME = 'nexus.memory_search';

export const memorySearchTool: ToolDefinition = {
  name: NAME,
  description:
    "Targeted semantic search over memories. Use when query has specific keyword/topic and user wants list of memories (no need for conversation/knowledge layers). For Chinese queries, mode='hybrid' falls back to trigram word_similarity.",
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
      mode: {
        type: 'string',
        enum: ['semantic', 'hybrid'],
        default: 'hybrid',
        description:
          'semantic=dense vector only; hybrid=vector + trigram fallback (recommended for CJK/keyword queries).',
      },
      score_threshold: { type: 'number', default: 0.0, minimum: 0.0, maximum: 1.0 },
      memory_type: {
        type: 'string',
        enum: ['episodic', 'semantic', 'procedural'],
        nullable: true,
      },
    },
    required: ['user_id', 'query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      memories: { type: 'array', items: { type: 'object' } },
      total: { type: 'integer' },
    },
    required: ['memories', 'total'],
  },
  handler: async (_args) => notImplementedResult(NAME),
};
