/**
 * Tests for src/auth.ts (US-037b TASK-004).
 *
 * Coverage:
 *   1. Happy path — all 3 env vars present
 *   2. Missing NEXUS_API_TOKEN — exit(1) + stderr message without any token-like value
 *   3. Missing 2 vars — exit(1) and stderr mentions at least one missing var name
 *   4. Token redaction — token value never leaks to stderr / stdout / thrown error
 *   5. AuthConfig export shape — exported config has the 3 expected fields with string types
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthConfig, AuthIO } from '../../src/auth.js';
import { loadAuthConfig } from '../../src/auth.js';

/** Sentinel token used to detect any redaction failure. */
const SENTINEL_TOKEN = 'sk-test-SECRET-12345';

/** Build an isolated env with the requested overrides (no inheritance). */
function makeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Build a fake AuthIO that captures stderr writes and throws on exit
 * (so we can assert without actually terminating the test runner).
 */
function makeIO(): {
  io: AuthIO;
  stderrBuf: string[];
  exitCalls: number[];
} {
  const stderrBuf: string[] = [];
  const exitCalls: number[] = [];
  const io: AuthIO = {
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderrBuf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    exit: ((code: number) => {
      exitCalls.push(code);
      throw new Error(`__EXIT_${code}__`);
    }) as (code: number) => never,
  };
  return { io, stderrBuf, exitCalls };
}

// Spy on real stdout to catch any accidental writes from the module under test.
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let realStdoutChunks: string[];

beforeEach(() => {
  realStdoutChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    realStdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

describe('loadAuthConfig — happy path', () => {
  it('returns a fully populated AuthConfig when all 3 env vars are present', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'https://api.nexus.example.com',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf, exitCalls } = makeIO();

    const cfg = loadAuthConfig(env, io);

    expect(cfg.apiUrl).toBe('https://api.nexus.example.com');
    expect(cfg.apiToken).toBe(SENTINEL_TOKEN);
    expect(cfg.tenantId).toBe('tenant-abc');
    expect(exitCalls).toEqual([]);
    expect(stderrBuf.join('')).toBe('');
    expect(realStdoutChunks.join('')).toBe('');
  });

  it('trims whitespace around env var values', () => {
    const env = makeEnv({
      NEXUS_API_URL: '  https://api.nexus.example.com  ',
      NEXUS_API_TOKEN: `  ${SENTINEL_TOKEN}  `,
      NEXUS_TENANT_ID: '\ttenant-abc\n',
    });
    const { io } = makeIO();

    const cfg = loadAuthConfig(env, io);

    expect(cfg.apiUrl).toBe('https://api.nexus.example.com');
    expect(cfg.apiToken).toBe(SENTINEL_TOKEN);
    expect(cfg.tenantId).toBe('tenant-abc');
  });
});

describe('loadAuthConfig — fail-fast on missing required env vars', () => {
  it('exits(1) and emits a stderr message without the token when NEXUS_API_TOKEN is missing', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'https://api.nexus.example.com',
      NEXUS_TENANT_ID: 'tenant-abc',
      // NEXUS_API_TOKEN intentionally absent
    });
    const { io, stderrBuf, exitCalls } = makeIO();

    expect(() => loadAuthConfig(env, io)).toThrow(/__EXIT_1__/);

    expect(exitCalls).toEqual([1]);
    const stderr = stderrBuf.join('');
    expect(stderr).toContain('NEXUS_API_TOKEN');
    // No token-shaped value should appear (no token was provided, so this
    // is a structural check: nothing matching common token shapes leaks).
    expect(stderr).not.toMatch(/sk-[A-Za-z0-9_-]{4,}/);
    expect(stderr).not.toMatch(/Bearer\s+/i);
    expect(realStdoutChunks.join('')).toBe('');
  });

  it('exits(1) and mentions at least one missing var when 2 are missing', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'https://api.nexus.example.com',
      // NEXUS_API_TOKEN and NEXUS_TENANT_ID both missing
    });
    const { io, stderrBuf, exitCalls } = makeIO();

    expect(() => loadAuthConfig(env, io)).toThrow(/__EXIT_1__/);

    expect(exitCalls).toEqual([1]);
    const stderr = stderrBuf.join('');
    // Mentions both missing names (we report them all, not just the first).
    expect(stderr).toContain('NEXUS_API_TOKEN');
    expect(stderr).toContain('NEXUS_TENANT_ID');
    expect(stderr).not.toContain('NEXUS_API_URL'); // present — must not be flagged
  });

  it('treats empty-string env values as missing', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'https://api.nexus.example.com',
      NEXUS_API_TOKEN: '',
      NEXUS_TENANT_ID: '   ',
    });
    const { io, stderrBuf, exitCalls } = makeIO();

    expect(() => loadAuthConfig(env, io)).toThrow(/__EXIT_1__/);
    expect(exitCalls).toEqual([1]);
    const stderr = stderrBuf.join('');
    expect(stderr).toContain('NEXUS_API_TOKEN');
    expect(stderr).toContain('NEXUS_TENANT_ID');
  });
});

describe('loadAuthConfig — token redaction (security-critical)', () => {
  it('never includes the token value in stderr, stdout, or thrown errors when other vars are missing', () => {
    // Token IS set, but other required vars are missing. This is the
    // dangerous shape: a careless implementation might dump `env` into
    // the error message and leak the token.
    const env = makeEnv({
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      // NEXUS_API_URL and NEXUS_TENANT_ID missing
    });
    const { io, stderrBuf } = makeIO();

    let caught: unknown;
    try {
      loadAuthConfig(env, io);
    } catch (e) {
      caught = e;
    }

    const stderr = stderrBuf.join('');
    const stdout = realStdoutChunks.join('');
    const thrownStr =
      caught instanceof Error ? `${caught.message}\n${caught.stack ?? ''}` : String(caught);

    expect(stderr).not.toContain(SENTINEL_TOKEN);
    expect(stdout).not.toContain(SENTINEL_TOKEN);
    expect(thrownStr).not.toContain(SENTINEL_TOKEN);
    // Stdout must be completely silent — MCP stdio transport invariant.
    expect(stdout).toBe('');
  });

  it('happy-path execution emits nothing to stdout (MCP stdio invariant)', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'https://api.nexus.example.com',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf } = makeIO();

    loadAuthConfig(env, io);

    expect(realStdoutChunks.join('')).toBe('');
    // stderr also silent on happy path (avoid noise in MCP client logs).
    expect(stderrBuf.join('')).toBe('');
  });
});

describe('AuthConfig — exported interface shape', () => {
  it('exposes apiUrl, apiToken, tenantId as string fields', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'https://api.nexus.example.com',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io } = makeIO();
    const cfg: AuthConfig = loadAuthConfig(env, io);

    // Runtime shape check.
    const keys = Object.keys(cfg).sort();
    expect(keys).toEqual(['apiToken', 'apiUrl', 'tenantId']);
    expect(typeof cfg.apiUrl).toBe('string');
    expect(typeof cfg.apiToken).toBe('string');
    expect(typeof cfg.tenantId).toBe('string');

    // Compile-time check: AuthConfig must be assignable from a literal
    // with exactly these three string fields. If the interface drifts,
    // tsc will fail this file.
    const literal: AuthConfig = {
      apiUrl: 'x',
      apiToken: 'y',
      tenantId: 'z',
    };
    expect(literal.apiUrl).toBe('x');
  });
});
