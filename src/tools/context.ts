/**
 * Tool: nexus.context_retrieve
 *
 * Aggregated retrieval over memories + conversation turns + knowledge entities.
 * Schema locked in `openspec/changes/us-037-mcp-server-exposure/proposal.md`
 * §"R2 工具 Schema 锁定" Tool 1 (and R2.1 grep corrections).
 *
 * Wave 2 (TASK-009): full impl wiring to `@nexusm/sdk` ContextService.retrieve().
 * Implements:
 *   - R2.1 ai D-1: retrieve_id banner in MCP content text (LLM-visible)
 *   - R2.1 ai D-2 / A2-D-4: as_of cap (> 90 days in the past → InvalidParams)
 *   - R2 M-3: partial-degradation passthrough via outputSchema.errors +
 *     _warnings string array
 *
 * Auth / SDK client construction notes:
 *   - The SDK client is instantiated lazily on first call (memoised) from the
 *     env-derived AuthConfig (TASK-004). This keeps the module side-effect
 *     free at import time — important for `tools/list` which is called
 *     before the transport is fully up.
 *   - For testability, the client factory is exported and can be replaced
 *     via `__setClientForTesting`. Production code uses the default factory
 *     which reads `process.env` once.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NexusClient } from '@nexusm/sdk';
import type { ContextRequest, ContextRetrieveResponse } from '@nexusm/sdk';

import { loadAuthConfig, type AuthConfig } from '../auth.js';
import { NexusError, McpErrorCode, isAxiosLikeError, mapHttpStatusToMcpError } from '../errors.js';
import type { ToolDefinition } from './types.js';

const NAME = 'nexus.context_retrieve';

/** 90-day cap from R2.1 ai D-2 / A2-D-4. Expressed in ms for precise math. */
const AS_OF_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Strict ISO 8601 with timezone — `Z` or `±HH:MM` suffix required.
 *  Mirrors the SDK Zod schema rejection of naive datetimes (see
 *  packages/nexus-sdk-js/src/schemas/context.ts). We re-validate at the
 *  MCP layer so a clear MCP error surfaces *before* SDK call (per
 *  test case 5). */
const ISO_8601_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// SDK 2.0.0 (ADR-003): `ContextRetrieveResponse` is now the backend flat-array
// canonical shape and exposes `retrieve_id`/`errors` directly, so the former
// `BackendContextResponse` narrowing alias (TASK-006) is deleted — we use the
// SDK type directly.

/** Validate that `as_of` (if present) is ISO 8601 *with* timezone and not
 *  more than 90 days in the past. Throws a `NexusError(InvalidParams)` on
 *  any violation — caller must invoke this BEFORE constructing the SDK
 *  request so the SDK is never reached for invalid input.
 *
 *  Location decision (TASK-013 §"as_of cap helper"): kept in context.ts
 *  rather than extracted to errors.ts or a shared validation.ts. Date
 *  validation is tool-domain logic, not error taxonomy; moving it to
 *  errors.ts would create conceptual pollution and a circular-dep risk
 *  (errors.ts importing from tools/). A new validation.ts for a single
 *  function is not warranted. */
export function validateAsOf(asOf: string | undefined, now: Date = new Date()): void {
  if (asOf === undefined) return;
  if (!ISO_8601_WITH_TZ.test(asOf)) {
    throw new NexusError(
      `as_of must be ISO 8601 with timezone (e.g. "2026-01-01T00:00:00Z" or "2026-01-01T00:00:00+08:00"); got ${JSON.stringify(asOf)}`,
      McpErrorCode.InvalidParams,
      422,
    );
  }
  const parsed = Date.parse(asOf);
  if (Number.isNaN(parsed)) {
    throw new NexusError(
      `as_of is not a valid datetime: ${JSON.stringify(asOf)}`,
      McpErrorCode.InvalidParams,
      422,
    );
  }
  const ageMs = now.getTime() - parsed;
  if (ageMs > AS_OF_MAX_AGE_MS) {
    throw new NexusError(
      `as_of is more than 90 days in the past (age=${Math.floor(ageMs / 86_400_000)}d, max=90d). Per US-037 R2.1 ai D-2 / A2-D-4 cap.`,
      McpErrorCode.InvalidParams,
      422,
    );
  }
  // Wave 2 mid_audit qa-engineer I-3: future as_of is semantically ill-defined
  // (cannot retrieve memories "from the future"); reject explicitly rather
  // than letting the SDK / backend silently accept-then-fail.
  if (ageMs < 0) {
    throw new NexusError(
      `as_of is in the future (now=${now.toISOString()}, as_of=${asOf}). Cannot retrieve memories anchored to a future point in time.`,
      McpErrorCode.InvalidParams,
      422,
    );
  }
}

// ---------------------------------------------------------------------------
// SDK client factory (memoised + test-overridable)
// ---------------------------------------------------------------------------

/** Minimal subset of NexusClient used by this handler — keeps the mock
 *  surface tiny in tests. */
export interface ContextClient {
  context: { retrieve: (req: ContextRequest) => Promise<ContextRetrieveResponse> };
}

let cachedClient: ContextClient | null = null;

/** @internal — for tests. Replace the cached client. Pass `null` to reset. */
export function __setClientForTesting(client: ContextClient | null): void {
  cachedClient = client;
}

function defaultClientFactory(): ContextClient {
  const cfg: AuthConfig = loadAuthConfig();
  // NexusClient takes `apiKey` (mapped from NEXUS_API_TOKEN), `tenantId`,
  // and `baseUrl` (mapped from NEXUS_API_URL).
  return new NexusClient({
    apiKey: cfg.apiToken,
    tenantId: cfg.tenantId,
    baseUrl: cfg.apiUrl,
  });
}

function getClient(): ContextClient {
  if (cachedClient === null) {
    cachedClient = defaultClientFactory();
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function buildBanner(retrieveId: string, summary: string): string {
  // Banner format is *exact* per test case 8 — keep the prefix stable.
  return `## Retrieved context (retrieve_id=${retrieveId})\n${summary}`;
}

function summarise(resp: ContextRetrieveResponse): string {
  // SDK 2.0.0 (ADR-003): profile/history/graph are flat arrays (not nested containers).
  const memCount = resp.profile?.length ?? 0;
  const histCount = resp.history?.length ?? 0;
  const entCount = resp.graph?.length ?? 0;
  return `memories=${memCount}, conversation_turns=${histCount}, knowledge_entities=${entCount}`;
}

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  // ---- Input narrowing (schema enforcement is the MCP server's job; we
  // ---- defensively coerce here for runtime safety) -------------------
  const userId = args.user_id as string;
  const query = args.query as string;
  const limit = (args.limit as number | undefined) ?? 10;
  const asOf = args.as_of as string | undefined;

  // ---- R2.1 ai D-2: as_of cap check BEFORE SDK call -------------------
  validateAsOf(asOf);

  // ---- Build SDK ContextRequest ---------------------------------------
  const sdkRequest: ContextRequest = {
    user_id: userId,
    query,
    // The MCP `limit` is a coarse total cap. Map it to all three SDK
    // per-layer limits so the LLM gets predictable totals regardless of
    // which layers return data. (Aggressive but simple — tunable later.)
    profile_limit: limit,
    history_limit: limit,
    graph_limit: limit,
  };
  if (asOf !== undefined) sdkRequest.as_of = asOf;

  // ---- Call SDK; translate errors to NexusError using TASK-013 mapping ---
  let resp: ContextRetrieveResponse;
  try {
    resp = await getClient().context.retrieve(sdkRequest);
  } catch (err) {
    // Re-throw NexusError unchanged (already translated, e.g. from validateAsOf).
    if (err instanceof NexusError) throw err;
    // Axios-like error from the SDK: use the canonical HTTP→MCP mapping.
    if (isAxiosLikeError(err)) {
      throw mapHttpStatusToMcpError(
        err.response?.status ?? null,
        err.response?.data,
        err.response?.headers,
      );
    }
    // Unknown / plain Error: surface as InternalError.
    const msg = err instanceof Error ? err.message : String(err);
    throw new NexusError(`nexus.context_retrieve failed: ${msg}`, McpErrorCode.InternalError);
  }

  // ---- Map SDK response → MCP outputSchema shape ----------------------
  // SDK 2.0.0 (ADR-003): profile/history/graph are flat arrays; pass elements through.
  const retrieveId = resp.retrieve_id ?? '';
  const memories = resp.profile ?? [];
  const conversationTurns = resp.history ?? [];
  const knowledgeEntities = resp.graph ?? [];
  const errors = resp.errors ?? null;

  // R2 M-3 partial-degradation warning channel
  const warnings: string[] = [];
  if (errors !== null && Object.keys(errors).length > 0) {
    for (const [layer, msg] of Object.entries(errors)) {
      warnings.push(`layer "${layer}" degraded: ${msg}`);
    }
  }

  const structured: Record<string, unknown> = {
    retrieve_id: retrieveId,
    memories,
    conversation_turns: conversationTurns,
    knowledge_entities: knowledgeEntities,
    errors,
    _warnings: warnings,
  };

  // R2.1 ai D-1: retrieve_id banner in user-visible content[0].text so the
  // LLM can read it and pass to nexus.memory_feedback. Structured payload
  // is duplicated in a second content item so MCP clients that only render
  // text still see the data, while structured-output clients read
  // `structuredContent`.
  return {
    content: [
      {
        type: 'text',
        text: buildBanner(retrieveId, summarise(resp)),
      },
      {
        type: 'text',
        text: JSON.stringify(structured, null, 2),
      },
    ],
    structuredContent: structured,
    isError: false,
  };
}

export const contextRetrieveTool: ToolDefinition = {
  name: NAME,
  description:
    'Use when user asks anything that might need context from prior sessions, prior conversations, or stored facts. Single call returns relevant memories, recent conversation turns, and knowledge entities together. Prefer this over nexus.memory_search when query is open-ended.',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: {
        type: 'string',
        description: 'User identifier within tenant scope. Required per-call.',
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
        description:
          'Partial-result warning channel; populated when one or more retrieval layers degraded.',
      },
    },
    required: ['retrieve_id', 'memories', 'conversation_turns', 'knowledge_entities'],
  },
  handler,
};
