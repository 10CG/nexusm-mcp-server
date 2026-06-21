/**
 * Auth / env config loader for Nexusm MCP server (US-037b).
 *
 * Loads required env vars on startup and fails fast if any is missing.
 *
 * Per R2 C-1 (proposal §283): `NEXUS_USER_ID` is intentionally NOT loaded
 * here — `user_id` is supplied per-call via MCP tool input args.
 *
 * Optional: `NEXUS_DEFAULT_USER_ID` pins a server-side user_id that overrides
 * every per-call `args.user_id`. Intended for single-user deployments where the
 * LLM must not choose a user_id. Missing/empty means the per-call value is used.
 *
 * SECURITY:
 *   - The Bearer token (NEXUS_API_TOKEN) MUST NEVER appear in stdout
 *     (would pollute MCP stdio transport, breaking the client),
 *     nor in stderr error messages, nor in any log line.
 *   - All diagnostic output uses env var *names* only, never values.
 */

import { McpErrorCode, NexusError } from './errors.js';

/**
 * Normalize a raw `NEXUS_API_URL` value so it always includes the `/v1`
 * API-version segment required by `@nexusm/sdk`.
 *
 * Rules (applied in order):
 *  1. Trim leading/trailing whitespace.
 *  2. Strip any trailing slashes.
 *  3. If the resulting path does not already end with `/v1`, append `/v1`.
 *
 * The function is idempotent: `normalizeApiUrl(normalizeApiUrl(x)) ===
 * normalizeApiUrl(x)` for all inputs.
 *
 * Examples:
 *   `http://localhost:8787`     → `http://localhost:8787/v1`
 *   `http://localhost:8787/`    → `http://localhost:8787/v1`
 *   `http://localhost:8787/v1`  → `http://localhost:8787/v1`  (unchanged)
 *   `http://localhost:8787/v1/` → `http://localhost:8787/v1`
 *   `https://nexus.example/v1`  → `https://nexus.example/v1` (unchanged)
 *   `https://h/api/v1`          → `https://h/api/v1`          (unchanged)
 */
export function normalizeApiUrl(raw: string): string {
  const stripped = raw.trim().replace(/\/+$/, '');
  return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
}

/** Required env var keys. Order is preserved when reporting missing vars. */
const REQUIRED_ENV_VARS = ['NEXUS_API_URL', 'NEXUS_API_TOKEN', 'NEXUS_TENANT_ID'] as const;

type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/**
 * Loaded, validated auth configuration.
 *
 * Exported as a named interface so downstream modules (notably
 * `errors.ts` per TASK-007 / TASK-013) can import the contract
 * without re-declaring it.
 */
export interface AuthConfig {
  /**
   * Base URL of the Nexus HTTP API, normalized to include the `/v1` suffix.
   * Trailing slashes are stripped and `/v1` is appended when absent, so
   * pointing `NEXUS_API_URL` at a bare origin or local proxy works correctly.
   */
  readonly apiUrl: string;
  /** Bearer token for Nexus API. NEVER log this value. */
  readonly apiToken: string;
  /** Tenant identifier for multi-tenant routing. */
  readonly tenantId: string;
  /**
   * Optional server-side user_id pin loaded from `NEXUS_DEFAULT_USER_ID`.
   *
   * When set (non-empty after trim), `resolveUserId` returns this value for
   * every tool call, ignoring whatever `user_id` the LLM passed. Intended for
   * single-user deployments where the LLM must not choose a user_id.
   *
   * When `undefined` (env var absent or empty), per-call validation applies.
   */
  readonly defaultUserId?: string;
}

/**
 * Stream sink for diagnostics. Injectable for testing only; defaults to
 * `process.stderr` so that no diagnostic ever lands on stdout (which is
 * reserved for the MCP stdio transport).
 */
export interface AuthIO {
  stderr: NodeJS.WritableStream;
  exit: (code: number) => never;
}

const defaultIO: AuthIO = {
  stderr: process.stderr,
  // Cast: process.exit is typed as `(code?) => never` but TS sometimes widens.
  exit: ((code: number) => process.exit(code)) as (code: number) => never,
};

/**
 * Load and validate auth config from `process.env`.
 *
 * On any missing required var, writes a clear, token-free error message to
 * `stderr` and calls `process.exit(1)`. Empty string and whitespace-only
 * values are treated as missing (env var inheritance from parent shells
 * frequently produces empty values, which would otherwise produce a
 * confusing "401 Unauthorized" downstream).
 *
 * `NEXUS_DEFAULT_USER_ID` is optional: when present and non-empty, its trimmed
 * value is placed in `AuthConfig.defaultUserId` and one diagnostic line is
 * written to stderr so the operator can confirm single-user mode is active.
 */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  io: AuthIO = defaultIO,
): AuthConfig {
  const missing: RequiredEnvVar[] = [];
  const values: Partial<Record<RequiredEnvVar, string>> = {};

  for (const key of REQUIRED_ENV_VARS) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') {
      missing.push(key);
    } else {
      values[key] = raw.trim();
    }
  }

  if (missing.length > 0) {
    // Build message from var *names* only — never values. This guarantees
    // a leaked token cannot reach stderr via this path even if a future
    // refactor accidentally passes `env` into the message.
    const list = missing.join(', ');
    const noun = missing.length === 1 ? 'variable is' : 'variables are';
    const msg =
      `[nexusm-mcp-server] Required environment ${noun} missing: ${list}. ` +
      `Set them before starting the server. See RUNBOOK.md.\n`;
    io.stderr.write(msg);
    io.exit(1);
    // `exit` is typed `never`; unreachable, but satisfies control-flow analysis.
    throw new Error('unreachable');
  }

  const rawApiUrl = values.NEXUS_API_URL as string;
  const normalizedApiUrl = normalizeApiUrl(rawApiUrl);
  if (normalizedApiUrl !== rawApiUrl) {
    io.stderr.write(
      '[nexusm-mcp-server] NEXUS_API_URL had no /v1 suffix; appended it (backend routes are /v1/*).\n',
    );
  }

  // Optional NEXUS_DEFAULT_USER_ID — single-user pin.
  const rawDefaultUserId = env['NEXUS_DEFAULT_USER_ID'];
  const defaultUserId =
    rawDefaultUserId !== undefined && rawDefaultUserId.trim() !== ''
      ? rawDefaultUserId.trim()
      : undefined;

  if (defaultUserId !== undefined) {
    io.stderr.write(
      `[nexusm-mcp-server] NEXUS_DEFAULT_USER_ID set — pinning user_id to "${defaultUserId}" for all calls (single-user mode; per-call user_id ignored).\n`,
    );
  }

  return {
    apiUrl: normalizedApiUrl,
    apiToken: values.NEXUS_API_TOKEN as string,
    tenantId: values.NEXUS_TENANT_ID as string,
    ...(defaultUserId !== undefined ? { defaultUserId } : {}),
  };
}

/**
 * Resolve the effective `user_id` for a tool call.
 *
 * - If `auth.defaultUserId` is set (single-user pin), return it unconditionally,
 *   ignoring whatever the LLM passed in `rawArgsUserId`.
 * - Otherwise, validate that `rawArgsUserId` is a non-empty string (after trim)
 *   and return the trimmed value. Throws `NexusError(InvalidParams)` on failure,
 *   matching the error shape used by the other per-field validators in the tools.
 *
 * @param auth     - Loaded auth config (from `loadAuthConfig`).
 * @param rawArgsUserId - The raw `args.user_id` value from the MCP tool call.
 */
export function resolveUserId(auth: AuthConfig, rawArgsUserId: unknown): string {
  if (auth.defaultUserId !== undefined) {
    return auth.defaultUserId;
  }
  if (typeof rawArgsUserId !== 'string' || rawArgsUserId.trim() === '') {
    throw new NexusError('user_id is required (non-empty string)', McpErrorCode.InvalidParams, 422);
  }
  return rawArgsUserId.trim();
}
