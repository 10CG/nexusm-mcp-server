/**
 * Error contract and HTTP→MCP mapping for the Nexusm MCP server.
 *
 * Wave 1 (TASK-007): declared the type surface — NexusError, McpErrorCode,
 *   interface stubs for AuthError / NetworkError / CancelError.
 * Wave 2B (TASK-013): implements the full HTTP-status → MCP-error-code
 *   mapping (proposal §M-3) via `mapHttpStatusToMcpError` and
 *   `isAxiosLikeError`.
 *
 * SECURITY (matches auth.ts discipline):
 *   `toJSON()` deliberately omits `cause` and `stack`. An axios-style error
 *   attached as `cause` typically carries the original request config
 *   including the `Authorization: Bearer <token>` header. Leaking that via a
 *   JSON.stringify of a NexusError would defeat the token-redaction guarantee
 *   of auth.ts. If callers need to inspect the cause they must do so
 *   explicitly, not via serialization.
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
  /**
   * TASK-013 additions: custom codes in the application-defined range
   * (-32099..-32000 is reserved for implementation; we use the next
   * available slots above -32000 for semantic clarity).
   *
   * Unauthorized (-32011): 401 / 403 from Nexus REST — semantically distinct
   *   from InvalidRequest (-32600) so clients can detect auth failures without
   *   parsing the message string.
   * RateLimited (-32012): 429 Retry-After. Clients should honor
   *   `data.retry_after_seconds` before retrying.
   */
  Unauthorized = -32011,
  RateLimited = -32012,
}

/**
 * Base error for all errors this MCP server emits.
 *
 * Carries enough structured context to translate a thrown `NexusError` into a
 * JSON-RPC error response without re-inspecting the underlying axios / SDK
 * error.
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
   * Whether the MCP client may safely retry this request.
   * Populated by `mapHttpStatusToMcpError` and the NLI/network helpers.
   */
  public readonly retryable: boolean;

  /**
   * Additional structured data surfaced in the JSON-RPC `error.data` field.
   * Safe to serialize — must never contain auth tokens or raw SDK internals.
   * Populated by the mapping layer (e.g. `retry_after_seconds`, `network`,
   * `timeout`).
   */
  public readonly data?: Record<string, unknown>;

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
    options?: {
      retryable?: boolean;
      data?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "NexusError";
    this.mcpErrorCode = mcpErrorCode;
    this.httpStatus = httpStatus;
    this.retryable = options?.retryable ?? false;
    if (options?.data !== undefined) {
      this.data = options.data;
    }
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
   *
   * `data` IS included — it is caller-controlled structured metadata that
   * must never contain raw SDK objects (that would be caught during review
   * of `mapHttpStatusToMcpError` callers).
   */
  public toJSON(): {
    name: string;
    message: string;
    httpStatus: number | null;
    mcpErrorCode: McpErrorCode;
    data?: Record<string, unknown>;
  } {
    const base: {
      name: string;
      message: string;
      httpStatus: number | null;
      mcpErrorCode: McpErrorCode;
      data?: Record<string, unknown>;
    } = {
      name: this.name,
      message: this.message,
      httpStatus: this.httpStatus,
      mcpErrorCode: this.mcpErrorCode,
    };
    if (this.data !== undefined) {
      base.data = this.data;
    }
    return base;
  }
}

// ---------------------------------------------------------------------------
// HTTP-status → MCP-error-code mapping (proposal §M-3, TASK-013 Wave 2B)
// ---------------------------------------------------------------------------

/**
 * Canonical type for a function that maps an HTTP status + response body to
 * a `McpErrorCode`. `headers` is optional — only needed for 429 Retry-After
 * extraction. This type is the public contract; the concrete implementation
 * is `mapHttpStatusToMcpError`.
 */
export type ErrorMapping = (
  httpStatus: number | null,
  body: unknown,
  headers?: Record<string, string | string[] | undefined>,
) => NexusError;

/**
 * Shape of an axios-like error thrown by `@nexusm/sdk`.
 * We cannot import axios types here (would add a hard dep); instead we use
 * structural duck-typing checked by `isAxiosLikeError`.
 */
interface AxiosLikeError {
  isAxiosError: true;
  message: string;
  response?: {
    status: number;
    data?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  };
  code?: string; // e.g. "ECONNABORTED" for timeout, "ERR_NETWORK" for network
}

/**
 * Type guard for axios-compatible errors thrown by `@nexusm/sdk`.
 *
 * Matches any object with `isAxiosError === true`, which is the canonical
 * axios duck-type flag. This guard intentionally does NOT import axios — it
 * keeps `errors.ts` free of SDK runtime dependencies.
 */
export function isAxiosLikeError(err: unknown): err is AxiosLikeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)["isAxiosError"] === true
  );
}

/**
 * Parse a Retry-After header value into seconds.
 *
 * Handles both integer-seconds form ("60") and HTTP-date form
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns `undefined` if the header
 * is absent or unparseable — callers should degrade gracefully.
 */
function parseRetryAfterSeconds(
  headers: Record<string, string | string[] | undefined> | undefined,
): number | undefined {
  if (headers === undefined) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  // Integer seconds
  const asInt = parseInt(value, 10);
  if (!Number.isNaN(asInt) && String(asInt) === value.trim()) {
    return asInt;
  }
  // HTTP-date: compute delta from now
  const ts = Date.parse(value);
  if (!Number.isNaN(ts)) {
    const delta = Math.ceil((ts - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Canonical entrypoint for converting an upstream HTTP response (or SDK
 * network/timeout error) into a typed `NexusError` with the correct
 * `McpErrorCode`, `retryable` flag, and `data` extras.
 *
 * Proposal §M-3 mapping table:
 *
 * | httpStatus              | McpErrorCode      | retryable | data extras              |
 * |-------------------------|-------------------|-----------|--------------------------|
 * | 401, 403                | Unauthorized      | false     | —                        |
 * | 404                     | MethodNotFound    | false     | —                        |
 * | 422                     | InvalidParams     | false     | —                        |
 * | 429                     | RateLimited       | true*     | retry_after_seconds?: n  |
 * | 503                     | ConnectionClosed  | true      | —                        |
 * | 5xx (else)              | InternalError     | true      | —                        |
 * | null + network=true     | InternalError     | true      | network: true            |
 * | null + timeout=true     | RequestTimeout    | true      | timeout: true            |
 *
 * *429: retryable "after Retry-After header elapses" — we set retryable=true
 *  and populate `data.retry_after_seconds` so clients can honour the window.
 *
 * Note: HTTP 200 + body.errors != null is NOT an error; that is the
 * partial-degradation path handled in tool handlers (see context.ts). This
 * function is only invoked on non-2xx responses or SDK error throws.
 *
 * @param httpStatus  HTTP status code, or `null` for non-HTTP errors.
 * @param body        Raw response body (typed `unknown`; we do not parse it).
 * @param headers     Response headers, used only to extract Retry-After on 429.
 */
export function mapHttpStatusToMcpError(
  httpStatus: number | null,
  body: unknown,
  headers?: Record<string, string | string[] | undefined>,
): NexusError {
  // Non-HTTP origin: distinguish timeout from generic network failure by
  // inspecting whether the caller passed { timeout: true } in body (we
  // treat `body` as a hint bag for non-HTTP paths).
  if (httpStatus === null) {
    const hint = body as Record<string, unknown> | null | undefined;
    if (hint?.["timeout"] === true) {
      return new NexusError(
        "Request timed out",
        McpErrorCode.RequestTimeout,
        null,
        undefined,
        { retryable: true, data: { timeout: true } },
      );
    }
    return new NexusError(
      "Network error",
      McpErrorCode.InternalError,
      null,
      undefined,
      { retryable: true, data: { network: true } },
    );
  }

  switch (true) {
    case httpStatus === 401 || httpStatus === 403:
      return new NexusError(
        `Unauthorized (HTTP ${httpStatus})`,
        McpErrorCode.Unauthorized,
        httpStatus,
        undefined,
        { retryable: false },
      );

    case httpStatus === 404:
      return new NexusError(
        "Resource not found (HTTP 404)",
        McpErrorCode.MethodNotFound,
        404,
        undefined,
        { retryable: false },
      );

    case httpStatus === 422:
      return new NexusError(
        "Invalid parameters (HTTP 422)",
        McpErrorCode.InvalidParams,
        422,
        undefined,
        { retryable: false },
      );

    case httpStatus === 429: {
      const retryAfterSeconds = parseRetryAfterSeconds(headers);
      const data: Record<string, unknown> = {};
      if (retryAfterSeconds !== undefined) {
        data["retry_after_seconds"] = retryAfterSeconds;
      }
      return new NexusError(
        "Rate limited (HTTP 429)",
        McpErrorCode.RateLimited,
        429,
        undefined,
        { retryable: true, data: Object.keys(data).length > 0 ? data : undefined },
      );
    }

    case httpStatus === 503:
      return new NexusError(
        "Service unavailable (HTTP 503)",
        McpErrorCode.ConnectionClosed,
        503,
        undefined,
        { retryable: true },
      );

    case httpStatus >= 500:
      return new NexusError(
        `Internal server error (HTTP ${httpStatus})`,
        McpErrorCode.InternalError,
        httpStatus,
        undefined,
        { retryable: true },
      );

    default:
      // Catch-all for unexpected non-2xx codes not in the table.
      return new NexusError(
        `Unexpected HTTP error (status=${httpStatus})`,
        McpErrorCode.InternalError,
        httpStatus,
        undefined,
        { retryable: false },
      );
  }
}

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
