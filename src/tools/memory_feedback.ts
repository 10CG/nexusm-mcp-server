/**
 * Tool: nexus.memory_feedback
 *
 * Submit per-memory feedback on a previous nexus.context_retrieve call.
 * Schema locked in proposal §"R2 工具 Schema 锁定" Tool 4 (R2.1 grep-corrected).
 *
 * Wave 1 (TASK-003): scaffold only — handler returns NOT_IMPLEMENTED.
 * Wave 1+ (TASK-010): wire to `nexus-sdk-js` FeedbackService.submit().
 *
 * Note: `user_id` in inputSchema is MCP-internal audit/logging only — it is
 * NOT forwarded into the backend FeedbackRequest body (route is PUT
 * /v1/feedback/{retrieve_id}, backend derives user_id from retrieve_log).
 */

import { notImplementedResult, type ToolDefinition } from './types.js';

const NAME = 'nexus.memory_feedback';

export const memoryFeedbackTool: ToolDefinition = {
  name: NAME,
  description:
    'Submit per-memory feedback on a previous nexus.context_retrieve call. Pass retrieve_id from earlier output. Rating 1-5, plus per-memory useful flag with optional reason. v5 feedback loop drives quality_score reranking.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: {
        type: 'string',
        description:
          'MCP server **internal** audit/logging field, **not forwarded** to backend FeedbackRequest body. Backend derives user_id from retrieve_log (route is PUT /v1/feedback/{retrieve_id}). This field is only used for MCP server-side structlog + metric label.',
      },
      retrieve_id: {
        type: 'string',
        format: 'uuid',
        description:
          'From earlier nexus.context_retrieve output. MCP server uses this value as PUT URL path parameter.',
      },
      rating: { type: 'integer', minimum: 1, maximum: 5 },
      item_feedback: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            memory_id: { type: 'string', format: 'uuid' },
            useful: { type: 'boolean' },
            reason: { type: 'string', nullable: true, maxLength: 255 },
          },
          required: ['memory_id', 'useful'],
        },
        description:
          'Per-memory useful flag with optional reason. Maps to backend FeedbackRequest.item_feedback[].',
      },
      expected_missing: {
        type: 'string',
        nullable: true,
        maxLength: 2000,
        description:
          'Free-text on what relevant memories were missing from retrieval. (PII-filtered before storage by backend)',
      },
      context: {
        type: 'object',
        nullable: true,
        additionalProperties: true,
        description:
          "Free-form context for feedback (e.g., {client: 'claude-code', session_id: '...'}).",
      },
    },
    required: ['user_id', 'retrieve_id', 'rating'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      feedback_id: { type: 'string', format: 'uuid' },
      retrieve_id: { type: 'string', format: 'uuid' },
      status: {
        type: 'string',
        enum: ['accepted'],
        description:
          "Submission status (currently always 'accepted', enum reserved for future expansion)",
      },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['feedback_id', 'retrieve_id', 'status', 'created_at'],
  },
  handler: async (_args) => notImplementedResult(NAME),
};
