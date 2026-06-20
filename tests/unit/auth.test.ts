/**
 * Tests for src/auth.ts (US-037b TASK-004; FU-MCP-API-URL-V1-SUFFIX).
 *
 * Coverage:
 *   1. Happy path — all 3 env vars present
 *   2. Missing NEXUS_API_TOKEN — exit(1) + stderr message without any token-like value
 *   3. Missing 2 vars — exit(1) and stderr mentions at least one missing var name
 *   4. Token redaction — token value never leaks to stderr / stdout / thrown error
 *   5. AuthConfig export shape — exported config has the 3 expected fields with string types
 *   6. normalizeApiUrl — 7 canonical edge cases + idempotency
 *   7. loadAuthConfig normalizes apiUrl and emits one diagnostic line when /v1 is absent
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { AuthConfig, AuthIO } from '../../src/auth.js';
import { loadAuthConfig, normalizeApiUrl } from '../../src/auth.js';

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
let stdoutSpy: MockInstance;
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
      // Already includes /v1 — no diagnostic expected.
      NEXUS_API_URL: 'https://api.nexus.example.com/v1',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf, exitCalls } = makeIO();

    const cfg = loadAuthConfig(env, io);

    expect(cfg.apiUrl).toBe('https://api.nexus.example.com/v1');
    expect(cfg.apiToken).toBe(SENTINEL_TOKEN);
    expect(cfg.tenantId).toBe('tenant-abc');
    expect(exitCalls).toEqual([]);
    expect(stderrBuf.join('')).toBe('');
    expect(realStdoutChunks.join('')).toBe('');
  });

  it('trims whitespace around env var values', () => {
    const env = makeEnv({
      NEXUS_API_URL: '  https://api.nexus.example.com/v1  ',
      NEXUS_API_TOKEN: `  ${SENTINEL_TOKEN}  `,
      NEXUS_TENANT_ID: '\ttenant-abc\n',
    });
    const { io } = makeIO();

    const cfg = loadAuthConfig(env, io);

    expect(cfg.apiUrl).toBe('https://api.nexus.example.com/v1');
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
      // Use a URL that already includes /v1 so no diagnostic is emitted —
      // this test is only checking the stdout invariant.
      NEXUS_API_URL: 'https://api.nexus.example.com/v1',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf } = makeIO();

    loadAuthConfig(env, io);

    expect(realStdoutChunks.join('')).toBe('');
    // stderr also silent when URL is already normalized.
    expect(stderrBuf.join('')).toBe('');
  });
});

describe('AuthConfig — exported interface shape', () => {
  it('exposes apiUrl, apiToken, tenantId as string fields', () => {
    const env = makeEnv({
      // Use a URL that already includes /v1 so no diagnostic is emitted,
      // keeping this test focused purely on the shape contract.
      NEXUS_API_URL: 'https://api.nexus.example.com/v1',
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

// ---------------------------------------------------------------------------
// normalizeApiUrl — pure helper (FU-MCP-API-URL-V1-SUFFIX)
// ---------------------------------------------------------------------------

describe('normalizeApiUrl — canonical edge cases', () => {
  it('appends /v1 to a bare origin', () => {
    expect(normalizeApiUrl('http://localhost:8787')).toBe('http://localhost:8787/v1');
  });

  it('appends /v1 to a bare origin with trailing slash', () => {
    expect(normalizeApiUrl('http://localhost:8787/')).toBe('http://localhost:8787/v1');
  });

  it('leaves a URL that already ends with /v1 unchanged', () => {
    expect(normalizeApiUrl('http://localhost:8787/v1')).toBe('http://localhost:8787/v1');
  });

  it('strips trailing slash from a /v1/ URL', () => {
    expect(normalizeApiUrl('http://localhost:8787/v1/')).toBe('http://localhost:8787/v1');
  });

  it('leaves https://nexus-dev.10cg.pub/v1 unchanged', () => {
    expect(normalizeApiUrl('https://nexus-dev.10cg.pub/v1')).toBe('https://nexus-dev.10cg.pub/v1');
  });

  it('appends /v1 to a bare host:port with no path', () => {
    expect(normalizeApiUrl('http://h:8001')).toBe('http://h:8001/v1');
  });

  it('leaves a URL with a deeper /api/v1 path unchanged', () => {
    expect(normalizeApiUrl('https://h/api/v1')).toBe('https://h/api/v1');
  });

  it('does NOT treat a non-/v1 segment ending in v1 as a version suffix (negative-adjacency, guards against endsWith("v1") regression)', () => {
    expect(normalizeApiUrl('http://h/myv1')).toBe('http://h/myv1/v1');
  });
});

describe('normalizeApiUrl — idempotency', () => {
  const representativeInputs = [
    'http://localhost:8787',
    'http://localhost:8787/',
    'http://localhost:8787/v1',
    'http://localhost:8787/v1/',
    'https://nexus-dev.10cg.pub/v1',
    'http://h:8001',
    'https://h/api/v1',
  ];

  for (const input of representativeInputs) {
    it(`is idempotent for: ${input}`, () => {
      const once = normalizeApiUrl(input);
      const twice = normalizeApiUrl(once);
      expect(twice).toBe(once);
    });
  }
});

// ---------------------------------------------------------------------------
// loadAuthConfig — normalization wiring (FU-MCP-API-URL-V1-SUFFIX)
// ---------------------------------------------------------------------------

describe('loadAuthConfig — NEXUS_API_URL normalization', () => {
  it('normalizes a bare-origin input and returns apiUrl with /v1', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'http://localhost:8787',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io } = makeIO();

    const cfg = loadAuthConfig(env, io);

    expect(cfg.apiUrl).toBe('http://localhost:8787/v1');
  });

  it('emits exactly one diagnostic line to stderr when /v1 is absent', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'http://localhost:8787',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf } = makeIO();

    loadAuthConfig(env, io);

    const stderr = stderrBuf.join('');
    expect(stderr).toContain('/v1');
    // Must be exactly one diagnostic line (not zero, not two).
    const lines = stderrBuf.filter((chunk) => chunk.includes('/v1'));
    expect(lines).toHaveLength(1);
    // Token must not appear in the diagnostic.
    expect(stderr).not.toContain(SENTINEL_TOKEN);
    // Must not touch stdout (MCP stdio invariant).
    expect(realStdoutChunks.join('')).toBe('');
  });

  it('emits no diagnostic when NEXUS_API_URL already ends with /v1', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'http://localhost:8787/v1',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf } = makeIO();

    loadAuthConfig(env, io);

    expect(stderrBuf.join('')).toBe('');
  });

  it('normalizes a trailing-slash /v1/ input — strips slash, emits diagnostic', () => {
    const env = makeEnv({
      NEXUS_API_URL: 'http://localhost:8787/v1/',
      NEXUS_API_TOKEN: SENTINEL_TOKEN,
      NEXUS_TENANT_ID: 'tenant-abc',
    });
    const { io, stderrBuf } = makeIO();

    const cfg = loadAuthConfig(env, io);

    expect(cfg.apiUrl).toBe('http://localhost:8787/v1');
    // The trailing slash makes the raw value differ from the normalized result,
    // so the diagnostic fires once (it is a normalization, not a pure no-op).
    expect(stderrBuf.join('')).toContain('/v1');
  });
});
