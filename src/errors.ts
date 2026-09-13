/**
 * Error contract and HTTP→MCP mapping for the Nexusm MCP server.
 *
 * Wave 1 (TASK-007): declared the type surface — NexusError, McpErrorCode,
 *   interface stubs for AuthError / NetworkError / CancelError.
 * Wave 2B (TASK-013): implements the full HTTP-status → MCP-error-code
 *   mapping (proposal §M-3) via `mapHttpStatusToMcpError` and
 *   `isAxiosLikeError`.
 * SDK error bridge (nexusm-mcp-server#32, 2026-09-12): `mapSdkErrorToMcpError`
 *   is the single entry point every tool's catch block uses. `@nexusm/sdk`
 *   has normalised axios failures into its own typed classes (`ApiError`,
 *   `TimeoutError`, `NetworkError`, and since 5.2.0 `UpstreamInterceptError`)
 *   since its v1.0.0 rewrite — none of them carry `isAxiosError`, so the
 *   `isAxiosLikeError` guard alone never matched anything the SDK actually
 *   throws and the whole §M-3 table was unreachable in production. The guard
 *   is kept only as a fallback for a raw axios error (e.g. a cancelled
 *   request the SDK re-throws unwrapped).
 *
 *   This file therefore has a runtime import from `@nexusm/sdk` (the HTTP
 *   SDK) — the "zero runtime import" rule below is about
 *   `@modelcontextprotocol/sdk` and still holds. `instanceof` against the
 *   real classes is deliberate: if the SDK renames or drops one of them the
 *   build breaks here instead of silently degrading to InternalError again.
 *
 * SECURITY (matches auth.ts discipline):
 *   `toJSON()` deliberately omits `cause` and `stack`. An axios-style error
 *   attached as `cause` typically carries the original request config
 *   including the `Authorization: Bearer <token>` header. Leaking that via a
 *   JSON.stringify of a NexusError would defeat the token-redaction guarantee
 *   of auth.ts. If callers need to inspect the cause they must do so
 *   explicitly, not via serialization.
 */

import {
  ApiError as SdkApiError,
  InputValidationError as SdkInputValidationError,
  NetworkError as SdkNetworkError,
  TimeoutError as SdkTimeoutError,
  UpstreamInterceptError as SdkUpstreamInterceptError,
} from '@nexusm/sdk';

import type { AuthConfig } from './auth.js';

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

  /**
   * JSON-RPC wire code — an alias of `mcpErrorCode`.
   *
   * `@modelcontextprotocol/sdk` (`shared/protocol.js`, request-failure
   * path) serialises a thrown handler error as
   * `{ code: Number.isSafeInteger(err.code) ? err.code : -32603, message,
   * data }`. It reads `code`, not `mcpErrorCode`. Before this alias existed
   * every NexusError reached the client as InternalError (-32603) no matter
   * what the mapping produced — the second half of the "§M-3 mapping is
   * dead in production" hole (nexusm-mcp-server#32). `data` already passed
   * through because the SDK reads it under the same name.
   */
  public get code(): number {
    return this.mcpErrorCode;
  }

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
    this.name = 'NexusError';
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
 * Shape of a raw axios error.
 *
 * `@nexusm/sdk` does NOT throw these for HTTP failures — its response
 * interceptor wraps them into the typed classes handled by
 * `mapSdkErrorToMcpError` below. The only raw axios error the SDK lets
 * through is a cancelled request (`axios.isCancel`), so this shape survives
 * purely as a fallback. We cannot import axios types here (would add a hard
 * dep); instead we use structural duck-typing checked by `isAxiosLikeError`.
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
 * Type guard for raw axios errors (fallback path — see `AxiosLikeError`).
 *
 * Matches any object with `isAxiosError === true`, which is the canonical
 * axios duck-type flag. This guard intentionally does NOT import axios — it
 * keeps `errors.ts` free of an axios runtime dependency.
 */
export function isAxiosLikeError(err: unknown): err is AxiosLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>)['isAxiosError'] === true
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
  const raw = headers['retry-after'] ?? headers['Retry-After'];
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
 * @param cause       Original error, attached as `NexusError.cause` (never
 *                    serialized — see file header SECURITY note).
 */
export function mapHttpStatusToMcpError(
  httpStatus: number | null,
  body: unknown,
  headers?: Record<string, string | string[] | undefined>,
  cause?: unknown,
): NexusError {
  // Non-HTTP origin: distinguish timeout from generic network failure by
  // inspecting whether the caller passed { timeout: true } in body (we
  // treat `body` as a hint bag for non-HTTP paths).
  if (httpStatus === null) {
    const hint = body as Record<string, unknown> | null | undefined;
    if (hint?.['timeout'] === true) {
      return timeoutNexusError(undefined, cause);
    }
    return networkNexusError(undefined, cause);
  }

  switch (true) {
    case httpStatus === 401 || httpStatus === 403:
      return new NexusError(
        `Unauthorized (HTTP ${httpStatus})`,
        McpErrorCode.Unauthorized,
        httpStatus,
        cause,
        { retryable: false },
      );

    case httpStatus === 404:
      return new NexusError(
        'Resource not found (HTTP 404)',
        McpErrorCode.MethodNotFound,
        404,
        cause,
        {
          retryable: false,
        },
      );

    case httpStatus === 422:
      return new NexusError(
        'Invalid parameters (HTTP 422)',
        McpErrorCode.InvalidParams,
        422,
        cause,
        {
          retryable: false,
        },
      );

    case httpStatus === 429: {
      const retryAfterSeconds = parseRetryAfterSeconds(headers);
      const data: Record<string, unknown> = {};
      if (retryAfterSeconds !== undefined) {
        data['retry_after_seconds'] = retryAfterSeconds;
      }
      return new NexusError('Rate limited (HTTP 429)', McpErrorCode.RateLimited, 429, cause, {
        retryable: true,
        data: Object.keys(data).length > 0 ? data : undefined,
      });
    }

    case httpStatus === 503:
      return new NexusError(
        'Service unavailable (HTTP 503)',
        McpErrorCode.ConnectionClosed,
        503,
        cause,
        { retryable: true },
      );

    case httpStatus >= 500:
      return new NexusError(
        `Internal server error (HTTP ${httpStatus})`,
        McpErrorCode.InternalError,
        httpStatus,
        cause,
        { retryable: true },
      );

    default:
      // Catch-all for unexpected non-2xx codes not in the table.
      return new NexusError(
        `Unexpected HTTP error (status=${httpStatus})`,
        McpErrorCode.InternalError,
        httpStatus,
        cause,
        { retryable: false },
      );
  }
}

/** `null + network=true` row of the §M-3 table. `detail` (the SDK's own
 *  message, e.g. `connect ECONNREFUSED 127.0.0.1:8001`) is appended when
 *  known — it is what tells an operator the URL is wrong. */
function networkNexusError(detail: string | undefined, cause?: unknown): NexusError {
  const message =
    detail !== undefined && detail !== '' ? `Network error: ${detail}` : 'Network error';
  return new NexusError(message, McpErrorCode.InternalError, null, cause, {
    retryable: true,
    data: { network: true },
  });
}

/** `null + timeout=true` row of the §M-3 table. */
function timeoutNexusError(detail: string | undefined, cause?: unknown): NexusError {
  const message =
    detail !== undefined && detail !== '' ? `Request timed out: ${detail}` : 'Request timed out';
  return new NexusError(message, McpErrorCode.RequestTimeout, null, cause, {
    retryable: true,
    data: { timeout: true },
  });
}

// ---------------------------------------------------------------------------
// @nexusm/sdk error → NexusError bridge (nexusm-mcp-server#32)
// ---------------------------------------------------------------------------

/**
 * Machine-readable codes the SDK stamps on its error classes
 * (`@nexusm/sdk` `errors/base.ts` + `errors/api.ts`). The SDK documents
 * `code` as its programmatic-handling contract, which makes it the right
 * second criterion when `instanceof` cannot be trusted (see
 * `mapSdkErrorToMcpError`).
 */
const SDK_CODE = {
  upstreamIntercept: 'NEXUS_UPSTREAM_INTERCEPT',
  timeout: 'NEXUS_TIMEOUT_ERROR',
  network: 'NEXUS_NETWORK_ERROR',
  inputValidation: 'NEXUS_INPUT_VALIDATION_ERROR',
} as const;

/** Codes of `ApiError` and its subclasses — everything that carries `statusCode`. */
const SDK_API_CODES: ReadonlySet<string> = new Set([
  'NEXUS_API_ERROR',
  'NEXUS_AUTHENTICATION_ERROR',
  'NEXUS_RATE_LIMIT_ERROR',
  'NEXUS_VALIDATION_ERROR',
  'NEXUS_NOT_FOUND_ERROR',
  SDK_CODE.upstreamIntercept,
]);

/** Read `code` off an unknown value when it looks like an SDK code. */
function sdkCodeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('NEXUS_') ? code : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

function statusCodeOf(err: unknown): number | null {
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

/**
 * Best-effort extraction from the SDK's `UpstreamInterceptError` message.
 *
 * The SDK builds two message shapes (`@nexusm/sdk` `http/client.ts`,
 * `upstreamRedirectError` / `assertNotIntercepted`):
 *   - `... was redirected (HTTP 302) to <host> instead of being answered ...`
 *   - `... returned HTTP 200 with content-type "<type>" where JSON was expected ...`
 * Only the host / content-type tokens are lifted out — never the URL, and
 * never anything from headers. On wording drift the fields are simply
 * omitted; the classification itself does not depend on the message.
 */
const REDIRECT_HOST_RE = /redirected \(HTTP \d{3}\) to (.+?) instead of being answered/;
const CONTENT_TYPE_RE = /with content-type "([^"]*)" where JSON was expected/;
/** The SDK substitutes these when the Location header is absent / unparseable. */
const SDK_HOST_PLACEHOLDER_RE = /^an (?:unknown host|unparseable location)$/;

function upstreamInterceptToMcpError(err: unknown): NexusError {
  const status = statusCodeOf(err);
  const message = messageOf(err);
  const data: Record<string, unknown> = { upstream_intercept: true };
  // `httpStatus` never reaches the JSON-RPC wire (the MCP SDK serialises
  // only code / message / data), so the edge's status is repeated in `data`.
  if (status !== null) data['http_status'] = status;

  const hostMatch = REDIRECT_HOST_RE.exec(message);
  const host =
    hostMatch !== null && !SDK_HOST_PLACEHOLDER_RE.test(hostMatch[1] ?? '')
      ? hostMatch[1]
      : undefined;
  if (host !== undefined) data['redirect_host'] = host;

  const contentType = CONTENT_TYPE_RE.exec(message)?.[1];
  if (contentType !== undefined) data['content_type'] = contentType;

  const statusText = status !== null ? `HTTP ${status}` : 'unknown status';
  const where = host !== undefined ? `, redirected to ${host}` : '';
  return new NexusError(
    `Request was intercepted before it reached Nexus (${statusText}${where}): an auth edge, ` +
      'proxy or captive portal answered instead of the API. This is almost always a local ' +
      'credential or configuration problem — an expired edge credential such as a Cloudflare ' +
      'Access service token, or NEXUS_API_URL pointing at the wrong origin — not a Nexus ' +
      'outage. Fix the credential / URL and call again.',
    McpErrorCode.Unauthorized,
    status,
    err,
    { retryable: false, data },
  );
}

/**
 * Single bridge from whatever a `@nexusm/sdk` call throws to a `NexusError`.
 * Every tool's catch block must go through here (nexusm-mcp-server#32).
 *
 * | SDK throws                                   | NexusError                                              |
 * |----------------------------------------------|---------------------------------------------------------|
 * | `UpstreamInterceptError` (3xx / 2xx non-JSON)| Unauthorized, retryable=false, data.upstream_intercept  |
 * | `TimeoutError`                               | RequestTimeout, data.timeout (§M-3 null+timeout row)    |
 * | `NetworkError`                               | InternalError, data.network (§M-3 null+network row)     |
 * | `InputValidationError` (client-side zod)     | InvalidParams, retryable=false                          |
 * | `ApiError` + subclasses (`statusCode`)       | `mapHttpStatusToMcpError(statusCode, response, ...)`;   |
 * |                                              | `RateLimitError.retryAfter` → data.retry_after_seconds  |
 * | raw axios error (`isAxiosError`)             | `mapHttpStatusToMcpError(response.status, ...)` fallback|
 * | anything else                                | InternalError, retryable=false, message kept            |
 *
 * `UpstreamInterceptError` is an `ApiError` subclass and is matched first
 * on purpose: its `statusCode` is the edge's (302 / 200), and feeding that
 * into the §M-3 table would produce "Unexpected HTTP error (status=302)" —
 * which reads as a Nexus outage when it is a local credential problem.
 *
 * Two criteria per class, in order:
 *   1. `instanceof` against the classes imported from `@nexusm/sdk` — exact,
 *      and a compile-time lock (a renamed / removed class fails the build).
 *   2. the SDK's documented `code` string — survives the cases where module
 *      identity is lost: a second copy of `@nexusm/sdk` hoisted by a host
 *      package manager, a bundler that duplicates the package, or a test that
 *      mocks the module and hands back a structurally-equal object.
 *
 * @param err       whatever the SDK call rejected with.
 * @param toolName  used only to prefix the message of the fallback branch.
 */
export function mapSdkErrorToMcpError(err: unknown, toolName?: string): NexusError {
  // Already translated (e.g. thrown by a validator inside the try block).
  if (err instanceof NexusError) return err;

  const code = sdkCodeOf(err);

  if (err instanceof SdkUpstreamInterceptError || code === SDK_CODE.upstreamIntercept) {
    return upstreamInterceptToMcpError(err);
  }

  if (err instanceof SdkTimeoutError || code === SDK_CODE.timeout) {
    return timeoutNexusError(messageOf(err), err);
  }

  if (err instanceof SdkNetworkError || code === SDK_CODE.network) {
    return networkNexusError(messageOf(err), err);
  }

  if (err instanceof SdkInputValidationError || code === SDK_CODE.inputValidation) {
    return new NexusError(
      `Invalid parameters (rejected by SDK before the request was sent): ${messageOf(err)}`,
      McpErrorCode.InvalidParams,
      null,
      err,
      { retryable: false },
    );
  }

  if (err instanceof SdkApiError || (code !== undefined && SDK_API_CODES.has(code))) {
    const status = statusCodeOf(err);
    const body = (err as { response?: unknown }).response;
    // `RateLimitError.retryAfter` is the SDK's already-parsed Retry-After
    // (seconds, `Number(header)` — NaN when the header was an HTTP-date, in
    // which case the SDK lost it and so do we). Re-expressed as a header so
    // the §M-3 429 row stays the single parser.
    const retryAfter = (err as { retryAfter?: unknown }).retryAfter;
    const headers =
      typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
        ? { 'retry-after': String(Math.ceil(retryAfter)) }
        : undefined;
    return mapHttpStatusToMcpError(status, body, headers, err);
  }

  // Fallback 1: a raw axios error (only cancellations reach here from the SDK).
  if (isAxiosLikeError(err)) {
    return mapHttpStatusToMcpError(
      err.response?.status ?? null,
      err.response?.data,
      err.response?.headers,
      err,
    );
  }

  // Fallback 2: unknown throwable. Not labelled as a network failure on
  // purpose — "retry, Nexus is down" is exactly the misdiagnosis #32 is about.
  const prefix = toolName !== undefined ? `${toolName} failed: ` : 'Nexus call failed: ';
  return new NexusError(`${prefix}${messageOf(err)}`, McpErrorCode.InternalError, null, err, {
    retryable: false,
  });
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
  readonly reason: 'client_cancel' | 'timeout' | 'signal';
}
