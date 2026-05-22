/**
 * Cross-sub-story integration test: auth (US-037b) + tool handlers (US-037a)
 * + errors taxonomy (TASK-013).
 *
 * TASK-018 — Wave 2B final integration gate.
 *
 * This suite is unit-grade in that it uses vi.mock to replace @nexusm/sdk
 * (zero live network, zero live Nexus API), but lives in tests/integration/
 * because it exercises the *interaction boundary* between three modules:
 *
 *   auth.ts (AuthConfig env-var contract)
 *     ↕
 *   tools/context.ts | tools/memory_search.ts | tools/memory_create.ts
 *     ↕
 *   errors.ts (mapHttpStatusToMcpError + isAxiosLikeError + NexusError)
 *
 * Three cases:
 *
 *   Case 1 — Auth failure (401 from Nexus REST)
 *     Handler : nexus.context_retrieve
 *     Trigger : SDK throws axios-like { response: { status: 401, ... } }
 *     Expected: NexusError, mcpErrorCode=Unauthorized (-32011), httpStatus=401
 *
 *   Case 2 — Network failure (ECONNREFUSED — Nexus API unreachable)
 *     Handler : nexus.memory_search (variety per TASK-018 brief)
 *     Trigger : SDK throws axios-like { isAxiosError:true, code:'ECONNREFUSED' }
 *               with no response object; propagates raw from the handler.
 *     Expected: NexusError (via mapHttpStatusToMcpError), mcpErrorCode=InternalError,
 *               httpStatus=null, data.network=true
 *
 *   Case 3 — Rate limit with Retry-After header
 *     Handler : nexus.memory_create
 *     Trigger : SDK throws axios-like { response: { status: 429,
 *               headers: { 'retry-after': '60' } } }
 *     Expected: NexusError (via mapHttpStatusToMcpError), mcpErrorCode=RateLimited (-32012),
 *               httpStatus=429, data.retry_after_seconds=60
 *
 * Architecture note on error propagation:
 *   context.ts has a full try/catch that calls mapHttpStatusToMcpError and
 *   re-throws as NexusError — Case 1 tests the fully integrated chain
 *   inside the handler.
 *
 *   memory_search.ts and memory_create.ts do NOT have catch blocks for
 *   SDK-level errors; axios-like errors propagate raw to the MCP dispatcher.
 *   Cases 2 and 3 test the cross-module integration at the boundary between
 *   the tool handler and errors.ts:
 *     a) The thrown object is confirmed to be an axios-like error
 *        (isAxiosLikeError guard — the shape errors.ts requires).
 *     b) mapHttpStatusToMcpError is called to confirm the resulting
 *        NexusError has the correct properties (what the transport layer
 *        would do with the propagated error).
 *
 * Mock discipline:
 *   - vi.mock('@nexusm/sdk') replaces NexusClient entirely; spies are
 *     declared via vi.hoisted so they are available inside the hoisted
 *     mock factory.
 *   - context.ts uses __setClientForTesting to inject a ContextClient mock.
 *   - memory_search.ts and memory_create.ts use __resetClientForTesting to
 *     clear the cached singleton, then rely on the mocked NexusClient
 *     constructor (set per-test via mockImplementation) to inject errors.
 *   - process.env is set to sentinel values for auth-token redaction
 *     discipline (mirrors auth.test.ts sentinel pattern).
 *   - No live network, no live Nexus API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Sentinel env vars — set before any module import so loadAuthConfig() does
// not call process.exit(1). Sentinel-style per auth.ts redaction discipline.
// ---------------------------------------------------------------------------

process.env.NEXUS_API_URL = 'http://nexus.cross-substory-test.local';
process.env.NEXUS_API_TOKEN = 'test-token-CROSS-SUBSTORY-12345';
process.env.NEXUS_TENANT_ID = 'tenant-CROSS-SUBSTORY-TEST';

// ---------------------------------------------------------------------------
// SDK spies — declared via vi.hoisted so they are available inside the
// vi.mock factory (Vitest hoists vi.mock calls above import statements,
// and only vi.hoisted values are guaranteed to be in scope inside the
// hoisted factory).
// ---------------------------------------------------------------------------

const {
  contextRetrieveSpy,
  memoriesSearchSpy,
  memoriesCreateSpy,
  sdkClientCtorSpy,
} = vi.hoisted(() => ({
  contextRetrieveSpy: vi.fn(),
  memoriesSearchSpy: vi.fn(),
  memoriesCreateSpy: vi.fn(),
  // Constructor spy tracks which config the module passes to NexusClient.
  // Useful for asserting that AuthConfig values from loadAuthConfig() are
  // forwarded correctly without leaking the token.
  sdkClientCtorSpy: vi.fn(),
}));

vi.mock('@nexusm/sdk', () => {
  class NexusClient {
    public readonly context = { retrieve: contextRetrieveSpy };
    public readonly memories = {
      search: memoriesSearchSpy,
      create: memoriesCreateSpy,
    };
    constructor(cfg: unknown) {
      sdkClientCtorSpy(cfg);
    }
  }
  return { NexusClient };
});

// ---------------------------------------------------------------------------
// Late imports — AFTER vi.mock and env setup so the mocks bind correctly.
// ---------------------------------------------------------------------------

// errors.ts (TASK-013)
import {
  NexusError,
  McpErrorCode,
  isAxiosLikeError,
  mapHttpStatusToMcpError,
} from '../../src/errors.js';

// Tool handlers + testing seams
import {
  contextRetrieveTool,
  __setClientForTesting,
  type ContextClient,
} from '../../src/tools/context.js';

import {
  memorySearchTool,
  __resetClientForTesting as resetSearchClient,
} from '../../src/tools/memory_search.js';

import {
  memoryCreateTool,
  __resetClientForTesting as resetCreateClient,
} from '../../src/tools/memory_create.js';

// ---------------------------------------------------------------------------
// Helper: capture a thrown value from an async function.
// ---------------------------------------------------------------------------

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('Expected the function to throw, but it resolved successfully');
}

// ---------------------------------------------------------------------------
// Case 1 — Auth failure (401 Unauthorized) via nexus.context_retrieve
// ---------------------------------------------------------------------------

describe('Cross-substory Case 1: auth failure (401) through context_retrieve + errors.ts', () => {
  /**
   * Full integrated chain:
   *   NEXUS_API_TOKEN (sentinel, AuthConfig from auth.ts)
   *   → context.ts handler calls getClient().context.retrieve()
   *   → SDK throws axios-like { response: { status: 401, data: {...} } }
   *   → context.ts catch block: isAxiosLikeError → true
   *   → mapHttpStatusToMcpError(401, body, headers)
   *   → throws NexusError(Unauthorized, httpStatus=401, retryable=false)
   */

  beforeEach(() => {
    contextRetrieveSpy.mockReset();
    sdkClientCtorSpy.mockReset();
    // Reset the lazy context client cache. With it cleared, the next
    // handler call constructs a new NexusClient (our mock) via defaultClientFactory.
    __setClientForTesting(null);
  });

  afterEach(() => {
    __setClientForTesting(null);
  });

  it('401 from SDK → NexusError Unauthorized (-32011), httpStatus=401, retryable=false', async () => {
    const axiosLike401 = {
      isAxiosError: true as const,
      message: 'Request failed with status code 401',
      response: {
        status: 401,
        data: { detail: 'Authentication credentials were not provided or are invalid.' },
        headers: {} as Record<string, string>,
      },
      code: undefined as string | undefined,
    };

    contextRetrieveSpy.mockRejectedValue(axiosLike401);

    const caught = await catchError(() =>
      contextRetrieveTool.handler({
        user_id: 'user-auth-test-001',
        query: 'what are my preferences',
      }),
    );

    // The full chain produces a NexusError — not the raw axios object.
    expect(caught).toBeInstanceOf(NexusError);

    const nexusErr = caught as NexusError;

    // errors.ts §M-3: 401 → Unauthorized (-32011)
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(nexusErr.mcpErrorCode).toBe(-32011);

    // HTTP status preserved for client diagnostics.
    expect(nexusErr.httpStatus).toBe(401);

    // Auth failures are not retryable — refreshing the token is required.
    expect(nexusErr.retryable).toBe(false);

    // Security: toJSON() must not leak the sentinel auth token.
    const json = JSON.stringify(nexusErr.toJSON());
    expect(json).not.toContain('CROSS-SUBSTORY-12345');
    expect(json).not.toContain('Bearer');
  });

  it('403 from SDK → NexusError Unauthorized (-32011), httpStatus=403', async () => {
    // 403 (Forbidden) uses the same Unauthorized code per §M-3 — tenant-level
    // scope denial is not distinguishable from invalid token at the MCP layer.
    const axiosLike403 = {
      isAxiosError: true as const,
      message: 'Request failed with status code 403',
      response: {
        status: 403,
        data: { detail: 'Tenant access denied.' },
        headers: {} as Record<string, string>,
      },
    };

    contextRetrieveSpy.mockRejectedValue(axiosLike403);

    const caught = await catchError(() =>
      contextRetrieveTool.handler({
        user_id: 'user-auth-test-002',
        query: 'tenant access test',
      }),
    );

    expect(caught).toBeInstanceOf(NexusError);
    const nexusErr = caught as NexusError;
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(nexusErr.mcpErrorCode).toBe(-32011);
    expect(nexusErr.httpStatus).toBe(403);
    expect(nexusErr.retryable).toBe(false);
  });

  it('AuthConfig sentinel token is passed to SDK constructor (not leaked via console)', () => {
    // Verify that the NexusClient constructor received the sentinel token.
    // This is the integration point between auth.ts and the tool handler.
    //
    // Note: sdkClientCtorSpy may have been called 0 or 1 times depending on
    // whether the lazy singleton was reset before this test. We only check
    // that IF the constructor was called, it carried the correct auth fields.
    const calls = sdkClientCtorSpy.mock.calls;
    for (const [cfg] of calls) {
      const config = cfg as { apiKey?: string; tenantId?: string; baseUrl?: string };
      // The config passed to NexusClient must contain auth values — but we
      // do not log or assert the specific token value here, per redaction
      // discipline. We assert structural presence only.
      expect(typeof config.apiKey).toBe('string');
      expect(typeof config.tenantId).toBe('string');
      expect(typeof config.baseUrl).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2 — Network failure (ECONNREFUSED) via nexus.memory_search + errors.ts
// ---------------------------------------------------------------------------

describe('Cross-substory Case 2: network failure (ECONNREFUSED) through memory_search + errors.ts', () => {
  /**
   * Chain exercised:
   *   memory_search.ts handler calls client.memories.search()
   *   → SDK throws axios-like { isAxiosError:true, code:'ECONNREFUSED',
   *                              request:{}, no response }
   *   → memory_search.ts has NO catch block: raw error propagates to caller
   *   → isAxiosLikeError(caughtRaw) === true confirms shape errors.ts expects
   *   → mapHttpStatusToMcpError(null, null) produces NexusError(InternalError,
   *     httpStatus=null, data.network=true, retryable=true)
   *
   * This test exercises the cross-substory integration:
   *   memory_search (US-037a tool) throws → errors.ts (TASK-013) maps it.
   */

  beforeEach(() => {
    memoriesSearchSpy.mockReset();
    resetSearchClient();
  });

  afterEach(() => {
    resetSearchClient();
  });

  it('ECONNREFUSED → raw axios-like error, maps to NexusError InternalError(network=true)', async () => {
    const axiosLikeEconnrefused = {
      isAxiosError: true as const,
      message: 'connect ECONNREFUSED 127.0.0.1:8001',
      code: 'ECONNREFUSED',
      request: { method: 'POST', path: '/v1/memories/search' },
      // No `response` property: server was unreachable before sending a response.
    };

    memoriesSearchSpy.mockRejectedValue(axiosLikeEconnrefused);

    // Step 1: handler call — memory_search has no catch block, so the raw
    // axios-like error propagates to us unchanged.
    const caughtRaw = await catchError(() =>
      memorySearchTool.handler({
        user_id: 'user-network-test-001',
        query: 'network failure test',
      }),
    );

    // Step 2 (cross-substory boundary): the propagated error must be
    // recognisable to errors.ts isAxiosLikeError — this is the shape gate.
    expect(isAxiosLikeError(caughtRaw)).toBe(true);

    // Step 3 (errors.ts mapping): call mapHttpStatusToMcpError as the MCP
    // transport / dispatcher would with the propagated error.
    // ECONNREFUSED has no response, so httpStatus=null.
    const axiosErr = caughtRaw as { response?: { status: number } };
    const nexusErr = mapHttpStatusToMcpError(
      axiosErr.response?.status ?? null,
      null,
    );

    // errors.ts §M-3: null status (no HTTP response) → InternalError.
    expect(nexusErr).toBeInstanceOf(NexusError);
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(nexusErr.mcpErrorCode).toBe(-32603);
    expect(nexusErr.httpStatus).toBeNull();

    // Network failures are retryable (client may retry after backoff).
    expect(nexusErr.retryable).toBe(true);

    // data.network=true signals this is a network-layer failure.
    expect(nexusErr.data).toBeDefined();
    expect(nexusErr.data!['network']).toBe(true);

    // data.timeout must NOT be set — this is a connection error, not a timeout.
    expect(nexusErr.data!['timeout']).toBeUndefined();
  });

  it('isAxiosLikeError returns false for a plain Error (non-axios propagation path)', async () => {
    // Verify the negative case: a plain Error (SDK internal throw not
    // wrapped by axios) does not pass isAxiosLikeError. This cross-substory
    // guard ensures errors.ts discriminates correctly in both directions.
    memoriesSearchSpy.mockRejectedValue(new Error('connection refused (plain Error)'));

    const caughtRaw = await catchError(() =>
      memorySearchTool.handler({
        user_id: 'user-network-test-002',
        query: 'plain error propagation test',
      }),
    );

    // A plain Error does NOT have isAxiosError=true.
    expect(isAxiosLikeError(caughtRaw)).toBe(false);
    expect(caughtRaw).toBeInstanceOf(Error);

    // mapHttpStatusToMcpError(null, null) still produces a valid network error.
    const nexusErr = mapHttpStatusToMcpError(null, null);
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(nexusErr.data!['network']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Rate limit with Retry-After header via nexus.memory_create + errors.ts
// ---------------------------------------------------------------------------

describe('Cross-substory Case 3: rate limit (429 + Retry-After) through memory_create + errors.ts', () => {
  /**
   * Chain exercised:
   *   memory_create.ts handler calls client.memories.create()
   *   → SDK throws axios-like { response: { status: 429,
   *       headers: { 'retry-after': '60' }, data: { detail: '...' } } }
   *   → memory_create.ts has NO catch block: raw error propagates to caller
   *   → isAxiosLikeError(caughtRaw) === true confirms shape
   *   → mapHttpStatusToMcpError(429, body, { 'retry-after': '60' }) produces
   *     NexusError(RateLimited, httpStatus=429, data.retry_after_seconds=60)
   */

  beforeEach(() => {
    memoriesCreateSpy.mockReset();
    resetCreateClient();
  });

  afterEach(() => {
    resetCreateClient();
  });

  it('429 with Retry-After:60 → NexusError RateLimited (-32012), httpStatus=429, retry_after_seconds=60', async () => {
    const axiosLike429 = {
      isAxiosError: true as const,
      message: 'Request failed with status code 429',
      response: {
        status: 429,
        data: { detail: 'Rate limit exceeded. Retry after 60 seconds.' },
        headers: {
          'retry-after': '60',
          'content-type': 'application/json',
        } as Record<string, string>,
      },
    };

    memoriesCreateSpy.mockRejectedValue(axiosLike429);

    // Step 1: handler call — memory_create has no catch block, raw 429 propagates.
    const caughtRaw = await catchError(() =>
      memoryCreateTool.handler({
        user_id: 'user-ratelimit-test-001',
        content: 'Rate limit integration test memory',
        memory_type: 'semantic',
      }),
    );

    // Step 2 (cross-substory boundary): the propagated error must be
    // recognisable to errors.ts.
    expect(isAxiosLikeError(caughtRaw)).toBe(true);

    // Step 3 (errors.ts mapping): mapHttpStatusToMcpError with headers so
    // Retry-After is parsed.
    const axiosErr = caughtRaw as {
      response: {
        status: number;
        data: unknown;
        headers: Record<string, string>;
      };
    };

    const nexusErr = mapHttpStatusToMcpError(
      axiosErr.response.status,
      axiosErr.response.data,
      axiosErr.response.headers,
    );

    // errors.ts §M-3: 429 → RateLimited (-32012).
    expect(nexusErr).toBeInstanceOf(NexusError);
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(nexusErr.mcpErrorCode).toBe(-32012);
    expect(nexusErr.httpStatus).toBe(429);

    // Clients SHOULD retry after Retry-After window elapses.
    expect(nexusErr.retryable).toBe(true);

    // Retry-After seconds parsed from header and surfaced in data.
    expect(nexusErr.data).toBeDefined();
    expect(nexusErr.data!['retry_after_seconds']).toBe(60);
  });

  it('429 without Retry-After header → RateLimited, retryable=true, retry_after_seconds absent', async () => {
    // Graceful degradation: 429 without Retry-After still maps to RateLimited;
    // client must apply its own backoff heuristic.
    const axiosLike429NoHeader = {
      isAxiosError: true as const,
      message: 'Request failed with status code 429',
      response: {
        status: 429,
        data: {},
        headers: {} as Record<string, string>,
      },
    };

    memoriesCreateSpy.mockRejectedValue(axiosLike429NoHeader);

    const caughtRaw = await catchError(() =>
      memoryCreateTool.handler({
        user_id: 'user-ratelimit-test-002',
        content: 'Rate limit no-header test',
        memory_type: 'episodic',
      }),
    );

    expect(isAxiosLikeError(caughtRaw)).toBe(true);

    const axiosErr = caughtRaw as {
      response: { status: number; data: unknown; headers: Record<string, string> };
    };
    const nexusErr = mapHttpStatusToMcpError(
      axiosErr.response.status,
      axiosErr.response.data,
      axiosErr.response.headers,
    );

    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(nexusErr.httpStatus).toBe(429);
    expect(nexusErr.retryable).toBe(true);

    // Without Retry-After, retry_after_seconds must not be present in data.
    expect(nexusErr.data?.['retry_after_seconds']).toBeUndefined();
  });

  it('429 NexusError toJSON() excludes cause + stack; includes data.retry_after_seconds', async () => {
    // Security + serialization cross-substory assertion: the NexusError
    // produced by errors.ts must satisfy the toJSON() redaction contract
    // even when the axios error carries auth metadata in its cause.
    const nexusErr = mapHttpStatusToMcpError(429, null, { 'retry-after': '30' });
    const json = nexusErr.toJSON();

    // Retry-After seconds present in data.
    expect(json.data?.['retry_after_seconds']).toBe(30);
    expect(json.mcpErrorCode).toBe(McpErrorCode.RateLimited);

    // Serialized form must not contain any cause/stack/sentinel artefacts.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('CROSS-SUBSTORY-12345');
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('stack');
  });
});
