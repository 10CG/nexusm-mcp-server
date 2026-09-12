/**
 * Loopback integration test for the @nexusm/sdk → MCP error bridge
 * (nexusm-mcp-server#32).
 *
 * Every other error-path test in this repo hands the tool handlers an error
 * object constructed by the test. That is exactly how the original bug hid:
 * the tests constructed `{ isAxiosError: true, ... }`, the SDK never throws
 * that shape, and the whole §M-3 mapping was unreachable in production while
 * CI stayed green. This file removes the last assumption by driving the
 * REAL `@nexusm/sdk` HTTP client (axios + its response interceptor) against
 * a local `node:http` server that answers the way an auth edge, a captive
 * portal, or Nexus itself would:
 *
 *   | server answers                     | SDK throws              | NexusError expected                          |
 *   |------------------------------------|-------------------------|----------------------------------------------|
 *   | 302 + Location (CF Access style)   | UpstreamInterceptError  | Unauthorized + upstream_intercept + host     |
 *   | 200 text/html (captive portal)     | UpstreamInterceptError  | Unauthorized + upstream_intercept + c-type   |
 *   | 401 JSON                           | AuthenticationError     | Unauthorized, no upstream_intercept          |
 *   | 404 JSON                           | NotFoundError           | MethodNotFound                               |
 *   | 422 JSON                           | ApiError(422)           | InvalidParams                                |
 *   | 429 + Retry-After                  | RateLimitError          | RateLimited + retry_after_seconds            |
 *   | 500 JSON                           | ApiError(500)           | InternalError, retryable                     |
 *   | (never answers)                    | TimeoutError            | RequestTimeout + data.timeout                |
 *   | (nothing listening)                | NetworkError            | InternalError + data.network                 |
 *
 * The retryable rows (429 / 500 / timeout / refused) go through
 * `nexus.context_retrieve` with an injected `NexusClient({ retry: false })`
 * so the SDK's default 3-attempt back-off (1 s / 2 s / 4 s) does not make
 * the suite slow; the non-retryable rows go through the other three tools
 * exactly as production builds them — from `NEXUS_*` env via
 * `loadAuthConfig()`.
 *
 * The last block spawns the compiled server over stdio and asserts the
 * JSON-RPC `error.code` / `error.data` a real MCP client receives. That is
 * the only place the second half of #32 is observable: the MCP SDK reads
 * `err.code` when serialising a thrown handler error, and `NexusError` had
 * no such property, so even a correctly mapped error used to reach clients
 * as -32603. It needs `dist/index.js` (CI runs `npm run build` before
 * `test:integration`); locally, build first or the block is skipped.
 *
 * No external network: 127.0.0.1 only. The server never logs headers.
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NexusClient } from '@nexusm/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import type { AuthConfig } from '../../src/auth.js';
import { McpErrorCode, NexusError } from '../../src/errors.js';
import {
  contextRetrieveTool,
  __setAuthForTesting,
  __setClientForTesting,
} from '../../src/tools/context.js';
import {
  memoryCreateTool,
  __resetClientForTesting as resetCreateClient,
} from '../../src/tools/memory_create.js';
import {
  memoryFeedbackTool,
  __resetClientForTesting as resetFeedbackClient,
  __setAuditLoggerForTesting,
} from '../../src/tools/memory_feedback.js';
import {
  memorySearchTool,
  __resetClientForTesting as resetSearchClient,
} from '../../src/tools/memory_search.js';

// ---------------------------------------------------------------------------
// Loopback server
// ---------------------------------------------------------------------------

type Responder = (req: IncomingMessage, res: ServerResponse) => void;

const TOKEN = 'loopback-token-DO-NOT-LEAK';
const TENANT = 'loopback-tenant';
const USER = 'loopback-user';
const RETRIEVE_ID = '33333333-3333-3333-3333-333333333333';

let server: Server;
let baseUrl: string;
let respond: Responder;
const pendingTimers: NodeJS.Timeout[] = [];

const json =
  (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Responder =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(body));
  };

/** Cloudflare Access style: unauthenticated call bounced to the login page. */
const redirectToLogin: Responder = (_req, res) => {
  res.writeHead(302, {
    location: 'https://login.loopback.example/cdn-cgi/access/login/nexus?redirect_url=%2Fv1%2F',
    'content-type': 'text/html',
  });
  res.end('<html>login</html>');
};

/** Captive portal style: 200 with its own HTML. */
const portalHtml: Responder = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html>captive portal</html>');
};

/** Hold the response longer than the client's timeout, then let go. */
const neverAnswers: Responder = (_req, res) => {
  pendingTimers.push(setTimeout(() => res.end(), 1_500));
};

function resetResponder(): void {
  respond = json(500, { detail: 'responder not set by the test' });
}

async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

beforeAll(async () => {
  resetResponder();
  server = createServer((req, res) => {
    // Drain the request body before answering so the client never sees a
    // reset on a half-read connection. Nothing about the request is logged.
    req.on('data', () => undefined);
    req.on('end', () => respond(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;

  // The three env-built tools construct their NexusClient from these.
  process.env.NEXUS_API_URL = baseUrl;
  process.env.NEXUS_API_TOKEN = TOKEN;
  process.env.NEXUS_TENANT_ID = TENANT;
  __setAuditLoggerForTesting(() => undefined);
});

afterAll(async () => {
  for (const t of pendingTimers) clearTimeout(t);
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  __setAuditLoggerForTesting(null);
  delete process.env.NEXUS_API_URL;
  delete process.env.NEXUS_API_TOKEN;
  delete process.env.NEXUS_TENANT_ID;
});

beforeEach(() => {
  resetResponder();
  __setClientForTesting(null);
  __setAuthForTesting(null);
  resetSearchClient();
  resetCreateClient();
  resetFeedbackClient();
});

afterEach(() => {
  __setClientForTesting(null);
  __setAuthForTesting(null);
});

/** Inject a real NexusClient into context.ts with retries off. */
function injectContextClient(options: { timeout?: number; url?: string } = {}): void {
  const url = options.url ?? baseUrl;
  const auth: AuthConfig = { apiUrl: url, apiToken: TOKEN, tenantId: TENANT };
  __setAuthForTesting(auth);
  __setClientForTesting(
    new NexusClient({
      apiKey: TOKEN,
      tenantId: TENANT,
      baseUrl: url,
      retry: false,
      timeout: options.timeout ?? 5_000,
    }),
  );
}

async function catchNexusError(fn: () => Promise<unknown>): Promise<NexusError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof NexusError) return err;
    throw new Error(
      `expected a NexusError, got ${(err as Error)?.name ?? typeof err}: ${(err as Error)?.message}`,
    );
  }
  throw new Error('expected the handler to throw, but it resolved');
}

const callContext = () => contextRetrieveTool.handler({ user_id: USER, query: 'loopback' });
const callSearch = () => memorySearchTool.handler({ user_id: USER, query: 'loopback' });
const callCreate = () =>
  memoryCreateTool.handler({ user_id: USER, content: 'loopback', memory_type: 'semantic' });
const callFeedback = () =>
  memoryFeedbackTool.handler({ user_id: USER, retrieve_id: RETRIEVE_ID, rating: 5 });

function expectNoLeak(err: NexusError): void {
  const serialized = JSON.stringify(err.toJSON());
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain('X-API-Key');
  expect(serialized).not.toContain('<html>');
}

// ---------------------------------------------------------------------------
// Upstream interception — the #32 shapes, produced by the real interceptor
// ---------------------------------------------------------------------------

describe('loopback: real @nexusm/sdk interceptor → bridge (upstream interception)', () => {
  it('302 → login page through nexus.context_retrieve (env-built client): Unauthorized + upstream_intercept + redirect_host', async () => {
    respond = redirectToLogin;

    const err = await catchNexusError(callContext);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.code).toBe(-32011);
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(302);
    expect(err.data).toEqual({
      upstream_intercept: true,
      http_status: 302,
      redirect_host: 'login.loopback.example',
    });
    expect(err.message).toMatch(/intercepted before it reached Nexus/);
    expect(err.message).toMatch(/not a Nexus outage/);
    // The redirect URL's query string must not surface (only the host does).
    expect(err.message).not.toContain('redirect_url');
    expectNoLeak(err);
  });

  it('200 + text/html through nexus.memory_search (env-built client): Unauthorized + upstream_intercept + content_type', async () => {
    respond = portalHtml;

    const err = await catchNexusError(callSearch);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(200);
    expect(err.data).toEqual({
      upstream_intercept: true,
      http_status: 200,
      content_type: 'text/html; charset=utf-8',
    });
    expectNoLeak(err);
  });

  it('302 through nexus.memory_create and nexus.memory_feedback too — every tool takes the same bridge', async () => {
    respond = redirectToLogin;

    for (const call of [callCreate, callFeedback]) {
      const err = await catchNexusError(call);
      expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
      expect(err.data?.['upstream_intercept']).toBe(true);
      expect(err.data?.['redirect_host']).toBe('login.loopback.example');
    }
  });
});

// ---------------------------------------------------------------------------
// Real Nexus answers — the §M-3 table, reached for the first time
// ---------------------------------------------------------------------------

describe('loopback: real @nexusm/sdk interceptor → bridge (§M-3 table)', () => {
  it('401 JSON through nexus.memory_feedback: Unauthorized, httpStatus=401, NOT an upstream intercept', async () => {
    respond = json(401, { detail: 'Invalid API key' });

    const err = await catchNexusError(callFeedback);
    expect(err.mcpErrorCode).toBe(McpErrorCode.Unauthorized);
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.data?.['upstream_intercept']).toBeUndefined();
    expectNoLeak(err);
  });

  it('404 JSON through nexus.memory_create: MethodNotFound', async () => {
    respond = json(404, { detail: 'Not Found' });

    const err = await catchNexusError(callCreate);
    expect(err.mcpErrorCode).toBe(McpErrorCode.MethodNotFound);
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it('422 JSON through nexus.memory_create: InvalidParams', async () => {
    respond = json(422, { detail: [{ loc: ['body', 'content'], msg: 'field required' }] });

    const err = await catchNexusError(callCreate);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(err.httpStatus).toBe(422);
  });

  it('429 + Retry-After: 7 through nexus.context_retrieve (retry off): RateLimited + retry_after_seconds=7', async () => {
    respond = json(429, { detail: 'Rate limit exceeded' }, { 'retry-after': '7' });
    injectContextClient();

    const err = await catchNexusError(callContext);
    expect(err.mcpErrorCode).toBe(McpErrorCode.RateLimited);
    expect(err.code).toBe(-32012);
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ retry_after_seconds: 7 });
  });

  it('500 JSON through nexus.context_retrieve (retry off): InternalError, retryable=true', async () => {
    respond = json(500, { detail: 'boom' });
    injectContextClient();

    const err = await catchNexusError(callContext);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.httpStatus).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.data?.['network']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No answer at all — TimeoutError / NetworkError from the real client
// ---------------------------------------------------------------------------

describe('loopback: real @nexusm/sdk interceptor → bridge (timeout / connection refused)', () => {
  it('server never answers, client timeout 200 ms: RequestTimeout + data.timeout', async () => {
    respond = neverAnswers;
    injectContextClient({ timeout: 200 });

    const err = await catchNexusError(callContext);
    expect(err.mcpErrorCode).toBe(McpErrorCode.RequestTimeout);
    expect(err.code).toBe(-32001);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ timeout: true });
    expect(err.message).toMatch(/timed out after 200ms/);
  });

  it('nothing listening on the port: InternalError + data.network, ECONNREFUSED kept in the message', async () => {
    const port = await closedPort();
    injectContextClient({ url: `http://127.0.0.1:${port}/v1` });

    const err = await catchNexusError(callContext);
    expect(err.mcpErrorCode).toBe(McpErrorCode.InternalError);
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(true);
    expect(err.data).toEqual({ network: true });
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.message).toContain(String(port));
  });
});

// ---------------------------------------------------------------------------
// On the wire — what an MCP client actually receives (needs dist/index.js)
// ---------------------------------------------------------------------------

const SERVER_BINARY = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');

describe.skipIf(!existsSync(SERVER_BINARY))(
  'stdio round-trip: JSON-RPC error.code / error.data as received by a real MCP client',
  () => {
    let client: Client;

    beforeAll(async () => {
      const env: Record<string, string> = {};
      // Host NEXUS_* was scrubbed by the integration setup; what is left is
      // the loopback trio set above plus PATH & co.
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      env.NEXUS_API_URL = baseUrl;
      env.NEXUS_API_TOKEN = TOKEN;
      env.NEXUS_TENANT_ID = TENANT;

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_BINARY],
        env,
      });
      client = new Client({ name: 'loopback-bridge-test', version: '0.0.1' }, { capabilities: {} });
      await client.connect(transport);
    }, 20_000);

    afterAll(async () => {
      try {
        await client.close();
      } catch {
        // process may already be gone
      }
    });

    async function callAndCatchMcpError(
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpError> {
      try {
        await client.callTool({ name, arguments: args });
      } catch (err) {
        if (err instanceof McpError) return err;
        throw new Error(
          `expected McpError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
        );
      }
      throw new Error('expected tools/call to fail, but it resolved');
    }

    it('302 → login page arrives as error.code -32011 with data.upstream_intercept (not -32603)', async () => {
      respond = redirectToLogin;

      const err = await callAndCatchMcpError('nexus.memory_search', { user_id: USER, query: 'q' });
      expect(err.code).toBe(McpErrorCode.Unauthorized);
      expect(err.code).toBe(-32011);
      expect(err.data).toEqual({
        upstream_intercept: true,
        http_status: 302,
        redirect_host: 'login.loopback.example',
      });
      expect(err.message).toMatch(/intercepted before it reached Nexus/);
      expect(err.message).not.toContain(TOKEN);
    });

    it('404 from Nexus arrives as error.code -32601 (a second distinct code, proving the alias is live)', async () => {
      respond = json(404, { detail: 'Not Found' });

      const err = await callAndCatchMcpError('nexus.memory_create', {
        user_id: USER,
        content: 'loopback',
        memory_type: 'semantic',
      });
      expect(err.code).toBe(McpErrorCode.MethodNotFound);
      expect(err.code).toBe(-32601);
      expect(err.data).toBeUndefined();
    });
  },
);
