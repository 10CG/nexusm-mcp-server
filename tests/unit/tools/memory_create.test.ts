/**
 * Tests for src/tools/memory_create.ts (US-037 Wave 2 TASK-011).
 *
 * Coverage (8 cases per detailed-tasks.yaml TASK-011 §单测):
 *   1. Happy path — valid args, SDK mock returns memory_id + no conflict
 *   2. All 5 valid_until_source enum values accepted (parametric)
 *   3. Invalid valid_until_source (e.g. "user_declared") → InvalidParams
 *   4. metadata with 11 keys → InvalidParams (proposal §ai R2 D-8 cap)
 *   5. metadata value with 201-char string → InvalidParams
 *   6. SDK returns conflict_resolution.status="resolved_keep_new" → echoed
 *   7. SDK returns conflict_resolution.status="foo" (drift) → InternalError
 *   8. memory_type defaults to "semantic" when omitted (assert SDK call body)
 *
 * SDK is mocked via `vi.mock('@nexusm/sdk', ...)` — no network, no env.
 * `loadAuthConfig` is mocked likewise so the lazy `NexusClient` build
 * inside `getClient()` does not touch `process.env`.
 *
 * Handler error contract matches sibling `memory_search.ts`: errors are
 * THROWN (`NexusError`) so the MCP dispatcher in `src/index.ts` can map
 * them to JSON-RPC error responses. We assert via `expect(...).rejects.toThrow(NexusError)`
 * and inspect the thrown `mcpErrorCode`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpErrorCode, NexusError } from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// SDK + auth mocks (must precede the tool import)
// ---------------------------------------------------------------------------
const createMock = vi.fn();

vi.mock('@nexusm/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexusm/sdk')>();
  class NexusClient {
    public readonly memories = { create: createMock };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_config: any) {}
  }
  // Spread the real module so the SDK error classes stay real — the bridge in
  // errors.ts matches them with `instanceof` (nexusm-mcp-server#32).
  return { ...actual, NexusClient };
});

vi.mock('../../../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth.js')>();
  return {
    ...actual,
    loadAuthConfig: vi.fn(() => ({
      apiUrl: 'http://localhost:8001/v1',
      apiToken: 'sk-test-token',
      tenantId: 'tenant_test',
    })),
  };
});

import { memoryCreateTool, __resetClientForTesting } from '../../../src/tools/memory_create.js';

beforeEach(() => {
  createMock.mockReset();
  __resetClientForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture a NexusError thrown by the handler. Vitest's `.rejects.toThrow`
 * matchers don't expose the thrown instance, so we use a try/catch to
 * inspect `mcpErrorCode` and `message` on the same object.
 */
async function expectThrowsNexusError(fn: () => Promise<unknown>): Promise<NexusError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof NexusError) return e;
    throw new Error(`Expected NexusError, got ${(e as Error).name}: ${(e as Error).message}`);
  }
  throw new Error('Expected NexusError to be thrown, but handler resolved');
}

function decodeStructured(result: { structuredContent?: unknown }): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Case 1 — Happy path
// ---------------------------------------------------------------------------
describe('memory_create handler — happy path', () => {
  it('returns memory_id + created_at when SDK succeeds with no conflict', async () => {
    createMock.mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-000000000001',
      created_at: '2026-05-22T10:00:00Z',
    });

    const result = await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'User prefers dark mode',
      memory_type: 'semantic',
    });

    const out = decodeStructured(result);
    expect(out.memory_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(out.created_at).toBe('2026-05-22T10:00:00Z');
    expect(out.conflict_resolution).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — All 5 valid_until_source enum values accepted (parametric)
// ---------------------------------------------------------------------------
describe('memory_create — valid_until_source enum (R2.1 LOCKED, 5 values)', () => {
  const VALUES = [
    'permanent',
    'extracted',
    'sdk_provided',
    'extraction_failed',
    'superseded_by_conflict',
  ] as const;

  it.each(VALUES)('accepts valid_until_source="%s"', async (value) => {
    createMock.mockResolvedValueOnce({
      id: 'mem_1',
      created_at: '2026-05-22T10:00:00Z',
    });

    await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'sample',
      valid_until_source: value,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const body = createMock.mock.calls[0]?.[0] as { valid_until_source?: string };
    expect(body.valid_until_source).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Invalid valid_until_source → InvalidParams (pre-SDK)
// ---------------------------------------------------------------------------
describe('memory_create — invalid valid_until_source', () => {
  it('rejects "user_declared" (not in 5-enum) with InvalidParams pre-SDK', async () => {
    const err = await expectThrowsNexusError(() =>
      memoryCreateTool.handler({
        user_id: 'user_42',
        content: 'sample',
        valid_until_source: 'user_declared',
      }),
    );

    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.message).toContain('valid_until_source');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rejects arbitrary string with InvalidParams pre-SDK', async () => {
    const err = await expectThrowsNexusError(() =>
      memoryCreateTool.handler({
        user_id: 'user_42',
        content: 'sample',
        valid_until_source: 'totally_made_up',
      }),
    );

    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 4 — metadata > 10 keys rejected (proposal §ai R2 D-8 cap)
// ---------------------------------------------------------------------------
describe('memory_create — metadata key cap', () => {
  it('rejects metadata with 11 keys (> 10 cap) with InvalidParams', async () => {
    const metadata: Record<string, string> = {};
    for (let i = 1; i <= 11; i++) metadata[`k${i}`] = `v${i}`;

    const err = await expectThrowsNexusError(() =>
      memoryCreateTool.handler({
        user_id: 'user_42',
        content: 'sample',
        metadata,
      }),
    );

    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.message).toMatch(/metadata.*cap.*10/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts metadata with exactly 10 keys (boundary)', async () => {
    createMock.mockResolvedValueOnce({ id: 'mem_1', created_at: '2026-05-22T10:00:00Z' });
    const metadata: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) metadata[`k${i}`] = `v${i}`;

    await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'sample',
      metadata,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — metadata value > 200 chars rejected
// ---------------------------------------------------------------------------
describe('memory_create — metadata value length cap', () => {
  it('rejects metadata value of 201 chars (> 200 cap) with InvalidParams', async () => {
    const longValue = 'x'.repeat(201);

    const err = await expectThrowsNexusError(() =>
      memoryCreateTool.handler({
        user_id: 'user_42',
        content: 'sample',
        metadata: { long_field: longValue },
      }),
    );

    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.message).toMatch(/long_field.*201.*200/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts metadata value of exactly 200 chars (boundary)', async () => {
    createMock.mockResolvedValueOnce({ id: 'mem_1', created_at: '2026-05-22T10:00:00Z' });

    await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'sample',
      metadata: { ok_field: 'x'.repeat(200) },
    });

    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — conflict_resolution echoed through (US-036 integration)
// ---------------------------------------------------------------------------
describe('memory_create — conflict_resolution echo (US-036)', () => {
  it('echoes status="resolved_keep_new" from SDK response verbatim', async () => {
    createMock.mockResolvedValueOnce({
      id: 'mem_1',
      created_at: '2026-05-22T10:00:00Z',
      conflict_resolution: {
        status: 'resolved_keep_new',
        superseded_memory_ids: ['mem_old_1'],
      },
    });

    const result = await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'sample',
    });

    const out = decodeStructured(result);
    expect(out.conflict_resolution).toEqual({
      status: 'resolved_keep_new',
      superseded_memory_ids: ['mem_old_1'],
    });
  });

  it('accepts every locked status enum value (9-state round-trip)', async () => {
    const STATUSES = [
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
    for (const status of STATUSES) {
      createMock.mockResolvedValueOnce({
        id: 'mem_1',
        created_at: '2026-05-22T10:00:00Z',
        conflict_resolution: { status },
      });
      const result = await memoryCreateTool.handler({
        user_id: 'user_42',
        content: 'sample',
      });
      const out = decodeStructured(result);
      expect((out.conflict_resolution as { status: string }).status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7 — Unknown conflict_resolution.status → InternalError (drift guard)
// ---------------------------------------------------------------------------
describe('memory_create — conflict_resolution status drift', () => {
  it('rejects unknown status="foo" from SDK with InternalError (backend drift)', async () => {
    createMock.mockResolvedValueOnce({
      id: 'mem_1',
      created_at: '2026-05-22T10:00:00Z',
      conflict_resolution: { status: 'foo' },
    });

    const err = await expectThrowsNexusError(() =>
      memoryCreateTool.handler({
        user_id: 'user_42',
        content: 'sample',
      }),
    );

    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.message).toMatch(/unknown conflict_resolution\.status/);
  });
});

// ---------------------------------------------------------------------------
// Case 8 — memory_type defaults to "semantic" when omitted
// ---------------------------------------------------------------------------
describe('memory_create — memory_type default', () => {
  it('defaults memory_type to "semantic" when omitted (asserted on SDK call body)', async () => {
    createMock.mockResolvedValueOnce({ id: 'mem_1', created_at: '2026-05-22T10:00:00Z' });

    await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'sample',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const body = createMock.mock.calls[0]?.[0] as { memory_type?: string };
    expect(body.memory_type).toBe('semantic');
  });

  it('honours explicit memory_type when supplied', async () => {
    createMock.mockResolvedValueOnce({ id: 'mem_1', created_at: '2026-05-22T10:00:00Z' });

    await memoryCreateTool.handler({
      user_id: 'user_42',
      content: 'sample',
      memory_type: 'episodic',
    });

    const body = createMock.mock.calls[0]?.[0] as { memory_type?: string };
    expect(body.memory_type).toBe('episodic');
  });
});

// ---------------------------------------------------------------------------
// NEXUS_DEFAULT_USER_ID pin — server-side user_id override
// ---------------------------------------------------------------------------

describe('memory_create — NEXUS_DEFAULT_USER_ID server-side pin', () => {
  it('uses the pinned user_id instead of args.user_id when NEXUS_DEFAULT_USER_ID is set', async () => {
    // Override the mock to simulate the server having a defaultUserId set.
    const { loadAuthConfig } = await import('../../../src/auth.js');
    vi.mocked(loadAuthConfig).mockReturnValueOnce({
      apiUrl: 'http://localhost:8001/v1',
      apiToken: 'sk-test-token',
      tenantId: 'tenant_test',
      defaultUserId: 'pinned-user',
    });
    __resetClientForTesting();
    createMock.mockResolvedValueOnce({ id: 'mem_pinned', created_at: '2026-05-22T10:00:00Z' });

    await memoryCreateTool.handler({
      user_id: 'llm-chose-this-user',
      content: 'some fact',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const body = createMock.mock.calls[0]?.[0] as { user_id?: string };
    // The SDK call must use the pinned value, not the LLM-supplied value.
    expect(body.user_id).toBe('pinned-user');
  });

  it('uses pinned user_id even when args.user_id is missing', async () => {
    const { loadAuthConfig } = await import('../../../src/auth.js');
    vi.mocked(loadAuthConfig).mockReturnValueOnce({
      apiUrl: 'http://localhost:8001/v1',
      apiToken: 'sk-test-token',
      tenantId: 'tenant_test',
      defaultUserId: 'pinned-user',
    });
    __resetClientForTesting();
    createMock.mockResolvedValueOnce({ id: 'mem_pinned', created_at: '2026-05-22T10:00:00Z' });

    // No user_id supplied at all — would normally throw InvalidParams, but pin rescues it.
    await memoryCreateTool.handler({
      content: 'some fact',
    });

    const body = createMock.mock.calls[0]?.[0] as { user_id?: string };
    expect(body.user_id).toBe('pinned-user');
  });
});

// ---------------------------------------------------------------------------
// SDK error mapping (nexusm-mcp-server#32) — real @nexusm/sdk error classes.
// memory_create had no SDK-error test at all before this; the catch block
// only recognised axios-shaped errors, which the SDK never throws.
// ---------------------------------------------------------------------------

const {
  ApiError: SdkApiError,
  NetworkError: SdkNetworkError,
  RateLimitError: SdkRateLimitError,
  UpstreamInterceptError: SdkUpstreamInterceptError,
} = await import('@nexusm/sdk');

describe('memory_create — SDK error mapping (real SDK classes)', () => {
  async function createAndCatch(): Promise<NexusError> {
    try {
      await memoryCreateTool.handler({
        user_id: 'u1',
        content: 'error-path memory',
        memory_type: 'semantic',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(NexusError);
      return err as NexusError;
    }
    throw new Error('handler resolved; expected it to throw');
  }

  it('RateLimitError(retryAfter=60) → RateLimited (-32012) + data.retry_after_seconds=60', async () => {
    createMock.mockRejectedValueOnce(
      new SdkRateLimitError('Rate limit exceeded. Retry after 60 seconds.', 60, {}),
    );

    const err = await createAndCatch();
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.code).toBe(-32012);
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ retry_after_seconds: 60 });
  });

  it('UpstreamInterceptError (2xx HTML) → Unauthorized + data.upstream_intercept + content_type', async () => {
    createMock.mockRejectedValueOnce(
      new SdkUpstreamInterceptError(
        'Request to /memories returned HTTP 200 with content-type "text/html" where JSON ' +
          'was expected. Something between this client and Nexus answered the request ' +
          '(auth edge, proxy, or captive portal); treating it as data would look like an ' +
          'empty result.',
        200,
        '<html>portal</html>',
      ),
    );

    const err = await createAndCatch();
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.retryable).toBe(false);
    expect(err.data).toEqual({
      upstream_intercept: true,
      http_status: 200,
      content_type: 'text/html',
    });
  });

  it('ApiError 503 → ConnectionClosed, retryable=true', async () => {
    createMock.mockRejectedValueOnce(new SdkApiError('Service Unavailable', 503, {}));

    const err = await createAndCatch();
    expect(err.mcpErrorCode).toBe(McpErrorCode.ConnectionClosed);
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('NetworkError → InternalError + data.network', async () => {
    createMock.mockRejectedValueOnce(new SdkNetworkError('connect ECONNREFUSED 127.0.0.1:8001'));

    const err = await createAndCatch();
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.httpStatus).toBeNull();
    expect(err.data).toEqual({ network: true });
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});
