/**
 * Tool: nexus.memory_create (US-037 TASK-011, Wave 2).
 *
 * Persist a new memory via the Nexus REST API through `@nexusm/sdk`.
 *
 * Schema is locked in proposal §"R2 工具 Schema 锁定" Tool 3 (+ R2.1 grep
 * corrections + ai R2 D-8 metadata cap + ai R2 D-10 conflict_resolution
 * enum lock) and MUST be preserved verbatim — `tests/unit/schema_sync.test.ts`
 * is the parity gate.
 *
 * Validation responsibilities (the MCP dispatcher does NOT validate inputs
 * against the declared inputSchema):
 *
 *   1. `valid_until_source` — 5-value enum locked in R2.1
 *      (permanent / extracted / sdk_provided / extraction_failed /
 *      superseded_by_conflict). Any other value → `InvalidParams`.
 *
 *   2. `metadata` cap (proposal §ai R2 D-8):
 *      - ≤ 10 keys
 *      - each string value ≤ 200 chars
 *      Over-cap → `InvalidParams` BEFORE the SDK call.
 *
 *   3. Response `conflict_resolution.status` — 9-value enum locked in
 *      §ai R2 D-10 (matches migration 020 `memory_conflicts.resolution_status`
 *      CHECK). Any other value → `InternalError` (treat as backend drift
 *      or server bug; do NOT silently echo).
 *
 * Client construction matches the sibling pattern in `memory_search.ts`:
 * lazy `NexusClient` singleton from `loadAuthConfig()`, with a
 * `__resetClientForTesting()` seam so `vi.mock('@nexusm/sdk', ...)` can
 * re-construct against the fresh mock between cases.
 */

import { NexusClient } from '@nexusm/sdk';

import { loadAuthConfig } from '../auth.js';
import { McpErrorCode, NexusError, isAxiosLikeError, mapHttpStatusToMcpError } from '../errors.js';
import { type ToolDefinition } from './types.js';

const NAME = 'nexus.memory_create';

/** memory_type enum locked in proposal §R2 Tool 3 (matches SDK MemoryType). */
const MEMORY_TYPE_ENUM = ['episodic', 'semantic', 'procedural'] as const;
type MemoryTypeLiteral = (typeof MEMORY_TYPE_ENUM)[number];
const DEFAULT_MEMORY_TYPE: MemoryTypeLiteral = 'semantic';

/** valid_until_source enum locked in proposal §R2.1 (5 values, backend Literal). */
const VALID_UNTIL_SOURCE_ENUM = [
  'permanent',
  'extracted',
  'sdk_provided',
  'extraction_failed',
  'superseded_by_conflict',
] as const;
type ValidUntilSource = (typeof VALID_UNTIL_SOURCE_ENUM)[number];

/**
 * conflict_resolution.status enum locked in proposal §ai R2 D-10, matching
 * migration 020 `memory_conflicts.resolution_status` 9-state CHECK constraint.
 */
const CONFLICT_STATUS_ENUM = [
  'resolved_keep_new',
  'resolved_keep_old',
  'resolved_merge',
  'resolved_keep_both',
  'pending_judge',
  'failed_llm',
  'failed_nli',
  'skipped_disabled',
  'no_conflict',
] as const;
type ConflictStatus = (typeof CONFLICT_STATUS_ENUM)[number];

/** Metadata cap per proposal §ai R2 D-8. */
const METADATA_MAX_KEYS = 10;
const METADATA_MAX_VALUE_LEN = 200;

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

/** Test-only seam — mirrors `memory_search.ts`. @internal */
export function __resetClientForTesting(): void {
  clientSingleton = null;
}

interface ConflictResolutionEcho {
  status: ConflictStatus;
  superseded_memory_ids?: string[];
  [k: string]: unknown;
}

/**
 * Guard a backend conflict_resolution payload against the locked 9-state
 * enum. Unknown status → drift → `InternalError` (proposal §ai R2 D-10).
 */
function validateConflictResolution(cr: unknown): ConflictResolutionEcho | null {
  if (cr === null || cr === undefined) return null;
  if (typeof cr !== 'object') {
    throw new NexusError('SDK returned non-object conflict_resolution', McpErrorCode.InternalError);
  }
  const obj = cr as Record<string, unknown>;
  const status = obj.status;
  if (typeof status !== 'string' || !(CONFLICT_STATUS_ENUM as readonly string[]).includes(status)) {
    throw new NexusError(
      `SDK returned unknown conflict_resolution.status="${String(status)}" (backend drift; ` +
        `expected one of ${CONFLICT_STATUS_ENUM.join('|')})`,
      McpErrorCode.InternalError,
    );
  }
  return obj as ConflictResolutionEcho;
}

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
        enum: [...MEMORY_TYPE_ENUM],
        default: 'semantic',
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description:
          "Free-form structured tags (e.g., {language: 'python', tags: ['snippet', 'react-hooks']}). " +
          'Use ≤ 10 keys, value length ≤ 200 chars (proposal §ai R2 D-8 cap; over-cap → InvalidParams).',
      },
      valid_until: { type: 'string', format: 'date-time', nullable: true },
      valid_until_source: {
        type: 'string',
        enum: [...VALID_UNTIL_SOURCE_ENUM],
        nullable: true,
        description:
          'v6 US-035 temporal validity (backend ValidUntilSource Literal, 5 values, locked in proposal §R2.1). ' +
          "MCP client typically passes 'sdk_provided' (user-declared) or omits to let backend worker auto-extract. " +
          'Any value outside the 5-enum is rejected at args parse stage with InvalidParams.',
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
          'If v6 US-036 ConflictResolver is enabled (per-tenant feature flag), resolution_status echoed here. ' +
          'NULL when feature flag disabled. status enum locked to 9 values (migration 020 CHECK).',
        properties: {
          status: { type: 'string', enum: [...CONFLICT_STATUS_ENUM] },
          superseded_memory_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['status'],
      },
    },
    required: ['memory_id', 'created_at'],
  },
  handler: async (args) => {
    // ---- Required fields ----
    if (typeof args.user_id !== 'string' || args.user_id.length === 0) {
      throw new NexusError(
        'user_id is required (non-empty string)',
        McpErrorCode.InvalidParams,
        422,
      );
    }
    if (typeof args.content !== 'string' || args.content.length === 0) {
      throw new NexusError(
        'content is required (non-empty string)',
        McpErrorCode.InvalidParams,
        422,
      );
    }

    // ---- memory_type enum + default ----
    let memory_type: MemoryTypeLiteral;
    if (args.memory_type === undefined || args.memory_type === null) {
      memory_type = DEFAULT_MEMORY_TYPE;
    } else if (
      typeof args.memory_type === 'string' &&
      (MEMORY_TYPE_ENUM as readonly string[]).includes(args.memory_type)
    ) {
      memory_type = args.memory_type as MemoryTypeLiteral;
    } else {
      throw new NexusError(
        `Invalid memory_type "${String(args.memory_type)}". Allowed: ${MEMORY_TYPE_ENUM.join(', ')}.`,
        McpErrorCode.InvalidParams,
        422,
      );
    }

    // ---- metadata cap (proposal §ai R2 D-8) ----
    let metadata: Record<string, unknown> | undefined;
    if (args.metadata !== undefined && args.metadata !== null) {
      if (typeof args.metadata !== 'object' || Array.isArray(args.metadata)) {
        throw new NexusError('metadata must be an object', McpErrorCode.InvalidParams, 422);
      }
      metadata = args.metadata as Record<string, unknown>;
      const keys = Object.keys(metadata);
      if (keys.length > METADATA_MAX_KEYS) {
        throw new NexusError(
          `metadata exceeds cap of ${METADATA_MAX_KEYS} keys (got ${keys.length})`,
          McpErrorCode.InvalidParams,
          422,
        );
      }
      for (const [k, v] of Object.entries(metadata)) {
        if (typeof v === 'string' && v.length > METADATA_MAX_VALUE_LEN) {
          throw new NexusError(
            `metadata.${k} value length ${v.length} exceeds cap of ${METADATA_MAX_VALUE_LEN}`,
            McpErrorCode.InvalidParams,
            422,
          );
        }
      }
    }

    // ---- valid_until_source enum (R2.1 LOCKED) ----
    let valid_until_source: ValidUntilSource | undefined;
    if (args.valid_until_source !== undefined && args.valid_until_source !== null) {
      if (
        typeof args.valid_until_source !== 'string' ||
        !(VALID_UNTIL_SOURCE_ENUM as readonly string[]).includes(args.valid_until_source)
      ) {
        throw new NexusError(
          `Invalid valid_until_source "${String(args.valid_until_source)}". ` +
            `Allowed: ${VALID_UNTIL_SOURCE_ENUM.join(', ')}.`,
          McpErrorCode.InvalidParams,
          422,
        );
      }
      valid_until_source = args.valid_until_source as ValidUntilSource;
    }

    // ---- SDK body assembly ----
    // The SDK MemoryCreate type predates the v6 additive fields
    // (valid_until / valid_until_source / agent_id). The SDK Zod schema
    // is permissive, so the extras pass through to the HTTP body — same
    // pattern as memory_search forwarding `mode` / `score_threshold`.
    interface MemoryCreateBody {
      user_id: string;
      content: string;
      memory_type: MemoryTypeLiteral;
      metadata?: Record<string, unknown>;
      valid_until?: string;
      valid_until_source?: ValidUntilSource;
      agent_id?: string;
    }
    const body: MemoryCreateBody = {
      user_id: args.user_id,
      content: args.content,
      memory_type,
    };
    if (metadata !== undefined) body.metadata = metadata;
    if (typeof args.valid_until === 'string') body.valid_until = args.valid_until;
    if (valid_until_source !== undefined) body.valid_until_source = valid_until_source;
    if (typeof args.agent_id === 'string') body.agent_id = args.agent_id;

    const client = getClient();
    // Wave 2B mid_audit-to-pre_merge fix: wrap SDK call + map errors per §M-3
    // (mirrors context.ts pattern). Without this, axios-like 401/403/429
    // surface as JSON-RPC InternalError instead of Unauthorized/RateLimited.
    let created: Record<string, unknown>;
    try {
      created = (await client.memories.create(
        body as unknown as Parameters<typeof client.memories.create>[0],
      )) as unknown as Record<string, unknown>;
    } catch (err: unknown) {
      if (isAxiosLikeError(err)) {
        const status = err.response?.status ?? null;
        const respBody = err.response?.data ?? null;
        const headers = err.response?.headers as Record<string, string | string[]> | undefined;
        throw mapHttpStatusToMcpError(status, respBody, headers);
      }
      throw mapHttpStatusToMcpError(null, null);
    }

    // ---- conflict_resolution drift guard (proposal §ai R2 D-10) ----
    const conflict = validateConflictResolution(created.conflict_resolution);

    const memory_id = (created.id ?? created.memory_id) as string | undefined;
    const created_at = created.created_at as string | undefined;
    const output: Record<string, unknown> = { memory_id, created_at };
    if (conflict !== null) output.conflict_resolution = conflict;

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
};
