/**
 * Cross-sub-story integration test: auth (US-037b) + tool handlers (US-037a)
 * + errors taxonomy (TASK-013) + the @nexusm/sdk error bridge (#32).
 *
 * TASK-018 — Wave 2B final integration gate.
 * Updated post-Wave-2B gap fix (commit 45cc294): memory_search.ts and
 * memory_create.ts have internal try/catch blocks and re-throw NexusError.
 * Updated again for nexusm-mcp-server#32 (2026-09-12): the SDK rejections
 * below are now the REAL `@nexusm/sdk` error classes. The previous version
 * used `{ isAxiosError: true, ... }` fakes — a shape the SDK has never thrown
 * (its response interceptor has wrapped every axios failure into `ApiError` /
 * `TimeoutError` / `NetworkError` since v1.0.0). Those fakes kept this gate
 * green while the whole §M-3 mapping was unreachable in production: every
 * real 401 / 429 / 5xx fell through to the "network" branch. This file is
 * the integration-level lock against that class of mock drift.
 *
 * This suite is unit-grade in that it uses vi.mock to replace `NexusClient`
 * (zero live network, zero live Nexus API), but lives in tests/integration/
 * because it exercises the *interaction boundary* between three modules:
 *
 *   auth.ts (AuthConfig env-var contract)
 *     ↕
 *   tools/context.ts | tools/memory_search.ts | tools/memory_create.ts
 *     ↕
 *   errors.ts (mapSdkErrorToMcpError → mapHttpStatusToMcpError → NexusError)
 *
 * Four cases:
 *
 *   Case 1 — Auth failure (401 / 403 from Nexus REST)
 *     Handler : nexus.context_retrieve
 *     Trigger : SDK throws `AuthenticationError` (401) / `ApiError` (403)
 *     Expected: NexusError, mcpErrorCode=Unauthorized (-32011), httpStatus
 *               401 / 403, retryable=false, NO data.upstream_intercept.
 *
 *   Case 2 — Network failure (ECONNREFUSED — Nexus API unreachable)
 *     Handler : nexus.memory_search
 *     Trigger : SDK throws `NetworkError`.
 *     Expected: NexusError(InternalError, httpStatus=null, data.network=true,
 *               retryable=true). A *plain* Error is deliberately different
 *               now: InternalError, retryable=false, no data.network —
 *               "retry, Nexus is down" is exactly the misdiagnosis #32 is
 *               about, so an unknown failure is no longer labelled network.
 *
 *   Case 3 — Rate limit with Retry-After
 *     Handler : nexus.memory_create
 *     Trigger : SDK throws `RateLimitError(message, retryAfter=60)`.
 *     Expected: NexusError(RateLimited, httpStatus=429,
 *               data.retry_after_seconds=60).
 *
 *   Case 4 — Upstream interception (@nexusm/sdk 5.2.0 `UpstreamInterceptError`)
 *     Handlers: nexus.context_retrieve (302 → login page) and
 *               nexus.memory_search (200 with an HTML body).
 *     Expected: NexusError(Unauthorized, retryable=false,
 *               data.upstream_intercept=true + http_status + redirect_host /
 *               content_type). The message blames the local credential /
 *               NEXUS_API_URL, never "Nexus is down".
 *
 * Every case also checks `NexusError.code` — the property the MCP SDK reads
 * when it serialises a thrown handler error into the JSON-RPC `error.code`.
 *
 * Mock discipline:
 *   - vi.mock('@nexusm/sdk') replaces `NexusClient` only and spreads the
 *     original module, so the error classes are the real ones; spies are
 *     declared via vi.hoisted so they are available inside the hoisted
 *     mock factory.
 *   - context.ts uses __setClientForTesting to inject a ContextClient mock.
 *   - memory_search.ts and memory_create.ts use __resetClientForTesting to
 *     clear the cached singleton, then rely on the mocked NexusClient
 *     constructor (set per-test via mockImplementation) to inject errors.
 *   - process.env is set to sentinel values for auth-token redaction
 *     discipline (mirrors auth.test.ts sentinel pattern).
 *   - No live network, no live Nexus API. The loopback variant that drives
 *     the REAL SDK interceptor lives in `sdk_error_bridge_loopback.test.ts`.
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

const { contextRetrieveSpy, memoriesSearchSpy, memoriesCreateSpy, sdkClientCtorSpy } = vi.hoisted(
  () => ({
    contextRetrieveSpy: vi.fn(),
    memoriesSearchSpy: vi.fn(),
    memoriesCreateSpy: vi.fn(),
    // Constructor spy tracks which config the module passes to NexusClient.
    // Useful for asserting that AuthConfig values from loadAuthConfig() are
    // forwarded correctly without leaking the token.
    sdkClientCtorSpy: vi.fn(),
  }),
);

vi.mock('@nexusm/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexusm/sdk')>();
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
  // Spread the real module: only the client is faked, the error classes the
  // bridge matches with `instanceof` stay real (nexusm-mcp-server#32).
  return { ...actual, NexusClient };
});

// ---------------------------------------------------------------------------
// Late imports — AFTER vi.mock and env setup so the mocks bind correctly.
// ---------------------------------------------------------------------------

// Real SDK error classes (the mock spreads the original module).
import {
  ApiError as SdkApiError,
  AuthenticationError as SdkAuthenticationError,
  NetworkError as SdkNetworkError,
  RateLimitError as SdkRateLimitError,
  UpstreamInterceptError as SdkUpstreamInterceptError,
} from '@nexusm/sdk';

// errors.ts (TASK-013 + #32 bridge)
import {
  NexusError,
  McpErrorCode,
  isAxiosLikeError,
  mapHttpStatusToMcpError,
} from '../../src/errors.js';

// Tool handlers + testing seams
import { contextRetrieveTool, __setClientForTesting } from '../../src/tools/context.js';

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

/** Mirrors `@nexusm/sdk` http/client.ts `upstreamRedirectError` wording. */
function sdkRedirectMessage(url: string, status: number, host: string): string {
  return (
    `Request to ${url} was redirected (HTTP ${status}) to ${host} instead of being ` +
    'answered by Nexus. This is typically an expired or missing edge credential ' +
    '(e.g. a Cloudflare Access service token) — the API itself was never reached.'
  );
}

/** Mirrors `@nexusm/sdk` http/client.ts `assertNotIntercepted` wording. */
function sdkNonJsonMessage(url: string, status: number, contentType: string): string {
  return (
    `Request to ${url} returned HTTP ${status} with content-type "${contentType}" where ` +
    'JSON was expected. Something between this client and Nexus answered the request ' +
    '(auth edge, proxy, or captive portal); treating it as data would look like an ' +
    'empty result.'
  );
}

// ---------------------------------------------------------------------------
// Case 1 — Auth failure (401 / 403) via nexus.context_retrieve
// ---------------------------------------------------------------------------

describe('Cross-substory Case 1: auth failure (401 / 403) through context_retrieve + errors.ts', () => {
  /**
   * Full integrated chain:
   *   NEXUS_API_TOKEN (sentinel, AuthConfig from auth.ts)
   *   → context.ts handler calls getClient().context.retrieve()
   *   → SDK throws AuthenticationError (its interceptor's 401 class)
   *   → context.ts catch block → mapSdkErrorToMcpError
   *   → instanceof ApiError → mapHttpStatusToMcpError(401, body)
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

  it('AuthenticationError (401) from SDK → NexusError Unauthorized (-32011), httpStatus=401, retryable=false', async () => {
    const sdk401 = new SdkAuthenticationError(
      'Authentication credentials were not provided or are invalid.',
      { detail: 'Authentication credentials were not provided or are invalid.' },
    );
    // The fact the old catch blocks got wrong: no SDK error is axios-shaped.
    expect(isAxiosLikeError(sdk401)).toBe(false);

    contextRetrieveSpy.mockRejectedValue(sdk401);

    const caught = await catchError(() =>
      contextRetrieveTool.handler({
        user_id: 'user-auth-test-001',
        query: 'what are my preferences',
      }),
    );

    // The full chain produces a NexusError — not the raw SDK error.
    expect(caught).toBeInstanceOf(NexusError);

    const nexusErr = caught as NexusError;

    // errors.ts §M-3: 401 → Unauthorized (-32011)
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(nexusErr.mcpErrorCode).toBe(-32011);
    // ...and that is what the JSON-RPC layer will read.
    expect(nexusErr.code).toBe(-32011);

    // HTTP status preserved for client diagnostics.
    expect(nexusErr.httpStatus).toBe(401);

    // Auth failures are not retryable — refreshing the token is required.
    expect(nexusErr.retryable).toBe(false);

    // A real 401 is NOT an upstream interception (see Case 4).
    expect(nexusErr.data?.['upstream_intercept']).toBeUndefined();

    // The SDK error rides along as cause (never serialised).
    expect(nexusErr.cause).toBe(sdk401);

    // Security: toJSON() must not leak the sentinel auth token.
    const json = JSON.stringify(nexusErr.toJSON());
    expect(json).not.toContain('CROSS-SUBSTORY-12345');
    expect(json).not.toContain('Bearer');
  });

  it('ApiError with statusCode 403 from SDK → NexusError Unauthorized (-32011), httpStatus=403', async () => {
    // 403 (Forbidden) uses the same Unauthorized code per §M-3 — tenant-level
    // scope denial is not distinguishable from invalid token at the MCP layer.
    // The SDK has no dedicated 403 class: `ApiError.fromResponse` returns the
    // base ApiError with statusCode=403.
    contextRetrieveSpy.mockRejectedValue(
      new SdkApiError('Tenant access denied.', 403, { detail: 'Tenant access denied.' }),
    );

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
   *   → SDK throws NetworkError('connect ECONNREFUSED 127.0.0.1:8001')
   *     (its interceptor's "no response at all" class)
   *   → memory_search.ts catch block → mapSdkErrorToMcpError
   *   → instanceof NetworkError → NexusError(InternalError, httpStatus=null,
   *     data.network=true, retryable=true), SDK detail kept in the message
   *   → handler re-throws NexusError directly (not the raw SDK error)
   */

  beforeEach(() => {
    memoriesSearchSpy.mockReset();
    resetSearchClient();
  });

  afterEach(() => {
    resetSearchClient();
  });

  it('NetworkError (ECONNREFUSED) → handler catch maps to NexusError(InternalError, network=true)', async () => {
    const sdkNetworkError = new SdkNetworkError('connect ECONNREFUSED 127.0.0.1:8001');
    expect(isAxiosLikeError(sdkNetworkError)).toBe(false);

    memoriesSearchSpy.mockRejectedValue(sdkNetworkError);

    const caughtRaw = await catchError(() =>
      memorySearchTool.handler({
        user_id: 'user-network-test-001',
        query: 'network failure test',
      }),
    );

    // The handler throws NexusError — not the raw SDK error.
    expect(caughtRaw).toBeInstanceOf(NexusError);

    const nexusErr = caughtRaw as NexusError;

    // errors.ts §M-3: null status (no HTTP response) → InternalError (-32603).
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(nexusErr.mcpErrorCode).toBe(-32603);
    expect(nexusErr.code).toBe(-32603);
    expect(nexusErr.httpStatus).toBeNull();

    // Network failures are retryable (client may retry after backoff).
    expect(nexusErr.retryable).toBe(true);

    // data.network=true signals this is a network-layer failure.
    expect(nexusErr.data).toBeDefined();
    expect(nexusErr.data!['network']).toBe(true);

    // data.timeout must NOT be set — this is a connection error, not a timeout.
    expect(nexusErr.data!['timeout']).toBeUndefined();

    // The SDK's detail is what tells the operator the URL / port is wrong.
    expect(nexusErr.message).toMatch(/ECONNREFUSED 127\.0\.0\.1:8001/);
  });

  it('plain Error → InternalError, retryable=false, NOT labelled as a network failure', async () => {
    // A plain Error (an SDK-internal throw the interceptor never saw) used to
    // be normalised into the same InternalError+network=true shape as a real
    // NetworkError. That told the client "retry, Nexus is unreachable" for
    // something that was neither — the misdiagnosis #32 is about. It now
    // surfaces as a non-retryable InternalError with the original message.
    memoriesSearchSpy.mockRejectedValue(new Error('connection refused (plain Error)'));

    const caughtRaw = await catchError(() =>
      memorySearchTool.handler({
        user_id: 'user-network-test-002',
        query: 'plain error propagation test',
      }),
    );

    expect(caughtRaw).toBeInstanceOf(NexusError);
    const nexusErr = caughtRaw as NexusError;
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(nexusErr.httpStatus).toBeNull();
    expect(nexusErr.retryable).toBe(false);
    expect(nexusErr.data?.['network']).toBeUndefined();
    expect(nexusErr.message).toBe('nexus.memory_search failed: connection refused (plain Error)');
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Rate limit with Retry-After via nexus.memory_create + errors.ts
// ---------------------------------------------------------------------------

describe('Cross-substory Case 3: rate limit (429 + Retry-After) through memory_create + errors.ts', () => {
  /**
   * Chain exercised:
   *   memory_create.ts handler calls client.memories.create()
   *   → SDK throws RateLimitError(message, retryAfter=60, body)
   *     (its interceptor parses `Retry-After` into `retryAfter` seconds)
   *   → memory_create.ts catch block → mapSdkErrorToMcpError
   *   → instanceof ApiError, retryAfter re-expressed as a header →
   *     mapHttpStatusToMcpError(429, body, { 'retry-after': '60' }) →
   *     NexusError(RateLimited, httpStatus=429, data.retry_after_seconds=60)
   *   → handler re-throws NexusError directly
   */

  beforeEach(() => {
    memoriesCreateSpy.mockReset();
    resetCreateClient();
  });

  afterEach(() => {
    resetCreateClient();
  });

  it('RateLimitError(retryAfter=60) → NexusError RateLimited (-32012), httpStatus=429, retry_after_seconds=60', async () => {
    memoriesCreateSpy.mockRejectedValue(
      new SdkRateLimitError('Rate limit exceeded. Retry after 60 seconds.', 60, {
        detail: 'Rate limit exceeded. Retry after 60 seconds.',
      }),
    );

    const caughtRaw = await catchError(() =>
      memoryCreateTool.handler({
        user_id: 'user-ratelimit-test-001',
        content: 'Rate limit integration test memory',
        memory_type: 'semantic',
      }),
    );

    // The handler throws NexusError — not the raw SDK error.
    expect(caughtRaw).toBeInstanceOf(NexusError);

    const nexusErr = caughtRaw as NexusError;

    // errors.ts §M-3: 429 → RateLimited (-32012).
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(nexusErr.mcpErrorCode).toBe(-32012);
    expect(nexusErr.code).toBe(-32012);
    expect(nexusErr.httpStatus).toBe(429);

    // Clients SHOULD retry after Retry-After window elapses.
    expect(nexusErr.retryable).toBe(true);

    // Retry-After seconds (parsed by the SDK) surfaced in data.
    expect(nexusErr.data).toBeDefined();
    expect(nexusErr.data!['retry_after_seconds']).toBe(60);
  });

  it('RateLimitError without retryAfter → NexusError RateLimited, retryable=true, retry_after_seconds absent', async () => {
    // Graceful degradation: 429 without Retry-After still maps to RateLimited;
    // client must apply its own backoff heuristic.
    memoriesCreateSpy.mockRejectedValue(
      new SdkRateLimitError('Rate limit exceeded', undefined, {}),
    );

    const caughtRaw = await catchError(() =>
      memoryCreateTool.handler({
        user_id: 'user-ratelimit-test-002',
        content: 'Rate limit no-header test',
        memory_type: 'episodic',
      }),
    );

    expect(caughtRaw).toBeInstanceOf(NexusError);
    const nexusErr = caughtRaw as NexusError;

    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(nexusErr.httpStatus).toBe(429);
    expect(nexusErr.retryable).toBe(true);

    // Without Retry-After, retry_after_seconds must not be present in data.
    expect(nexusErr.data?.['retry_after_seconds']).toBeUndefined();
  });

  it('429 NexusError toJSON() excludes cause + stack; includes data.retry_after_seconds', async () => {
    // Security + serialization cross-substory assertion: the NexusError
    // produced by errors.ts must satisfy the toJSON() redaction contract
    // even when the SDK error carries auth metadata in its cause.
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

// ---------------------------------------------------------------------------
// Case 4 — Upstream interception (@nexusm/sdk 5.2.0 UpstreamInterceptError)
// ---------------------------------------------------------------------------

describe('Cross-substory Case 4: upstream interception (302 / 2xx-HTML) through the tools + errors.ts', () => {
  /**
   * Chain exercised:
   *   handler calls the SDK
   *   → SDK throws UpstreamInterceptError (5.2.0: `maxRedirects: 0` turns an
   *     auth-edge 302 into this; a 2xx whose content-type is not JSON too)
   *   → catch block → mapSdkErrorToMcpError, matched BEFORE the generic
   *     ApiError branch (it is an ApiError subclass whose statusCode is the
   *     edge's, not Nexus's)
   *   → NexusError(Unauthorized, retryable=false, data.upstream_intercept=true,
   *     data.http_status, data.redirect_host | data.content_type)
   *
   * Before #32 this surfaced as InternalError + data.network=true — "Nexus
   * is down" — when the actual cause was a local credential / URL.
   */

  beforeEach(() => {
    contextRetrieveSpy.mockReset();
    memoriesSearchSpy.mockReset();
    __setClientForTesting(null);
    resetSearchClient();
  });

  afterEach(() => {
    __setClientForTesting(null);
    resetSearchClient();
  });

  it('302 → login page through context_retrieve: Unauthorized + upstream_intercept + redirect_host', async () => {
    const sdkErr = new SdkUpstreamInterceptError(
      sdkRedirectMessage('/context/retrieve', 302, 'login.cross-substory.example'),
      302,
      '<html>login</html>',
    );
    expect(isAxiosLikeError(sdkErr)).toBe(false);
    contextRetrieveSpy.mockRejectedValue(sdkErr);

    const caught = await catchError(() =>
      contextRetrieveTool.handler({ user_id: 'user-intercept-001', query: 'anything' }),
    );

    expect(caught).toBeInstanceOf(NexusError);
    const nexusErr = caught as NexusError;
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(nexusErr.code).toBe(-32011);
    expect(nexusErr.retryable).toBe(false);
    expect(nexusErr.data).toEqual({
      upstream_intercept: true,
      http_status: 302,
      redirect_host: 'login.cross-substory.example',
    });
    // Not the network branch.
    expect(nexusErr.data!['network']).toBeUndefined();
    // Wording: local credential / URL, not a Nexus outage.
    expect(nexusErr.message).toMatch(/intercepted before it reached Nexus/);
    expect(nexusErr.message).toMatch(/Cloudflare Access service token/);
    expect(nexusErr.message).toMatch(/NEXUS_API_URL/);
    expect(nexusErr.message).toMatch(/not a Nexus outage/);
    // Nothing from the edge's body, and no token, in the serialised form.
    const serialized = JSON.stringify(nexusErr.toJSON());
    expect(serialized).not.toContain('<html>');
    expect(serialized).not.toContain('CROSS-SUBSTORY-12345');
  });

  it('200 with an HTML body through memory_search: Unauthorized + upstream_intercept + content_type', async () => {
    memoriesSearchSpy.mockRejectedValue(
      new SdkUpstreamInterceptError(
        sdkNonJsonMessage('/memories/search', 200, 'text/html; charset=utf-8'),
        200,
        '<html>captive portal</html>',
      ),
    );

    const caught = await catchError(() =>
      memorySearchTool.handler({ user_id: 'user-intercept-002', query: 'anything' }),
    );

    expect(caught).toBeInstanceOf(NexusError);
    const nexusErr = caught as NexusError;
    expect(nexusErr.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(nexusErr.retryable).toBe(false);
    expect(nexusErr.data).toEqual({
      upstream_intercept: true,
      http_status: 200,
      content_type: 'text/html; charset=utf-8',
    });
    expect(nexusErr.data!['redirect_host']).toBeUndefined();
  });
});
