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

vi.mock('@nexusm/sdk', () => {
  class NexusClient {
    public readonly memories = { create: createMock };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    constructor(_config: any) {}
  }
  return { NexusClient };
});

vi.mock('../../../src/auth.js', () => ({
  loadAuthConfig: vi.fn(() => ({
    apiUrl: 'http://localhost:8001/v1',
    apiToken: 'sk-test-token',
    tenantId: 'tenant_test',
  })),
}));

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
