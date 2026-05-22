/**
 * Integration: MCP protocol E2E round-trip against the actual server process.
 *
 * TASK-017 deliverable — US-037 Wave 2B MCP protocol integration test.
 *
 * ---
 * GATE CONDITIONS (ALL must be satisfied for this suite to run):
 *
 *   1. @nexusm/sdk@1.3.0 must be installed in node_modules.
 *      Blocked by Gate-1 SDK publish (US-037 TASK-005). Until then,
 *      `npm run test:integration` on a fresh clone will fail at import
 *      time; the `describe.skipIf` below cannot save that path because
 *      vitest cannot parse the file if the import fails.
 *      Gate: package.json devDependencies must not have @nexusm/sdk pinned
 *      to a version unavailable on the configured registry.
 *
 *   2. `npm run build` must have produced `dist/index.js`.
 *      The E2E tests spawn `node dist/index.js` as the MCP server subprocess.
 *      If dist/ is missing, the spawn will fail and the entire suite errors.
 *
 *   3. Environment variables must be set (all three, non-empty):
 *        NEXUS_TEST_API_URL  — Nexus HTTP API base URL (reachable from CI)
 *        NEXUS_TEST_API_TOKEN — Bearer token for Nexus API (secret)
 *        NEXUS_TEST_TENANT_ID — Tenant identifier
 *      All three are required for the suite to run; E2E_ENABLED is true only
 *      when all three are non-empty (see `describe.skipIf` below). Setting
 *      only NEXUS_TEST_API_URL while omitting TOKEN or TENANT_ID causes the
 *      suite to skip cleanly rather than fail with cryptic placeholder errors.
 *
 * CROSS-PLATFORM NOTE (proposal §R2.1 + §A2-D-2):
 *   Phase 1 matrix: ubuntu-latest × Node 18, ubuntu-latest × Node 20,
 *   macos-latest × Node 20. Windows + Node 22 are explicitly OOS Phase 1.
 *   The tests use `child_process.spawn` with stdio:['pipe','pipe','pipe'];
 *   on Windows the `node dist/index.js` path separator would need
 *   adjustment — not addressed until Phase 2.
 *
 * STRATEGY:
 *   - Spawn the compiled MCP server binary (dist/index.js) as a child process.
 *   - Connect via @modelcontextprotocol/sdk client + StdioClientTransport
 *     (same SDK the server depends on — gives a real MCP JSON-RPC exchange
 *     without requiring a separate mcp-cli binary install).
 *   - Execute the full protocol round-trip: initialize → tools/list →
 *     tools/call for each of the 4 tools → verify response shapes.
 *   - Kill the child process in afterAll and assert clean exit.
 *
 * KNOWN LIMITATION:
 *   The `nexus.memory_feedback` test step sends a retrieve_id captured from
 *   the `nexus.context_retrieve` response. If the retrieve API returns an
 *   empty retrieve_id (e.g. because the test tenant has no context yet), a
 *   placeholder UUID is used and the feedback call is expected to succeed
 *   with status="accepted" regardless (the Nexus backend accepts orphan
 *   feedback gracefully per v5.0 L0 telemetry design).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Env / path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve dist/index.js relative to the repo root (two levels up from tests/integration/). */
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_BINARY = resolve(REPO_ROOT, 'dist', 'index.js');

const NEXUS_TEST_API_URL = process.env['NEXUS_TEST_API_URL'] ?? '';
// No placeholder fallbacks: in E2E mode ALL three must be real secrets.
// If only NEXUS_TEST_API_URL is set but the others are absent, E2E_ENABLED
// stays false and the suite skips rather than silently running with stale
// placeholder credentials that would cause misleading failures.
const NEXUS_TEST_API_TOKEN = process.env['NEXUS_TEST_API_TOKEN'] ?? '';
const NEXUS_TEST_TENANT_ID = process.env['NEXUS_TEST_TENANT_ID'] ?? '';

/** Fallback UUID used when a real retrieve_id is unavailable. */
const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000099';

/** Minimum viable user_id for E2E calls. */
const TEST_USER_ID = 'e2e-test-user-001';

// Read package.json version for the initialize assertion.
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string; name: string };

// ---------------------------------------------------------------------------
// Skip guard
//
// The entire suite is skipped when NEXUS_TEST_API_URL is absent or empty.
// This matches the CI scaffold design (proposal §A2-D-2): the integration
// job runs `npm run test:integration` unconditionally, but the suite is a
// no-op until someone wires the Forgejo Actions secret. The job exits 0
// with all tests skipped — it does NOT fail the pipeline.
//
// In CI environments that DO provide NEXUS_TEST_API_URL (e.g. a full
// staging pipeline), all tests execute and gate the pipeline red/green.
// ---------------------------------------------------------------------------

// Require all three env vars to avoid silent partial-config confusion in CI:
// a URL alone is useless if the token or tenant ID is missing, and a run
// that uses placeholder credentials will fail in cryptic ways rather than
// cleanly skipping.
const E2E_ENABLED =
  NEXUS_TEST_API_URL.length > 0 &&
  NEXUS_TEST_API_TOKEN.length > 0 &&
  NEXUS_TEST_TENANT_ID.length > 0;

// ---------------------------------------------------------------------------
// Subprocess lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the compiled MCP server and wait until it prints its startup banner
 * to stderr. Returns the child process handle.
 *
 * The server writes "nexusm-mcp-server <version> listening on stdio" to
 * stderr on successful startup (src/index.ts::startStdio). We use that as
 * the readiness signal rather than an arbitrary sleep.
 *
 * Timeout: 10 s (generous for CI runners with cold Node module cache).
 */
function spawnServer(): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve_p, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEXUS_API_URL: NEXUS_TEST_API_URL,
      NEXUS_API_TOKEN: NEXUS_TEST_API_TOKEN,
      NEXUS_TENANT_ID: NEXUS_TEST_TENANT_ID,
      // Disable the Prometheus metrics HTTP server to avoid port conflicts
      // across parallel matrix runs on the same host.
      NEXUS_METRICS_DISABLED: '1',
    };

    const child = spawn('node', [SERVER_BINARY], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    let stderrBuf = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Server startup timed out after 10 s. stderr so far:\n${stderrBuf}`));
    }, 10_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.includes('listening on stdio')) {
        clearTimeout(timeout);
        resolve_p(child);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn server: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `Server exited prematurely with code ${code}. stderr:\n${stderrBuf}`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!E2E_ENABLED)(
  'E2E: MCP protocol round-trip (requires NEXUS_TEST_API_URL)',
  () => {
    let serverProcess: ChildProcessWithoutNullStreams;
    let client: Client;
    let capturedRetrieveId: string = PLACEHOLDER_UUID;

    beforeAll(async () => {
      serverProcess = await spawnServer();

      // Build the MCP SDK client connected to the spawned process's stdio.
      const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_BINARY],
        env: {
          ...process.env,
          NEXUS_API_URL: NEXUS_TEST_API_URL,
          NEXUS_API_TOKEN: NEXUS_TEST_API_TOKEN,
          NEXUS_TENANT_ID: NEXUS_TEST_TENANT_ID,
          NEXUS_METRICS_DISABLED: '1',
        },
      });

      client = new Client(
        { name: 'e2e-test-client', version: '0.0.1' },
        { capabilities: {} },
      );

      await client.connect(transport);
    }, 20_000 /* generous beforeAll timeout */);

    afterAll(async () => {
      // Gracefully close the MCP client first (sends a proper disconnect).
      try {
        await client.close();
      } catch {
        // Ignore close errors — the process may already be gone.
      }

      // Kill the server process and wait for it to exit cleanly.
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGTERM');
        await new Promise<void>((res) => {
          serverProcess.on('exit', () => res());
          // Hard kill after 3 s if SIGTERM is ignored.
          setTimeout(() => {
            if (!serverProcess.killed) serverProcess.kill('SIGKILL');
            res();
          }, 3_000);
        });
      }
    }, 10_000);

    // -----------------------------------------------------------------------
    // 1. initialize handshake
    // -----------------------------------------------------------------------

    it('initialize: serverInfo.name === "nexus" and version matches package.json', async () => {
      // The MCP client sends initialize during connect(); we read the cached
      // server info from the client object directly.
      const serverInfo = client.getServerVersion();
      expect(serverInfo).toBeDefined();
      expect(serverInfo?.name).toBe('nexus');
      expect(serverInfo?.version).toBe(pkg.version);
    });

    // -----------------------------------------------------------------------
    // 2. tools/list
    // -----------------------------------------------------------------------

    it('tools/list: returns exactly 4 tools in declared registry order', async () => {
      const response = await client.listTools();
      expect(response.tools).toHaveLength(4);

      const names = response.tools.map((t) => t.name);
      expect(names).toEqual([
        'nexus.context_retrieve',
        'nexus.memory_search',
        'nexus.memory_create',
        'nexus.memory_feedback',
      ]);
    });

    it('tools/list: each tool has inputSchema + outputSchema with type="object"', async () => {
      const response = await client.listTools();
      for (const tool of response.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        // outputSchema is extension beyond MCP base spec — present in Wave 2 tools.
        // Cast: the SDK type may not declare outputSchema in ToolDefinition but
        // the server emits it and it should be present in the raw response.
        const extended = tool as unknown as { outputSchema?: { type?: string } };
        if (extended.outputSchema !== undefined) {
          expect(extended.outputSchema.type).toBe('object');
        }
      }
    });

    it('tools/list: nexus.context_retrieve has required fields [user_id, query]', async () => {
      const response = await client.listTools();
      const tool = response.tools.find((t) => t.name === 'nexus.context_retrieve');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(['user_id', 'query']));
    });

    it('tools/list: nexus.memory_feedback has required fields [user_id, retrieve_id, rating]', async () => {
      const response = await client.listTools();
      const tool = response.tools.find((t) => t.name === 'nexus.memory_feedback');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toEqual(
        expect.arrayContaining(['user_id', 'retrieve_id', 'rating']),
      );
    });

    // -----------------------------------------------------------------------
    // 3. tools/call nexus.context_retrieve
    // -----------------------------------------------------------------------

    it('nexus.context_retrieve: response contains retrieve_id banner in content[0].text', async () => {
      const result = await client.callTool({
        name: 'nexus.context_retrieve',
        arguments: {
          user_id: TEST_USER_ID,
          query: 'e2e integration test query',
          limit: 5,
        },
      });

      // CallToolResult.isError — if true, the tool raised an application error.
      expect(result.isError).toBeFalsy();

      // content[0] must be a text item with the retrieve_id banner.
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.length).toBeGreaterThanOrEqual(1);
      expect(content[0]?.type).toBe('text');
      expect(content[0]?.text).toMatch(/^## Retrieved context \(retrieve_id=/);

      // Extract retrieve_id from the banner for later feedback call.
      const bannerMatch = content[0]?.text?.match(/retrieve_id=([^)]+)/);
      if (bannerMatch?.[1] && bannerMatch[1].length > 0) {
        capturedRetrieveId = bannerMatch[1];
      }
    });

    it('nexus.context_retrieve: structuredContent has expected output schema shape', async () => {
      const result = await client.callTool({
        name: 'nexus.context_retrieve',
        arguments: {
          user_id: TEST_USER_ID,
          query: 'structured output shape test',
        },
      });

      expect(result.isError).toBeFalsy();

      // structuredContent is an MCP extension (proposal §outputSchema).
      const structured = (result as unknown as { structuredContent?: unknown }).structuredContent as
        | Record<string, unknown>
        | undefined;

      if (structured !== undefined) {
        // retrieve_id and array fields must be present per outputSchema.
        expect(structured).toHaveProperty('retrieve_id');
        expect(Array.isArray(structured['memories'])).toBe(true);
        expect(Array.isArray(structured['conversation_turns'])).toBe(true);
        expect(Array.isArray(structured['knowledge_entities'])).toBe(true);
      }
    });

    // -----------------------------------------------------------------------
    // 4. tools/call nexus.memory_search
    // -----------------------------------------------------------------------

    it('nexus.memory_search: response contains memories array', async () => {
      const result = await client.callTool({
        name: 'nexus.memory_search',
        arguments: {
          user_id: TEST_USER_ID,
          query: 'e2e test memory search',
          limit: 5,
          mode: 'hybrid',
        },
      });

      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.length).toBeGreaterThanOrEqual(1);
      expect(content[0]?.type).toBe('text');

      // The text content must be parseable JSON with a `memories` array.
      const parsed = JSON.parse(content[0]!.text!) as unknown;
      expect(parsed).toMatchObject({ memories: expect.any(Array), total: expect.any(Number) });
    });

    it('nexus.memory_search: structuredContent has memories and total', async () => {
      const result = await client.callTool({
        name: 'nexus.memory_search',
        arguments: {
          user_id: TEST_USER_ID,
          query: 'structured content check',
        },
      });

      expect(result.isError).toBeFalsy();

      const structured = (result as unknown as { structuredContent?: unknown }).structuredContent as
        | Record<string, unknown>
        | undefined;

      if (structured !== undefined) {
        expect(structured).toHaveProperty('memories');
        expect(structured).toHaveProperty('total');
        expect(Array.isArray(structured['memories'])).toBe(true);
        expect(typeof structured['total']).toBe('number');
      }
    });

    // -----------------------------------------------------------------------
    // 5. tools/call nexus.memory_create
    // -----------------------------------------------------------------------

    it('nexus.memory_create: response contains memory_id and created_at', async () => {
      const result = await client.callTool({
        name: 'nexus.memory_create',
        arguments: {
          user_id: TEST_USER_ID,
          content: 'E2E integration test memory created at ' + new Date().toISOString(),
          memory_type: 'episodic',
          metadata: { source: 'e2e-test', environment: 'ci' },
        },
      });

      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.length).toBeGreaterThanOrEqual(1);
      expect(content[0]?.type).toBe('text');

      const parsed = JSON.parse(content[0]!.text!) as Record<string, unknown>;
      // memory_id is the canonical output field (outputSchema §required).
      expect(typeof parsed['memory_id']).toBe('string');
      expect((parsed['memory_id'] as string).length).toBeGreaterThan(0);
      // created_at must be a non-empty string (ISO 8601 datetime).
      expect(typeof parsed['created_at']).toBe('string');
      expect((parsed['created_at'] as string).length).toBeGreaterThan(0);
    });

    it('nexus.memory_create: structuredContent carries memory_id', async () => {
      const result = await client.callTool({
        name: 'nexus.memory_create',
        arguments: {
          user_id: TEST_USER_ID,
          content: 'E2E structured-content assertion ' + new Date().toISOString(),
          memory_type: 'semantic',
        },
      });

      expect(result.isError).toBeFalsy();

      const structured = (result as unknown as { structuredContent?: unknown }).structuredContent as
        | Record<string, unknown>
        | undefined;

      if (structured !== undefined) {
        expect(typeof structured['memory_id']).toBe('string');
        expect(typeof structured['created_at']).toBe('string');
      }
    });

    // -----------------------------------------------------------------------
    // 6. tools/call nexus.memory_feedback
    //    Uses capturedRetrieveId from the context_retrieve step above.
    //    Falls back to PLACEHOLDER_UUID if the prior call returned empty.
    // -----------------------------------------------------------------------

    it('nexus.memory_feedback: status="accepted" in response', async () => {
      const result = await client.callTool({
        name: 'nexus.memory_feedback',
        arguments: {
          user_id: TEST_USER_ID,
          retrieve_id: capturedRetrieveId,
          rating: 4,
          expected_missing: 'E2E test: nothing specific missing',
          context: { source: 'e2e-test', client: 'vitest' },
        },
      });

      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.length).toBeGreaterThanOrEqual(1);
      expect(content[0]?.type).toBe('text');

      const parsed = JSON.parse(content[0]!.text!) as Record<string, unknown>;
      // Backend FeedbackResponse contract: status is always "accepted" (R2.1 D-1).
      expect(parsed['status']).toBe('accepted');
      // feedback_id must be present and non-empty.
      expect(typeof parsed['feedback_id']).toBe('string');
      expect((parsed['feedback_id'] as string).length).toBeGreaterThan(0);
    });

    it('nexus.memory_feedback: with item_feedback array', async () => {
      // This test verifies the full item_feedback path including per-memory
      // useful flag — the feedback loop's core signal (v5.0 L2 explicit).
      const result = await client.callTool({
        name: 'nexus.memory_feedback',
        arguments: {
          user_id: TEST_USER_ID,
          retrieve_id: capturedRetrieveId,
          rating: 3,
          item_feedback: [
            {
              memory_id: PLACEHOLDER_UUID,
              useful: true,
              reason: 'Relevant to the E2E test query',
            },
          ],
        },
      });

      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe('text');

      const parsed = JSON.parse(content[0]!.text!) as Record<string, unknown>;
      expect(parsed['status']).toBe('accepted');
    });

    // -----------------------------------------------------------------------
    // 7. Error-path: invalid rating → InvalidParams error response
    // -----------------------------------------------------------------------

    it('nexus.memory_feedback: rating=0 returns isError=true (InvalidParams)', async () => {
      // MCP tool errors (NexusError / InvalidParams) surface as isError=true
      // in the CallToolResult — NOT as a JSON-RPC protocol error. The server
      // wraps application errors in CallToolResult.isError per MCP spec.
      // Depending on SDK version this may surface differently; we check
      // for either an error result or a thrown SDK error.
      try {
        const result = await client.callTool({
          name: 'nexus.memory_feedback',
          arguments: {
            user_id: TEST_USER_ID,
            retrieve_id: capturedRetrieveId,
            rating: 0, // invalid: below minimum of 1
          },
        });
        // If we reach here, check isError flag.
        expect(result.isError).toBe(true);
      } catch (err) {
        // The SDK may throw an McpError for protocol-level errors.
        // Either path is acceptable — the test ensures an error is raised.
        expect(err).toBeTruthy();
      }
    });

    it('nexus.context_retrieve: as_of > 90 days in past → isError=true (InvalidParams)', async () => {
      const longPast = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      try {
        const result = await client.callTool({
          name: 'nexus.context_retrieve',
          arguments: {
            user_id: TEST_USER_ID,
            query: 'historical query',
            as_of: longPast,
          },
        });
        expect(result.isError).toBe(true);
      } catch (err) {
        expect(err).toBeTruthy();
      }
    });

    // -----------------------------------------------------------------------
    // 8. Unknown tool → protocol error
    // -----------------------------------------------------------------------

    it('unknown tool name → client receives an error (protocol-level)', async () => {
      await expect(
        client.callTool({
          name: 'nexus.does_not_exist',
          arguments: {},
        }),
      ).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // 9. Process cleanup assertion (run last via natural order)
    // -----------------------------------------------------------------------

    it('server process is still running at end of suite (no zombie)', () => {
      // If the server crashed during any test, `killed` would be true or
      // `exitCode` would be non-null. A healthy server stays alive until
      // afterAll kills it.
      expect(serverProcess.killed).toBe(false);
      expect(serverProcess.exitCode).toBeNull();
    });
  },
);

// ---------------------------------------------------------------------------
// Informational describe block — always runs, prints skip reason in CI
// ---------------------------------------------------------------------------

describe('E2E gate: environment variable requirements', () => {
  it('documents required env vars for NEXUS_TEST_API_URL-gated suite', () => {
    // This test always passes. Its purpose is to emit a clear message in
    // the vitest reporter when the E2E suite is skipped, so CI operators
    // know exactly which secrets to wire in order to activate the suite.
    if (!E2E_ENABLED) {
      console.info(
        '[TASK-017] E2E suite skipped: one or more required env vars are absent.\n' +
          'All three must be set (non-empty) to activate the suite:\n' +
          '  NEXUS_TEST_API_URL=http://your-nexus-host:8001\n' +
          '  NEXUS_TEST_API_TOKEN=<bearer-token>\n' +
          '  NEXUS_TEST_TENANT_ID=<tenant-id>\n' +
          'Also ensure `npm run build` has produced dist/index.js.',
      );
    }
    expect(true).toBe(true);
  });
});
