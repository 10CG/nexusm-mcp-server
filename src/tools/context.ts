/**
 * Tool: nexus.context_retrieve
 *
 * Aggregated retrieval over memories + conversation turns + knowledge entities.
 * Schema locked in `openspec/changes/us-037-mcp-server-exposure/proposal.md`
 * §"R2 工具 Schema 锁定" Tool 1 (and R2.1 grep corrections).
 *
 * Wave 1 (TASK-003): scaffold only — handler returns NOT_IMPLEMENTED.
 * Wave 1+ (TASK-007): wire to `nexus-sdk-js` ContextService.retrieve().
 */

import { notImplementedResult, type ToolDefinition } from './types.js';

const NAME = 'nexus.context_retrieve';

export const contextRetrieveTool: ToolDefinition = {
  name: NAME,
  description:
    'Use when user asks anything that might need context from prior sessions, prior conversations, or stored facts. Single call returns relevant memories, recent conversation turns, and knowledge entities together. Prefer this over nexus.memory_search when query is open-ended.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: {
        type: 'string',
        description: 'User identifier within tenant scope. Required per-call (R2 C-1).',
      },
      query: { type: 'string' },
      limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
      as_of: {
        type: 'string',
        format: 'date-time',
        description:
          'ISO 8601 with timezone, max 90 days in the past. Default: NULL (current valid memories, no anchor inheritance from previous calls). Do NOT infer as_of from conversation context — user must explicitly express time intent.',
      },
    },
    required: ['user_id', 'query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      retrieve_id: {
        type: 'string',
        format: 'uuid',
        description:
          'PASS THIS to nexus.memory_feedback to rate this retrieval. Save it before continuing the conversation.',
      },
      memories: { type: 'array', items: { type: 'object' } },
      conversation_turns: { type: 'array', items: { type: 'object' } },
      knowledge_entities: { type: 'array', items: { type: 'object' } },
      errors: {
        type: 'object',
        additionalProperties: { type: 'string' },
        nullable: true,
        description:
          'Non-empty if partial degradation (dict[str,str] type, key=layer, value=error message). Null when all layers healthy. HTTP 200 + errors!=null indicates partial result.',
      },
      _warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'R2 M-3 partial-result warning channel',
      },
    },
    required: ['retrieve_id', 'memories', 'conversation_turns', 'knowledge_entities'],
  },
  handler: async (_args) => notImplementedResult(NAME),
};
