/**
 * Error contract for the Nexusm MCP server (US-037 TASK-007, Wave 1).
 *
 * CONTRACT-FIRST: this file declares the error type surface only. The
 * concrete HTTP-status -> MCP-error-code mapping logic lives in TASK-013
 * (Wave 2). Do not implement mapping rules here — see proposal §M-3 for
 * the mapping table that TASK-013 must encode.
 *
 * Consumers locked at Wave 1:
 *   - `auth.ts` (TASK-004) consumers can throw / catch `AuthError`
 *   - `tools/*` (TASK-003) handlers can throw `NexusError` subtypes
 *     with a stable surface
 *
 * SECURITY (matches auth.ts discipline):
 *   `toJSON()` deliberately omits `cause`. An axios-style error attached
 *   as `cause` typically carries the original request config including
 *   the `Authorization: Bearer <token>` header. Leaking that via a
 *   JSON.stringify of a NexusError would defeat the token-redaction
 *   guarantee of auth.ts. If callers need to inspect the cause they
 *   must do so explicitly, not via serialization.
 */

import type { AuthConfig } from "./auth.js";

/**
 * MCP / JSON-RPC error codes surfaced by this server.
 *
 * Values mirror `@modelcontextprotocol/sdk` `ErrorCode` enum
 * (`dist/esm/types.d.ts`). We re-declare locally rather than re-export
 * the SDK enum so that:
 *   1. errors.ts has zero runtime import from the SDK (keeps the
 *      contract layer independent of SDK version churn)
 *   2. TASK-013's mapping logic and tests have a single source of truth
 *      for which codes this server is allowed to emit
 *
 * Scope decision (resolved ambiguity from spec):
 *   We enumerate the four JSON-RPC standard codes required by §M-3
 *   (`InvalidRequest`, `MethodNotFound`, `InvalidParams`, `InternalError`),
 *   plus `ParseError` (-32700) for completeness of the JSON-RPC base
 *   set, plus `ConnectionClosed` (-32000) and `RequestTimeout` (-32001)
 *   which the SDK defines and which `NetworkError` / `CancelError`
 *   downstream mappings will need. UrlElicitationRequired (-32042) is
 *   intentionally omitted — not in scope for Wave 1 / Wave 2.
 */
export enum McpErrorCode {
  // JSON-RPC standard (https://www.jsonrpc.org/specification#error_object)
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  // MCP SDK extensions used by this server's error taxonomy
  ConnectionClosed = -32000,
  RequestTimeout = -32001,
}

/**
 * Base error for all errors this MCP server emits.
 *
 * Carries enough structured context for TASK-013 to translate a thrown
 * `NexusError` into a JSON-RPC error response without re-inspecting the
 * underlying axios / SDK error.
 */
export class NexusError extends Error {
  /**
   * Upstream HTTP status (Nexus REST), or `null` when the error did not
   * originate from an HTTP response (e.g. DNS failure, abort, internal
   * invariant violation).
   */
  public readonly httpStatus: number | null;

  /** MCP/JSON-RPC error code that this error will surface as. */
  public readonly mcpErrorCode: McpErrorCode;

  /**
   * Underlying cause. Per ES2022 `Error.cause`. **Not serialized** by
   * `toJSON()` — see file header SECURITY note.
   */
  public override readonly cause?: unknown;

  constructor(
    message: string,
    mcpErrorCode: McpErrorCode,
    httpStatus: number | null = null,
    cause?: unknown,
  ) {
    super(message);
    this.name = "NexusError";
    this.mcpErrorCode = mcpErrorCode;
    this.httpStatus = httpStatus;
    if (cause !== undefined) {
      this.cause = cause;
    }
    // Restore prototype chain — required when extending Error under
    // some TS target/module combinations (defensive; cheap).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Safe serialization. Deliberately omits `cause` and `stack` to
   * prevent accidental token leakage if a caller logs the JSON form.
   */
  public toJSON(): {
    name: string;
    message: string;
    httpStatus: number | null;
    mcpErrorCode: McpErrorCode;
  } {
    return {
      name: this.name,
      message: this.message,
      httpStatus: this.httpStatus,
      mcpErrorCode: this.mcpErrorCode,
    };
  }
}

/**
 * Pure-function mapping from upstream HTTP response to MCP error code.
 *
 * Implementation deferred — see proposal §M-3 for the full mapping
 * table (401/403 -> InvalidRequest treated as UNAUTHORIZED semantics,
 * 404 -> InvalidParams, 422 -> InvalidParams, 429 -> InternalError +
 * Retry-After data, 5xx -> InternalError, etc.).
 *
 * `body` is typed `unknown` because the upstream response shape is not
 * known at this contract layer; TASK-013 will narrow it.
 */
// TASK-013: implement
export type ErrorMapping = (
  httpStatus: number,
  body: unknown,
) => McpErrorCode;

/**
 * Auth-origin error (401 / 403 from Nexus REST, or local auth-config
 * issues surfaced after `loadAuthConfig`).
 *
 * `authConfigKey` is optional because not every auth failure points at
 * a specific config field (e.g. a token that was valid at load but
 * since revoked has no `AuthConfig` key to blame).
 */
export interface AuthError extends NexusError {
  readonly authConfigKey?: keyof AuthConfig;
}

/**
 * Network-origin error (DNS failure, connection refused, TLS error,
 * read timeout). Per proposal §M-3, these map to `InternalError` with
 * `error.data.network = true`, and the MCP client may retry.
 *
 * `retryable` is a hint to the client; the server itself does not
 * retry (avoids double-counting under quota / Retry-After).
 */
export interface NetworkError extends NexusError {
  readonly retryable: boolean;
}

/**
 * Cancellation error — fired when an in-flight tool call is aborted.
 *
 *   - `client_cancel`: MCP cancel notification from the client
 *   - `timeout`: server-side deadline elapsed
 *   - `signal`: AbortSignal propagated from a higher layer
 *
 * Per proposal §M-3, the server does **not** return a result when a
 * cancel arrives; this error type exists so handlers can distinguish
 * cancel from other failures in logs / metrics.
 */
export interface CancelError extends NexusError {
  readonly reason: "client_cancel" | "timeout" | "signal";
}
