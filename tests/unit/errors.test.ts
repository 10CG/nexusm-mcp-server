/**
 * Runtime tests for errors.ts contract — the type-only declarations don't
 * need tests, but `NexusError.toJSON()` has a security guarantee that does:
 *
 *   When a NexusError carries a `cause` (typically an axios error or fetch
 *   response object whose `config` / `request.headers` would contain
 *   `Authorization: Bearer <token>`), `JSON.stringify(error)` MUST NOT
 *   leak the token. Same discipline as `auth.ts`'s stderr redaction.
 *
 * Sentinel token mirrors `auth.test.ts` so a single grep of test code
 * finds every redaction check.
 */
import { describe, it, expect } from 'vitest';
import {
  ApiError as SdkApiError,
  AuthenticationError as SdkAuthenticationError,
  InputValidationError as SdkInputValidationError,
  NetworkError as SdkNetworkError,
  NotFoundError as SdkNotFoundError,
  RateLimitError as SdkRateLimitError,
  TimeoutError as SdkTimeoutError,
  UpstreamInterceptError as SdkUpstreamInterceptError,
  ValidationError as SdkValidationError,
} from '@nexusm/sdk';
import {
  NexusError,
  McpErrorCode,
  mapHttpStatusToMcpError,
  mapSdkErrorToMcpError,
  isAxiosLikeError,
} from '../../src/errors.js';

const SENTINEL_TOKEN = 'sk-test-SECRET-12345';

describe('NexusError.toJSON', () => {
  it('serializes exactly {name, message, httpStatus, mcpErrorCode} — no cause, no stack', () => {
    const err = new NexusError(
      'something went wrong',
      McpErrorCode.InternalError,
      503,
      new Error('underlying'),
    );

    const json = err.toJSON();
    expect(Object.keys(json).sort()).toEqual(
      ['httpStatus', 'mcpErrorCode', 'message', 'name'].sort(),
    );
    expect(json).not.toHaveProperty('cause');
    expect(json).not.toHaveProperty('stack');
  });

  it('does not leak a bearer token carried in cause when stringified', () => {
    // Simulated axios-style error: token lives in cause.config.headers.
    const fakeAxiosError = {
      message: 'Request failed with status code 401',
      config: {
        url: 'https://api.example.com/v1/memory/search',
        headers: { Authorization: `Bearer ${SENTINEL_TOKEN}` },
      },
      response: { status: 401 },
    };

    const err = new NexusError(
      'Upstream auth rejected',
      McpErrorCode.InvalidRequest,
      401,
      fakeAxiosError,
    );

    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain(SENTINEL_TOKEN);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
  });

  it('does not include the stack trace in JSON output', () => {
    const err = new NexusError('with stack', McpErrorCode.InternalError);
    expect(err.stack).toBeDefined();
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain('at NexusError');
    expect(serialized).not.toContain('at Object.<anonymous>');
  });

  it('preserves httpStatus null for non-HTTP origins (e.g. network errors)', () => {
    const err = new NexusError('DNS resolution failed', McpErrorCode.InternalError);
    expect(err.toJSON().httpStatus).toBeNull();
  });
});

describe('NexusError construction', () => {
  it('sets name = "NexusError"', () => {
    const err = new NexusError('hi', McpErrorCode.InternalError, 500);
    expect(err.name).toBe('NexusError');
  });

  it('is instanceof Error and NexusError', () => {
    const err = new NexusError('x', McpErrorCode.InvalidParams, 400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NexusError);
  });
});

// ---------------------------------------------------------------------------
// mapHttpStatusToMcpError — TASK-013 Wave 2B (proposal §M-3)
// ---------------------------------------------------------------------------

describe('mapHttpStatusToMcpError — HTTP status mapping', () => {
  it('401 → Unauthorized, retryable=false', () => {
    const err = mapHttpStatusToMcpError(401, null);
    expect(err).toBeInstanceOf(NexusError);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
  });

  it('403 → Unauthorized, retryable=false', () => {
    const err = mapHttpStatusToMcpError(403, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.httpStatus).toBe(403);
    expect(err.retryable).toBe(false);
  });

  it('404 → MethodNotFound, retryable=false', () => {
    const err = mapHttpStatusToMcpError(404, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.MethodNotFound);
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it('422 → InvalidParams with body, retryable=false', () => {
    const body = { detail: 'user_id is required' };
    const err = mapHttpStatusToMcpError(422, body);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.httpStatus).toBe(422);
    expect(err.retryable).toBe(false);
  });

  it('429 with Retry-After header → RateLimited, retryable=true, data.retry_after_seconds=60', () => {
    const err = mapHttpStatusToMcpError(429, null, { 'retry-after': '60' });
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.data).toBeDefined();
    expect(err.data!['retry_after_seconds']).toBe(60);
  });

  it('429 without Retry-After → RateLimited, retryable=true, data is empty or undefined', () => {
    const err = mapHttpStatusToMcpError(429, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.retryable).toBe(true);
    // No retry_after_seconds when header is absent
    expect(err.data?.['retry_after_seconds']).toBeUndefined();
  });

  it('503 → ConnectionClosed, retryable=true', () => {
    const err = mapHttpStatusToMcpError(503, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.ConnectionClosed);
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('500 → InternalError, retryable=true', () => {
    const err = mapHttpStatusToMcpError(500, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.httpStatus).toBe(500);
    expect(err.retryable).toBe(true);
  });

  it('502 (non-503 5xx) → InternalError, retryable=true', () => {
    const err = mapHttpStatusToMcpError(502, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.retryable).toBe(true);
  });
});

describe('mapHttpStatusToMcpError — non-HTTP (null status) errors', () => {
  it('null status without timeout hint → InternalError, retryable=true, data.network=true', () => {
    const err = mapHttpStatusToMcpError(null, null);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.data?.['network']).toBe(true);
  });

  it('null status with timeout hint → RequestTimeout, retryable=true, data.timeout=true', () => {
    const err = mapHttpStatusToMcpError(null, { timeout: true });
    expect(err.mcpErrorCode).toBe(McpErrorCode.RequestTimeout);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.data?.['timeout']).toBe(true);
  });
});

describe('mapHttpStatusToMcpError — toJSON includes data field when populated', () => {
  it('429 with Retry-After: toJSON() includes data.retry_after_seconds', () => {
    const err = mapHttpStatusToMcpError(429, null, { 'retry-after': '30' });
    const json = err.toJSON();
    expect(json).toHaveProperty('data');
    expect(json.data!['retry_after_seconds']).toBe(30);
    // Still must not include cause or stack
    expect(json).not.toHaveProperty('cause');
    expect(json).not.toHaveProperty('stack');
  });

  it('non-429 error: toJSON() does NOT include data key when no data', () => {
    const err = mapHttpStatusToMcpError(404, null);
    const json = err.toJSON();
    expect(json).not.toHaveProperty('data');
  });
});

describe('isAxiosLikeError', () => {
  it('returns true for an object with isAxiosError=true', () => {
    const axiosErr = {
      isAxiosError: true as const,
      message: 'Request failed',
      response: { status: 500 },
    };
    expect(isAxiosLikeError(axiosErr)).toBe(true);
  });

  it('returns false for a plain Error', () => {
    expect(isAxiosLikeError(new Error('plain'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAxiosLikeError(null)).toBe(false);
  });

  it('returns false for a NexusError', () => {
    const nexusErr = new NexusError('x', McpErrorCode.InternalError);
    expect(isAxiosLikeError(nexusErr)).toBe(false);
  });

  it('returns false for every real @nexusm/sdk error class (the SDK never sets isAxiosError)', () => {
    // This is the fact the original catch blocks got wrong: they gated the
    // whole §M-3 mapping behind this guard (nexusm-mcp-server#32).
    const sdkErrors: unknown[] = [
      new SdkApiError('api', 500),
      new SdkAuthenticationError('auth'),
      new SdkNotFoundError('nf'),
      new SdkRateLimitError('rl', 1),
      new SdkValidationError('v'),
      new SdkUpstreamInterceptError('ui', 302),
      new SdkNetworkError('net'),
      new SdkTimeoutError('to'),
    ];
    for (const err of sdkErrors) {
      expect(isAxiosLikeError(err)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// NexusError.code — the property the JSON-RPC layer actually reads
// ---------------------------------------------------------------------------

describe('NexusError.code (JSON-RPC wire alias of mcpErrorCode)', () => {
  it('equals mcpErrorCode for every code in the enum', () => {
    for (const value of Object.values(McpErrorCode)) {
      if (typeof value !== 'number') continue;
      const err = new NexusError('x', value);
      expect(err.code).toBe(value);
    }
  });

  it('survives the exact expression @modelcontextprotocol/sdk uses to pick the wire code', () => {
    // shared/protocol.js request-failure path:
    //   code: Number.isSafeInteger(error['code']) ? error['code'] : ErrorCode.InternalError
    const pick = (error: Record<string, unknown>): number =>
      Number.isSafeInteger(error['code']) ? (error['code'] as number) : -32603;
    const err = mapHttpStatusToMcpError(401, null);
    expect(pick(err as unknown as Record<string, unknown>)).toBe(McpErrorCode.Unauthorized);
    // And `data` rides along under the same name the SDK reads.
    const rl = mapHttpStatusToMcpError(429, null, { 'retry-after': '7' });
    expect((rl as unknown as Record<string, unknown>)['data']).toEqual({
      retry_after_seconds: 7,
    });
  });

  it('is not part of toJSON() — the explicit serialization contract is unchanged', () => {
    const json = new NexusError('x', McpErrorCode.Unauthorized, 401).toJSON();
    expect(Object.keys(json).sort()).toEqual(
      ['httpStatus', 'mcpErrorCode', 'message', 'name'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// mapSdkErrorToMcpError — the single bridge from @nexusm/sdk errors
// (nexusm-mcp-server#32). Every input below is a REAL SDK class instance.
// ---------------------------------------------------------------------------

/** Mirrors `@nexusm/sdk` http/client.ts `upstreamRedirectError` wording. */
function sdkRedirectMessage(status: number, host: string): string {
  return (
    `Request to /memories/search was redirected (HTTP ${status}) to ${host} ` +
    'instead of being answered by Nexus. This is typically an expired or missing ' +
    'edge credential (e.g. a Cloudflare Access service token) — the API itself was ' +
    'never reached.'
  );
}

/** Mirrors `@nexusm/sdk` http/client.ts `assertNotIntercepted` wording. */
function sdkNonJsonMessage(status: number, contentType: string): string {
  return (
    `Request to /memories/search returned HTTP ${status} with content-type "${contentType}" ` +
    'where JSON was expected. Something between this client and Nexus answered the ' +
    'request (auth edge, proxy, or captive portal); treating it as data would look ' +
    'like an empty result.'
  );
}

describe('mapSdkErrorToMcpError — UpstreamInterceptError', () => {
  it('302 → login page: Unauthorized, retryable=false, data {upstream_intercept, http_status, redirect_host}', () => {
    const sdkErr = new SdkUpstreamInterceptError(
      sdkRedirectMessage(302, 'login.example.com'),
      302,
      '<html>login</html>',
    );
    const err = mapSdkErrorToMcpError(sdkErr);
    expect(err).toBeInstanceOf(NexusError);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.code).toBe(-32011);
    expect(err.httpStatus).toBe(302);
    expect(err.retryable).toBe(false);
    expect(err.data).toEqual({
      upstream_intercept: true,
      http_status: 302,
      redirect_host: 'login.example.com',
    });
    expect(err.cause).toBe(sdkErr);
  });

  it('2xx non-JSON (portal HTML): Unauthorized, data.content_type, no redirect_host', () => {
    const err = mapSdkErrorToMcpError(
      new SdkUpstreamInterceptError(sdkNonJsonMessage(200, 'text/html'), 200, '<html>'),
    );
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.httpStatus).toBe(200);
    expect(err.retryable).toBe(false);
    expect(err.data).toEqual({
      upstream_intercept: true,
      http_status: 200,
      content_type: 'text/html',
    });
  });

  it('message blames the local credential / NEXUS_API_URL, not Nexus, and names the host', () => {
    const err = mapSdkErrorToMcpError(
      new SdkUpstreamInterceptError(sdkRedirectMessage(302, 'edge.example.net'), 302),
    );
    expect(err.message).toMatch(/intercepted before it reached Nexus/);
    expect(err.message).toMatch(/HTTP 302, redirected to edge\.example\.net/);
    expect(err.message).toMatch(/Cloudflare Access service token/);
    expect(err.message).toMatch(/NEXUS_API_URL/);
    expect(err.message).toMatch(/not a Nexus outage/);
  });

  it('is distinguishable from a real 401: same code, but only the intercept carries data.upstream_intercept', () => {
    const intercept = mapSdkErrorToMcpError(
      new SdkUpstreamInterceptError(sdkRedirectMessage(302, 'login.example.com'), 302),
    );
    const real401 = mapSdkErrorToMcpError(new SdkAuthenticationError('Invalid API key'));
    expect(intercept.mcpErrorCode).toBe(real401.mcpErrorCode);
    expect(intercept.data?.['upstream_intercept']).toBe(true);
    expect(real401.data?.['upstream_intercept']).toBeUndefined();
    expect(real401.httpStatus).toBe(401);
  });

  it('SDK placeholder hosts ("an unknown host") are not reported as redirect_host', () => {
    const err = mapSdkErrorToMcpError(
      new SdkUpstreamInterceptError(sdkRedirectMessage(302, 'an unknown host'), 302),
    );
    expect(err.data?.['redirect_host']).toBeUndefined();
    expect(err.data?.['upstream_intercept']).toBe(true);
  });

  it('tolerates message wording drift — classification does not depend on the text', () => {
    const err = mapSdkErrorToMcpError(new SdkUpstreamInterceptError('reworded', 307));
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.data).toEqual({ upstream_intercept: true, http_status: 307 });
  });

  it('never serialises the edge response body, headers or a token', () => {
    const sdkErr = new SdkUpstreamInterceptError(
      sdkRedirectMessage(302, 'login.example.com'),
      302,
      {
        html: '<html>',
        leaked: `Bearer ${SENTINEL_TOKEN}`,
      },
    );
    const serialized = JSON.stringify(mapSdkErrorToMcpError(sdkErr));
    expect(serialized).not.toContain(SENTINEL_TOKEN);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('<html>');
    expect(serialized).not.toContain('cause');
  });
});

describe('mapSdkErrorToMcpError — TimeoutError / NetworkError', () => {
  it('TimeoutError → RequestTimeout (-32001), retryable=true, data.timeout=true, SDK detail kept', () => {
    const sdkErr = new SdkTimeoutError('Request to /memories/search timed out after 30000ms');
    const err = mapSdkErrorToMcpError(sdkErr);
    expect(err.mcpErrorCode).toBe(McpErrorCode.RequestTimeout);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ timeout: true });
    expect(err.message).toMatch(/timed out after 30000ms/);
    expect(err.cause).toBe(sdkErr);
  });

  it('NetworkError → InternalError (-32603), retryable=true, data.network=true, SDK detail kept', () => {
    const sdkErr = new SdkNetworkError('getaddrinfo ENOTFOUND nexus.wrong.invalid');
    const err = mapSdkErrorToMcpError(sdkErr);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ network: true });
    expect(err.message).toMatch(/ENOTFOUND nexus\.wrong\.invalid/);
  });
});

describe('mapSdkErrorToMcpError — ApiError family goes through the §M-3 table', () => {
  it('AuthenticationError (401) → Unauthorized, retryable=false, cause attached', () => {
    const sdkErr = new SdkAuthenticationError('Invalid API key', { detail: 'Invalid API key' });
    const err = mapSdkErrorToMcpError(sdkErr);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(sdkErr);
  });

  it('ApiError with statusCode 403 → Unauthorized (the SDK has no dedicated 403 class)', () => {
    const err = mapSdkErrorToMcpError(new SdkApiError('Tenant access denied', 403));
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.httpStatus).toBe(403);
  });

  it('NotFoundError (404) → MethodNotFound', () => {
    const err = mapSdkErrorToMcpError(new SdkNotFoundError('Resource not found'));
    expect(err.mcpErrorCode).toBe(McpErrorCode.MethodNotFound);
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it('ApiError with statusCode 422 → InvalidParams', () => {
    const err = mapSdkErrorToMcpError(new SdkApiError('Unprocessable', 422, { detail: [] }));
    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.httpStatus).toBe(422);
  });

  it('RateLimitError with retryAfter → RateLimited, retryable=true, data.retry_after_seconds', () => {
    const err = mapSdkErrorToMcpError(new SdkRateLimitError('Slow down', 60, { detail: 'x' }));
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.code).toBe(-32012);
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ retry_after_seconds: 60 });
  });

  it('RateLimitError without retryAfter → RateLimited, no retry_after_seconds', () => {
    const err = mapSdkErrorToMcpError(new SdkRateLimitError('Slow down', undefined));
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.data?.['retry_after_seconds']).toBeUndefined();
  });

  it('RateLimitError with NaN retryAfter (SDK got an HTTP-date header) → no retry_after_seconds', () => {
    // The SDK does `Number(headers['retry-after'])`, which is NaN for the
    // HTTP-date form; nothing sensible survives, so the field is omitted.
    const err = mapSdkErrorToMcpError(new SdkRateLimitError('Slow down', Number.NaN));
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.data?.['retry_after_seconds']).toBeUndefined();
  });

  it('ApiError 503 → ConnectionClosed, retryable=true', () => {
    const err = mapSdkErrorToMcpError(new SdkApiError('unavailable', 503));
    expect(err.mcpErrorCode).toBe(McpErrorCode.ConnectionClosed);
    expect(err.retryable).toBe(true);
  });

  it('ApiError 500 / 502 → InternalError, retryable=true', () => {
    for (const status of [500, 502]) {
      const err = mapSdkErrorToMcpError(new SdkApiError('boom', status));
      expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
      expect(err.httpStatus).toBe(status);
      expect(err.retryable).toBe(true);
    }
  });

  it('ValidationError (SDK maps HTTP 400 there) → InternalError non-retryable via the table catch-all', () => {
    // 400 is not a row in the locked §M-3 table (only 422 is); the bridge
    // does not extend the table — documenting the current behaviour.
    const err = mapSdkErrorToMcpError(new SdkValidationError('bad request'));
    expect(err.httpStatus).toBe(400);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.retryable).toBe(false);
  });
});

describe('mapSdkErrorToMcpError — client-side InputValidationError', () => {
  it('→ InvalidParams, httpStatus=null (the request was never sent)', () => {
    const zodLike = {
      errors: [{ path: ['user_id'], message: 'Required' }],
      issues: [{ path: ['user_id'], message: 'Required' }],
      flatten: () => ({ fieldErrors: { user_id: ['Required'] }, formErrors: [] }),
    };
    const sdkErr = new SdkInputValidationError(
      zodLike as unknown as ConstructorParameters<typeof SdkInputValidationError>[0],
    );
    const err = mapSdkErrorToMcpError(sdkErr);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/user_id: Required/);
  });
});

describe('mapSdkErrorToMcpError — fallbacks and passthrough', () => {
  it('returns a NexusError unchanged (same instance)', () => {
    const own = new NexusError('mine', McpErrorCode.InvalidParams, 422);
    expect(mapSdkErrorToMcpError(own)).toBe(own);
  });

  it('structural fallback: an object carrying the SDK code but not the class identity is still classified', () => {
    // Simulates a second copy of @nexusm/sdk (hoisting / bundling) whose
    // classes fail `instanceof` against ours — the SDK's documented `code`
    // contract is the second criterion.
    const foreignIntercept = {
      name: 'UpstreamInterceptError',
      code: 'NEXUS_UPSTREAM_INTERCEPT',
      message: sdkRedirectMessage(302, 'login.example.com'),
      statusCode: 302,
    };
    const err = mapSdkErrorToMcpError(foreignIntercept);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.data).toMatchObject({
      upstream_intercept: true,
      redirect_host: 'login.example.com',
    });

    const foreignRateLimit = {
      name: 'RateLimitError',
      code: 'NEXUS_RATE_LIMIT_ERROR',
      message: 'slow',
      statusCode: 429,
      retryAfter: 5,
    };
    const rl = mapSdkErrorToMcpError(foreignRateLimit);
    expect(rl.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(rl.data).toEqual({ retry_after_seconds: 5 });

    const foreignTimeout = { name: 'TimeoutError', code: 'NEXUS_TIMEOUT_ERROR', message: 'late' };
    expect(mapSdkErrorToMcpError(foreignTimeout).mcpErrorCode).toBe(McpErrorCode.RequestTimeout);
  });

  it('raw axios-like error (isAxiosError) still maps through the §M-3 table', () => {
    const axiosLike = {
      isAxiosError: true as const,
      message: 'Request failed with status code 429',
      response: { status: 429, data: {}, headers: { 'retry-after': '3' } },
    };
    const err = mapSdkErrorToMcpError(axiosLike);
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.data).toEqual({ retry_after_seconds: 3 });
  });

  it('raw axios-like error without response → network InternalError', () => {
    const err = mapSdkErrorToMcpError({
      isAxiosError: true as const,
      message: 'x',
      code: 'ERR_CANCELED',
    });
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.data).toEqual({ network: true });
  });

  it('plain Error → InternalError, retryable=false, tool name prefixed, NOT flagged as network', () => {
    const err = mapSdkErrorToMcpError(new Error('kaboom'), 'nexus.memory_search');
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBeNull();
    expect(err.data).toBeUndefined();
    expect(err.message).toBe('nexus.memory_search failed: kaboom');
  });

  it('non-Error throwable (string) → InternalError with the value in the message', () => {
    const err = mapSdkErrorToMcpError('just a string');
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.message).toBe('Nexus call failed: just a string');
  });
});
