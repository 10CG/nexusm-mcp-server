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
import { NexusError, McpErrorCode, mapHttpStatusToMcpError, isAxiosLikeError } from '../../src/errors.js';

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
});
