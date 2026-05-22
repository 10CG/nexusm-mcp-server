/**
 * Tool: nexus.memory_search (US-037 TASK-010, Wave 2).
 *
 * Targeted memory search over the Nexus REST API via `@nexusm/sdk`.
 *
 * Schema is locked in proposal §"R2 工具 Schema 锁定" Tool 2 (+ R2.1) and
 * MUST be preserved verbatim — the parity check
 * `tests/unit/schema_sync.test.ts` will fail loudly if drift is introduced.
 *
 * Design decisions resolved during implementation:
 *
 *   - `mode` defaults to `'hybrid'` per proposal §M-11 / §A2-D-1
 *     (no pure-keyword mode in Phase 1; hybrid handles CJK via the
 *     backend's trigram `word_similarity` fallback documented in
 *     `repositories/__init__.py::search_by_trigram`).
 *
 *   - Enum violations on `mode` are surfaced as a JSON-RPC
 *     `InvalidParams` protocol error (proposal §M-3 mapping table:
 *     422 → InvalidParams). The MCP core dispatcher in `src/index.ts`
 *     does NOT validate input against the declared inputSchema — that
 *     responsibility lives in this handler.
 *
 *   - `score_threshold` is forwarded to the SDK body verbatim. The
 *     backend `/memories/search` endpoint accepts it under that exact
 *     name (the SDK's older `threshold` field is a historical alias
 *     that the backend also accepts; the locked MCP schema uses the
 *     new name, so we forward the new name).
 *
 *   - `NexusClient` is lazily constructed on first handler invocation
 *     from `loadAuthConfig()` and cached for subsequent calls. This
 *     keeps construction cost off the `tools/list` hot path and lets
 *     tests inject a mock via `vi.mock('@nexusm/sdk', ...)` before the
 *     first call.
 */

import { NexusClient } from '@nexusm/sdk';
import { loadAuthConfig } from '../auth.js';
import { McpErrorCode, NexusError, isAxiosLikeError, mapHttpStatusToMcpError } from '../errors.js';
import { type ToolDefinition } from './types.js';

const NAME = 'nexus.memory_search';

const ALLOWED_MODES = ['semantic', 'hybrid'] as const;
type SearchMode = (typeof ALLOWED_MODES)[number];
const DEFAULT_MODE: SearchMode = 'hybrid';

/** Lazily-instantiated SDK client. Reset by `__resetClientForTesting`. */
let clientSingleton: NexusClient | null = null;

function getClient(): NexusClient {
  if (clientSingleton === null) {
    const auth = loadAuthConfig();
    clientSingleton = new NexusClient({
      apiKey: auth.apiToken,
      baseUrl: auth.apiUrl,
      tenantId: auth.tenantId,
    });
  }
  return clientSingleton;
}

/**
 * Test-only seam: reset the cached client so a `vi.mock` of `@nexusm/sdk`
 * applied between tests can re-construct against the fresh mock.
 *
 * @internal
 */
export function __resetClientForTesting(): void {
  clientSingleton = null;
}

/** Body forwarded to the SDK. Extends `MemorySearch` with proposal-locked
 *  fields (`mode`, `score_threshold`) that the current SDK type predates. */
interface MemorySearchBody {
  user_id: string;
  query: string;
  mode: SearchMode;
  limit?: number;
  score_threshold?: number;
  memory_type?: 'episodic' | 'semantic' | 'procedural';
}

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
  handler: async (args) => {
    // Required field shape: rely on MCP `required` declaration + SDK Zod
    // for deep validation; here we only enforce the enum constraints that
    // the dispatcher does not check.
    const rawMode = args.mode;
    let mode: SearchMode;
    if (rawMode === undefined) {
      mode = DEFAULT_MODE;
    } else if (
      typeof rawMode === 'string' &&
      (ALLOWED_MODES as readonly string[]).includes(rawMode)
    ) {
      mode = rawMode as SearchMode;
    } else {
      throw new NexusError(
        `Invalid mode "${String(rawMode)}". Allowed: ${ALLOWED_MODES.join(', ')}.`,
        McpErrorCode.InvalidParams,
        422,
      );
    }

    const body: MemorySearchBody = {
      user_id: String(args.user_id),
      query: String(args.query),
      mode,
    };
    if (args.limit !== undefined) body.limit = args.limit as number;
    if (args.score_threshold !== undefined) body.score_threshold = args.score_threshold as number;
    if (args.memory_type !== undefined && args.memory_type !== null) {
      body.memory_type = args.memory_type as 'episodic' | 'semantic' | 'procedural';
    }

    const client = getClient();
    // Cast: SDK's `MemorySearch` type predates the `mode`/`score_threshold`
    // additions locked in proposal R2; the SDK Zod schema is permissive
    // (no `.strict()`) so the extra fields pass through to the HTTP body.
    // Wave 2B mid_audit-to-pre_merge fix: wrap SDK call in try/catch +
    // route SDK errors through mapHttpStatusToMcpError (proposal §M-3 mapping),
    // mirroring context.ts pattern. Without this, axios-like 401/403/429
    // would surface as JSON-RPC InternalError (-32603) instead of the
    // semantically-correct Unauthorized/RateLimited codes from TASK-013.
    let result;
    try {
      result = await client.memories.search(body as unknown as Parameters<typeof client.memories.search>[0]);
    } catch (err: unknown) {
      if (isAxiosLikeError(err)) {
        const status = err.response?.status ?? null;
        const respBody = err.response?.data ?? null;
        const headers = err.response?.headers as Record<string, string | string[]> | undefined;
        throw mapHttpStatusToMcpError(status, respBody, headers);
      }
      throw mapHttpStatusToMcpError(null, null);
    }

    const memories = result.results ?? [];
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ memories, total: memories.length }),
        },
      ],
      structuredContent: {
        memories,
        total: memories.length,
      },
    };
  },
};
