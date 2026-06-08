/**
 * Tests for src/tools/memory_search.ts (US-037 TASK-010, Wave 2).
 *
 * Verifies the wired handler:
 *   1. mode='semantic' is forwarded verbatim to the SDK call body
 *   2. mode='hybrid' is forwarded verbatim
 *   3. Omitted mode is defaulted to 'hybrid' before reaching the SDK
 *      (proposal §M-11 + §A2-D-1: no pure-keyword mode in Phase 1)
 *   4. score_threshold is forwarded under its locked name (NOT renamed
 *      to the SDK's older `threshold` alias)
 *   5. An invalid mode value (e.g. 'keyword') is rejected with an MCP
 *      `InvalidParams` protocol error
 *
 * Strategy: `vi.mock('@nexusm/sdk', ...)` replaces `NexusClient` with a
 * spyable stub so we can assert on the search() call shape without
 * actually performing HTTP.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpErrorCode, NexusError } from '../../../src/errors.js';

// Use vi.hoisted so the spy reference is safely available inside the
// hoisted vi.mock factory (vitest hoists vi.mock calls above imports,
// and only `vi.hoisted`-wrapped values are guaranteed to coexist).
const { searchSpy } = vi.hoisted(() => ({
  // SDK 2.0.0 (ADR-003): MemorySearchResult = { results: SearchResult[], query, total_found, search_time_ms }
  searchSpy: vi.fn<
    [unknown],
    Promise<{ results: unknown[]; query: string; total_found: number; search_time_ms: number }>
  >(),
}));

vi.mock('@nexusm/sdk', () => {
  return {
    NexusClient: vi.fn().mockImplementation(() => ({
      memories: {
        search: (body: unknown) => searchSpy(body),
      },
    })),
  };
});

// Pre-set the auth env vars so loadAuthConfig() inside the handler does
// not call process.exit(1). These values are arbitrary fixtures —
// nothing reaches the network because @nexusm/sdk is fully mocked.
process.env.NEXUS_API_URL = 'http://test.local';
process.env.NEXUS_API_TOKEN = 'test-token';
process.env.NEXUS_TENANT_ID = 'test-tenant';

// Import after vi.mock + env setup so the SDK mock is in place when the
// module's top-level imports resolve.
const { memorySearchTool, __resetClientForTesting } =
  await import('../../../src/tools/memory_search.js');

beforeEach(() => {
  searchSpy.mockReset();
  searchSpy.mockResolvedValue({ results: [], query: 'q', total_found: 0, search_time_ms: 1 });
  __resetClientForTesting();
});

describe('memory_search — mode forwarding', () => {
  it('forwards mode="semantic" to the SDK call body', async () => {
    await memorySearchTool.handler({
      user_id: 'u1',
      query: 'q1',
      mode: 'semantic',
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({
      user_id: 'u1',
      query: 'q1',
      mode: 'semantic',
    });
  });

  it('forwards mode="hybrid" to the SDK call body', async () => {
    await memorySearchTool.handler({
      user_id: 'u2',
      query: 'q2',
      mode: 'hybrid',
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({
      user_id: 'u2',
      query: 'q2',
      mode: 'hybrid',
    });
  });

  it('defaults omitted mode to "hybrid" (proposal §A2-D-1)', async () => {
    await memorySearchTool.handler({
      user_id: 'u3',
      query: 'q3',
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    const body = searchSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.mode).toBe('hybrid');
  });
});

describe('memory_search — score_threshold passthrough', () => {
  it('passes score_threshold=0.7 through under the locked field name', async () => {
    await memorySearchTool.handler({
      user_id: 'u4',
      query: 'q4',
      score_threshold: 0.7,
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    const body = searchSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.score_threshold).toBe(0.7);
    // Locked schema uses `score_threshold`, not the SDK's historical `threshold`.
    expect(body.threshold).toBeUndefined();
  });
});

describe('memory_search — enum validation', () => {
  it('rejects mode="keyword" with MCP InvalidParams (not allowed per A2-D-1)', async () => {
    let caught: unknown = null;
    try {
      await memorySearchTool.handler({
        user_id: 'u5',
        query: 'q5',
        mode: 'keyword',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
