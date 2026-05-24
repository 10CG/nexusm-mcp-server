/**
 * Tests for src/tools/context.ts (US-037 Wave 2 TASK-009).
 *
 * Coverage (8 cases from TASK-009 brief):
 *   1. Happy path — SDK mock returns full result → retrieve_id banner +
 *      structured fields populated
 *   2. Partial degradation — SDK returns errors dict → _warnings populated,
 *      isError stays false
 *   3. as_of valid (30 days ago, ISO 8601 with timezone) — passes through
 *      to SDK
 *   4. as_of > 90 days ago → InvalidParams MCP error, SDK NOT called
 *   5. as_of without timezone → InvalidParams MCP error
 *   6. SDK throws NetworkError → propagated as MCP InternalError (not swallowed)
 *   7. limit default 10 honored when omitted
 *   8. retrieve_id banner exactly matches the required regex
 *
 * SDK is mocked with vi.mock so these tests run with zero network IO and
 * without requiring `@nexusm/sdk` to be installed at runtime — the mock
 * factory below provides everything the SUT imports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -- SDK mock -------------------------------------------------------------
// Vitest hoists vi.mock to the top of the file, so we cannot reference any
// in-scope variables from the factory. Instead, the mock exposes a captured
// `retrieve` spy via the mock module itself; tests grab it via dynamic
// `import('@nexusm/sdk')` and call its `__retrieve` accessor.
const retrieveSpy = vi.fn();

vi.mock('@nexusm/sdk', () => {
  class FakeNexusClient {
    public readonly context = { retrieve: retrieveSpy };
    constructor(_cfg: unknown) {
      // no-op
    }
  }
  return {
    NexusClient: FakeNexusClient,
    // ContextRequest / ContextRetrieveResponse are type-only — no runtime export needed.
  };
});

// Stub auth.ts so loadAuthConfig never touches process.env / process.exit.
vi.mock('../../../src/auth.js', () => ({
  loadAuthConfig: () => ({
    apiUrl: 'http://nexus.test',
    apiToken: 'sk-test-token',
    tenantId: 'tenant-test',
  }),
}));

// Late import AFTER vi.mock so the mocks bind correctly.
const { contextRetrieveTool, validateAsOf, __setClientForTesting } =
  await import('../../../src/tools/context.js');
const { NexusError, McpErrorCode } = await import('../../../src/errors.js');

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

const HAPPY_RESPONSE = {
  retrieve_id: '11111111-2222-3333-4444-555555555555',
  profile: {
    memories: [
      {
        id: 'm1',
        content: 'likes tea',
        memory_type: 'semantic',
        created_at: '2026-05-01T00:00:00Z',
      },
      {
        id: 'm2',
        content: 'prefers Vim',
        memory_type: 'semantic',
        created_at: '2026-05-02T00:00:00Z',
      },
    ],
    total_count: 2,
  },
  history: {
    messages: [{ role: 'user', content: 'hi', created_at: '2026-05-10T00:00:00Z' }],
  },
  graph: {
    entities: [{ id: 'e1', name: 'Acme', entity_type: 'Organization' }],
    relations: [],
  },
  meta: { took_ms: 42 },
  errors: null,
};

beforeEach(() => {
  retrieveSpy.mockReset();
  // Force the SUT's lazy client cache to use our fake NexusClient on first call.
  __setClientForTesting(null);
});

afterEach(() => {
  __setClientForTesting(null);
});

function getStructured(
  result: Awaited<ReturnType<typeof contextRetrieveTool.handler>>,
): Record<string, unknown> {
  // Prefer the structured field; fall back to parsing content[1].text.
  const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (sc) return sc;
  const second = result.content[1];
  if (second && second.type === 'text') {
    return JSON.parse(second.text);
  }
  throw new Error('no structured payload');
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('nexus.context_retrieve — happy path', () => {
  it('returns retrieve_id banner + populated structured fields (case 1)', async () => {
    retrieveSpy.mockResolvedValue(HAPPY_RESPONSE);

    const result = await contextRetrieveTool.handler({
      user_id: 'u1',
      query: 'what do I like',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const bannerText = (result.content[0] as { text: string }).text;
    expect(bannerText).toContain('retrieve_id=11111111-2222-3333-4444-555555555555');

    const structured = getStructured(result);
    expect(structured.retrieve_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(structured.memories).toHaveLength(2);
    expect(structured.conversation_turns).toHaveLength(1);
    expect(structured.knowledge_entities).toHaveLength(1);
    expect(structured.errors).toBeNull();
    expect(structured._warnings).toEqual([]);
  });
});

describe('nexus.context_retrieve — partial degradation (R2 M-3)', () => {
  it('passes errors dict through and populates _warnings; isError stays false (case 2)', async () => {
    retrieveSpy.mockResolvedValue({
      ...HAPPY_RESPONSE,
      graph: { entities: [], relations: [] },
      errors: { graph: 'timeout connecting to GraphRAG' },
    });

    const result = await contextRetrieveTool.handler({
      user_id: 'u1',
      query: 'q',
    });

    expect(result.isError).toBe(false);
    const structured = getStructured(result);
    expect(structured.errors).toEqual({ graph: 'timeout connecting to GraphRAG' });
    const warnings = structured._warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/graph/);
    expect(warnings[0]).toMatch(/degraded/);
  });
});

describe('nexus.context_retrieve — as_of validation', () => {
  it('accepts a 30-day-old ISO 8601 with timezone and forwards it to SDK (case 3)', async () => {
    retrieveSpy.mockResolvedValue(HAPPY_RESPONSE);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // "...Z" — has timezone

    await contextRetrieveTool.handler({
      user_id: 'u1',
      query: 'q',
      as_of: thirtyDaysAgo,
    });

    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    const sdkArg = retrieveSpy.mock.calls[0][0];
    expect(sdkArg.as_of).toBe(thirtyDaysAgo);
  });

  it('rejects an as_of > 90 days ago with InvalidParams; SDK is NOT called (case 4)', async () => {
    retrieveSpy.mockResolvedValue(HAPPY_RESPONSE);

    const tooOld = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();

    let caught: unknown;
    try {
      await contextRetrieveTool.handler({
        user_id: 'u1',
        query: 'q',
        as_of: tooOld,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as InstanceType<typeof NexusError>).mcpErrorCode).toBe(
      McpErrorCode.InvalidParams,
    );
    expect((caught as Error).message).toMatch(/90 days/);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('rejects an as_of without timezone with InvalidParams (case 5)', async () => {
    retrieveSpy.mockResolvedValue(HAPPY_RESPONSE);

    let caught: unknown;
    try {
      await contextRetrieveTool.handler({
        user_id: 'u1',
        query: 'q',
        as_of: '2026-05-01T00:00:00', // naive — no tz suffix
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as InstanceType<typeof NexusError>).mcpErrorCode).toBe(
      McpErrorCode.InvalidParams,
    );
    expect((caught as Error).message).toMatch(/timezone/);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('validateAsOf is a pure helper that throws or returns silently', () => {
    // Sanity check — covers the helper directly without going through SDK.
    expect(() => validateAsOf(undefined)).not.toThrow();
    expect(() =>
      validateAsOf('2026-05-01T00:00:00Z', new Date('2026-05-15T00:00:00Z')),
    ).not.toThrow();
    expect(() => validateAsOf('not-a-date')).toThrow(NexusError);
  });
});

describe('nexus.context_retrieve — SDK failures propagate', () => {
  it('NetworkError from SDK surfaces as NexusError InternalError (case 6)', async () => {
    class FakeNetworkError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'NetworkError';
      }
    }
    retrieveSpy.mockRejectedValue(new FakeNetworkError('ECONNREFUSED'));

    let caught: unknown;
    try {
      await contextRetrieveTool.handler({ user_id: 'u1', query: 'q' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as InstanceType<typeof NexusError>).mcpErrorCode).toBe(
      McpErrorCode.InternalError,
    );
    expect((caught as Error).message).toMatch(/ECONNREFUSED/);
  });
});

describe('nexus.context_retrieve — defaults', () => {
  it('honors limit=10 default when omitted (case 7)', async () => {
    retrieveSpy.mockResolvedValue(HAPPY_RESPONSE);

    await contextRetrieveTool.handler({ user_id: 'u1', query: 'q' });

    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    const sdkArg = retrieveSpy.mock.calls[0][0];
    // limit fans out into the three per-layer SDK limits.
    expect(sdkArg.profile_limit).toBe(10);
    expect(sdkArg.history_limit).toBe(10);
    expect(sdkArg.graph_limit).toBe(10);
  });
});

describe('nexus.context_retrieve — banner format', () => {
  it('content[0].text starts with the exact retrieve_id banner (case 8)', async () => {
    retrieveSpy.mockResolvedValue(HAPPY_RESPONSE);

    const result = await contextRetrieveTool.handler({ user_id: 'u1', query: 'q' });
    const text = (result.content[0] as { text: string }).text;
    // Regex per brief: `## Retrieved context (retrieve_id=<uuid>)\n`
    const re =
      /^## Retrieved context \(retrieve_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)\n/;
    expect(text).toMatch(re);
  });
});
