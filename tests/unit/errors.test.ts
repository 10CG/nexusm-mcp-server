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
import { NexusError, McpErrorCode } from '../../src/errors.js';

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
