/**
 * Auth / env config loader for Nexusm MCP server (US-037b).
 *
 * Loads required env vars on startup and fails fast if any is missing.
 *
 * Per R2 C-1 (proposal §283): `NEXUS_USER_ID` is intentionally NOT loaded
 * here — `user_id` is supplied per-call via MCP tool input args.
 *
 * SECURITY:
 *   - The Bearer token (NEXUS_API_TOKEN) MUST NEVER appear in stdout
 *     (would pollute MCP stdio transport, breaking the client),
 *     nor in stderr error messages, nor in any log line.
 *   - All diagnostic output uses env var *names* only, never values.
 */

/** Required env var keys. Order is preserved when reporting missing vars. */
const REQUIRED_ENV_VARS = [
  "NEXUS_API_URL",
  "NEXUS_API_TOKEN",
  "NEXUS_TENANT_ID",
] as const;

type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/**
 * Loaded, validated auth configuration.
 *
 * Exported as a named interface so downstream modules (notably
 * `errors.ts` per TASK-007 / TASK-013) can import the contract
 * without re-declaring it.
 */
export interface AuthConfig {
  /** Base URL of the Nexus HTTP API (no trailing slash enforced). */
  readonly apiUrl: string;
  /** Bearer token for Nexus API. NEVER log this value. */
  readonly apiToken: string;
  /** Tenant identifier for multi-tenant routing. */
  readonly tenantId: string;
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
 */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  io: AuthIO = defaultIO,
): AuthConfig {
  const missing: RequiredEnvVar[] = [];
  const values: Partial<Record<RequiredEnvVar, string>> = {};

  for (const key of REQUIRED_ENV_VARS) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") {
      missing.push(key);
    } else {
      values[key] = raw.trim();
    }
  }

  if (missing.length > 0) {
    // Build message from var *names* only — never values. This guarantees
    // a leaked token cannot reach stderr via this path even if a future
    // refactor accidentally passes `env` into the message.
    const list = missing.join(", ");
    const noun = missing.length === 1 ? "variable is" : "variables are";
    const msg =
      `[nexusm-mcp-server] Required environment ${noun} missing: ${list}. ` +
      `Set them before starting the server. See RUNBOOK.md.\n`;
    io.stderr.write(msg);
    io.exit(1);
    // `exit` is typed `never`; unreachable, but satisfies control-flow analysis.
    throw new Error("unreachable");
  }

  return {
    apiUrl: values.NEXUS_API_URL as string,
    apiToken: values.NEXUS_API_TOKEN as string,
    tenantId: values.NEXUS_TENANT_ID as string,
  };
}
