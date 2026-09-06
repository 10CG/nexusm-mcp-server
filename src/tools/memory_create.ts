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
 * Output id fields (nexus#400): the backend `MemoryResponse` carries TWO
 * identifiers and they are NOT interchangeable —
 *
 *   - `memory_id` : NORMALLY the compound id `tenant::user::uuid`
 *                   (`schemas/memory.py` MemoryResponse.memory_id, documented
 *                   as "(compound_id)"). That is the SAME id space that
 *                   `nexus.context_retrieve` and `nexus.memory_search` return.
 *   - `id`        : the `memories` table row PK (uuid4).
 *
 * The uuid segment inside a compound `memory_id` is minted independently by
 * `CompoundID.generate()` and is NOT the PK — never parse it out and use it
 * as one. This tool used to return `created.id ?? created.memory_id` under
 * the name `memory_id`, i.e. the PK wearing the compound id's label; that
 * mislabelling is nexus#400 sub-defect 1. Both fields are now surfaced
 * verbatim, additively, with NO cross-space fallback between them.
 *
 * "NORMALLY" is load-bearing. The backend has a SECOND `MemoryResponse`
 * construction site whose `memory_id` is NOT a compound id: the idempotent
 * dedup stub `_build_dedup_response` (nexus `src/nexus/services/memory.py`)
 * sends `memory_id=str(<row PK>)`, so both fields come back equal and both
 * are bare uuids. Reachable only with the ConflictResolver in mode='full'
 * returning `resolved_merge` with a surviving candidate (shadow and
 * keep_both_only force `resolved_memory_id=None`), i.e. exactly the mode
 * US-036's flag flip targets. Registered as nexus#400 sub-defect 5.
 *
 * That costs this handler nothing — it forwards whatever each field holds —
 * but it does mean two things are forbidden here: asserting that `memory_id`
 * is compound, and inferring the id space from a value's shape. Read the
 * field you need by name; do not pattern-match the value.
 *
 * Client construction matches the sibling pattern in `memory_search.ts`:
 * lazy `NexusClient` singleton from `loadAuthConfig()`, with a
 * `__resetClientForTesting()` seam so `vi.mock('@nexusm/sdk', ...)` can
 * re-construct against the fresh mock between cases.
 */

import { NexusClient } from '@nexusm/sdk';

import { loadAuthConfig, resolveUserId, type AuthConfig } from '../auth.js';
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
let authSingleton: AuthConfig | null = null;

function getClientAndAuth(): { client: NexusClient; auth: AuthConfig } {
  if (clientSingleton === null || authSingleton === null) {
    const auth = loadAuthConfig();
    authSingleton = auth;
    clientSingleton = new NexusClient({
      apiKey: auth.apiToken,
      baseUrl: auth.apiUrl,
      tenantId: auth.tenantId,
    });
  }
  return { client: clientSingleton, auth: authSingleton };
}

/** Test-only seam — mirrors `memory_search.ts`. @internal */
export function __resetClientForTesting(): void {
  clientSingleton = null;
  authSingleton = null;
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
    "Persist a new memory. Use when user explicitly asks to 'remember X' or when storing structured facts (preferences, decisions, code snippets with language tag). Set memory_type to 'episodic' for events, 'semantic' for facts, 'procedural' for how-tos. " +
    "Returns BOTH identifiers the API sends: 'memory_id' (normally the compound 'tenant::user::uuid' — the id space nexus.context_retrieve and nexus.memory_search return) and 'id' (bare uuid row primary key). " +
    "Do not assume the shape: on the backend's idempotent-dedup path 'memory_id' carries the row primary key instead, and then the two fields are equal. Read them by name, never by value shape. " +
    "For nexus.memory_feedback item_feedback[].memory_id, pass 'id': the primary key is accepted by every backend version, while the compound form is only accepted from the nexus#400 backend fix onward.",
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
      memory_id: {
        type: 'string',
        description:
          'Verbatim backend MemoryResponse.memory_id. Normally the compound memory id ' +
          "'tenant::user::uuid' — the same id space nexus.context_retrieve and nexus.memory_search return. " +
          'Not guaranteed to be compound: the backend idempotent-dedup stub (_build_dedup_response, ' +
          "reachable with the conflict resolver in mode='full') puts the row primary key in this field, and " +
          'then memory_id equals id. Hence no `format: uuid` here (the compound form is not a uuid, and the ' +
          'declaration this field used to carry was wrong — nexus#400), and hence: do not infer which id ' +
          'space a value belongs to from its shape. ' +
          'Accepted by nexus.memory_feedback only on backends carrying the nexus#400 fix.',
      },
      id: {
        type: 'string',
        format: 'uuid',
        description:
          'Row primary key — verbatim backend MemoryResponse.id. This is the value to pass to ' +
          'nexus.memory_feedback item_feedback[].memory_id: it is accepted by every backend version. ' +
          'It is NOT the uuid segment of memory_id (CompoundID.generate() mints that independently). ' +
          'Additive in nexus#400; omitted if the backend does not send it, hence not in `required`.',
      },
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
    const { client, auth } = getClientAndAuth();
    const userId = resolveUserId(auth, args.user_id);

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
      user_id: userId,
      content: args.content,
      memory_type,
    };
    if (metadata !== undefined) body.metadata = metadata;
    if (typeof args.valid_until === 'string') body.valid_until = args.valid_until;
    if (valid_until_source !== undefined) body.valid_until_source = valid_until_source;
    if (typeof args.agent_id === 'string') body.agent_id = args.agent_id;
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

    // ---- id fields (nexus#400 sub-defect 1) ----
    // Read each backend field under its own name. The previous
    // `created.id ?? created.memory_id` returned the row PK labelled
    // `memory_id`, which put this tool in a different id space from
    // context_retrieve / memory_search. Deliberately NO cross-space
    // fallback: a silent fallback is exactly what made the original
    // mix-up invisible, so a missing field is reported as missing.
    const memory_id = typeof created.memory_id === 'string' ? created.memory_id : undefined;
    const id = typeof created.id === 'string' ? created.id : undefined;
    const created_at = created.created_at as string | undefined;
    const output: Record<string, unknown> = { memory_id, created_at };
    if (id !== undefined) output.id = id;
    if (conflict !== null) output.conflict_resolution = conflict;

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
};
