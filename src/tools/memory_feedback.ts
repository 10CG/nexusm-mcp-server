/**
 * Tool: nexus.memory_feedback
 *
 * Submit per-memory feedback on a previous nexus.context_retrieve call.
 * Schema locked in proposal §"R2 工具 Schema 锁定" Tool 4 (R2.1 grep-corrected).
 *
 * Wave 2 (TASK-012): full handler — validates inputs, structlogs `user_id`
 * for audit, then forwards a body that **excludes** `user_id` to
 * `@nexusm/sdk` `FeedbackService.submit(retrieveId, body)`.
 *
 * R2.1 grep corrections vs R2 draft (proposal §"R2.1 grep 修正"):
 *   - `item_feedback[].reason` maxLength: 255 (was 500)
 *   - `expected_missing` maxLength: 2000 (was 500)
 *   - outputSchema is `{feedback_id, retrieve_id, status, created_at}`
 *     with status="accepted" (R2 wrote `{feedback_id, acknowledged}`,
 *     which does not match backend FeedbackResponse).
 *
 * Backend contract (R2.1 D-1, /v1/feedback/{retrieve_id} PUT):
 *   The request body MUST NOT contain `user_id`. The backend derives
 *   user_id from the retrieve_log keyed by the URL path `retrieve_id`.
 *   We surface `user_id` in inputSchema only so the MCP server can
 *   structlog it for the audit trail and metric labels. This handler
 *   strips it before calling the SDK.
 *
 * Security:
 *   - Bearer token is never logged: the audit structlog includes only
 *     {tool, user_id, retrieve_id, rating}, never headers or env values.
 *   - SDK errors may carry the bearer token in `cause.config.headers`.
 *     We never log the raw error; we wrap-and-rethrow so toJSON() (which
 *     omits `cause`) gates serialization.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NexusClient, type FeedbackSubmitRequest } from '@nexusm/sdk';

import { loadAuthConfig, resolveUserId, type AuthConfig } from '../auth.js';
import { McpErrorCode, NexusError, isAxiosLikeError, mapHttpStatusToMcpError } from '../errors.js';
import type { ToolDefinition } from './types.js';

const NAME = 'nexus.memory_feedback';

/** Lazy NexusClient singleton — built on first handler invocation so
 *  importing the module does not require env vars (matches memory_search). */
let _client: NexusClient | null = null;
let _auth: AuthConfig | null = null;

function getClientAndAuth(): { client: NexusClient; auth: AuthConfig } {
  if (_client === null || _auth === null) {
    const cfg = loadAuthConfig();
    _auth = cfg;
    _client = new NexusClient({
      apiKey: cfg.apiToken,
      baseUrl: cfg.apiUrl,
      tenantId: cfg.tenantId,
    });
  }
  return { client: _client, auth: _auth };
}

/**
 * Test helper — reset the lazy singleton between cases so each test
 * picks up a fresh `vi.mock('@nexusm/sdk')` factory invocation.
 */
export function __resetClientForTesting(): void {
  _client = null;
  _auth = null;
}

/** Structlog sink. Always stderr (MCP stdio invariant — stdout is JSON-RPC). */
type AuditLogger = (line: string) => void;
let auditLogger: AuditLogger = (line) => {
  process.stderr.write(`${line}\n`);
};

/** Test helper — override the audit sink. Pair with __resetClientForTesting. */
export function __setAuditLoggerForTesting(fn: AuditLogger | null): void {
  auditLogger = fn ?? ((line) => process.stderr.write(`${line}\n`));
}

interface ParsedArgs {
  user_id: string;
  retrieve_id: string;
  body: FeedbackSubmitRequest;
}

/**
 * Validate raw MCP `arguments` against the R2.1 schema rules that JSON
 * Schema cannot express purely at the SDK layer (range, length caps).
 *
 * Throws {@link NexusError}(InvalidParams) on any violation — caught at
 * the MCP dispatch layer (src/index.ts) and converted to a JSON-RPC
 * error response per proposal §M-3. Matches the memory_search pattern.
 *
 * @param auth - Auth config; used to resolve the effective user_id (pin vs per-call).
 */
function parseAndValidate(args: Record<string, unknown>, auth: AuthConfig): ParsedArgs {
  const reject = (msg: string): never => {
    throw new NexusError(msg, McpErrorCode.InvalidParams, null);
  };

  // user_id — resolved via server-side pin or validated per-call arg.
  // Note: when pin is active, args['user_id'] is ignored (audit log still
  // records the resolved value so the trail is accurate).
  // We re-throw as the standard feedback rejection message so the error
  // shape is consistent with prior versions (no message change for callers).
  let user_id: string;
  try {
    user_id = resolveUserId(auth, args['user_id']);
  } catch {
    reject("'user_id' is required and must be a non-empty string");
    // TypeScript flow: reject() is typed `never`, so this line is unreachable
    // but satisfies the definite-assignment check.
    throw new Error('unreachable');
  }

  // retrieve_id — required, non-empty string.
  const retrieveIdRaw = args['retrieve_id'];
  if (typeof retrieveIdRaw !== 'string' || retrieveIdRaw.trim() === '') {
    reject("'retrieve_id' is required and must be a non-empty string");
  }
  const retrieve_id = (retrieveIdRaw as string).trim();

  // rating — required, integer 1..5 (hard reject 0 / 6 / floats / non-numbers).
  const ratingRaw = args['rating'];
  if (
    typeof ratingRaw !== 'number' ||
    !Number.isInteger(ratingRaw) ||
    ratingRaw < 1 ||
    ratingRaw > 5
  ) {
    reject("'rating' must be an integer between 1 and 5");
  }
  const rating = ratingRaw as number;

  // item_feedback — optional array of {memory_id, useful, reason?}.
  let item_feedback: FeedbackSubmitRequest['item_feedback'];
  if (args['item_feedback'] !== undefined && args['item_feedback'] !== null) {
    if (!Array.isArray(args['item_feedback'])) {
      reject("'item_feedback' must be an array when provided");
    }
    item_feedback = (args['item_feedback'] as unknown[]).map((raw, idx) => {
      if (typeof raw !== 'object' || raw === null) {
        reject(`'item_feedback[${idx}]' must be an object`);
      }
      const item = raw as Record<string, unknown>;
      const memory_id = item['memory_id'];
      const useful = item['useful'];
      if (typeof memory_id !== 'string' || memory_id.trim() === '') {
        reject(`'item_feedback[${idx}].memory_id' is required (non-empty string)`);
      }
      if (typeof useful !== 'boolean') {
        reject(`'item_feedback[${idx}].useful' is required (boolean)`);
      }
      const reasonRaw = item['reason'];
      let reason: string | undefined;
      if (reasonRaw !== undefined && reasonRaw !== null) {
        if (typeof reasonRaw !== 'string') {
          reject(`'item_feedback[${idx}].reason' must be a string when provided`);
        }
        if ((reasonRaw as string).length > 255) {
          reject(
            `'item_feedback[${idx}].reason' exceeds maxLength 255 (got ${(reasonRaw as string).length})`,
          );
        }
        reason = reasonRaw as string;
      }
      return {
        memory_id: memory_id as string,
        useful: useful as boolean,
        ...(reason !== undefined ? { reason } : {}),
      };
    });
  }

  // expected_missing — optional string <= 2000 chars.
  let expected_missing: string | undefined;
  const emRaw = args['expected_missing'];
  if (emRaw !== undefined && emRaw !== null) {
    if (typeof emRaw !== 'string') {
      reject("'expected_missing' must be a string when provided");
    }
    if ((emRaw as string).length > 2000) {
      reject(`'expected_missing' exceeds maxLength 2000 (got ${(emRaw as string).length})`);
    }
    expected_missing = emRaw as string;
  }

  // context — optional free-form object.
  let context: Record<string, unknown> | undefined;
  const ctxRaw = args['context'];
  if (ctxRaw !== undefined && ctxRaw !== null) {
    if (typeof ctxRaw !== 'object' || Array.isArray(ctxRaw)) {
      reject("'context' must be a plain object when provided");
    }
    context = ctxRaw as Record<string, unknown>;
  }

  // Build body — `user_id` deliberately omitted (R2.1 D-1).
  const body: FeedbackSubmitRequest = {
    rating,
    ...(item_feedback !== undefined ? { item_feedback } : {}),
    ...(expected_missing !== undefined ? { expected_missing } : {}),
    ...(context !== undefined ? { context } : {}),
  };

  return { user_id, retrieve_id, body };
}

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
  handler: async (args): Promise<CallToolResult> => {
    // Load auth config (for server-side user_id pin) and client.
    const { client, auth } = getClientAndAuth();

    // parseAndValidate throws NexusError(InvalidParams) on violation;
    // we let it propagate so the MCP dispatch layer can map it to a
    // JSON-RPC error response (matches memory_search convention).
    const parsed = parseAndValidate(args, auth);

    // Audit structlog (stderr only). Body intentionally does NOT include
    // user_id — that property travels only on this log line.
    auditLogger(
      JSON.stringify({
        event: 'mcp.memory_feedback.submit',
        tool: NAME,
        user_id: parsed.user_id,
        retrieve_id: parsed.retrieve_id,
        rating: parsed.body.rating,
      }),
    );
    // Wave 2B mid_audit-to-pre_merge fix: wrap SDK call + map errors per §M-3
    // (mirrors context.ts pattern). Without this, axios-like 401/403/429
    // surface as JSON-RPC InternalError instead of Unauthorized/RateLimited.
    let result;
    try {
      result = await client.feedback.submit(parsed.retrieve_id, parsed.body);
    } catch (err: unknown) {
      if (isAxiosLikeError(err)) {
        const status = err.response?.status ?? null;
        const respBody = err.response?.data ?? null;
        const headers = err.response?.headers as Record<string, string | string[]> | undefined;
        throw mapHttpStatusToMcpError(status, respBody, headers);
      }
      throw mapHttpStatusToMcpError(null, null);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  },
};
