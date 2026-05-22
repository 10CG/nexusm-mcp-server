/**
 * Vitest config for the integration test pass (TASK-016 + TASK-017, Wave 2B).
 *
 * Runs ALL integration tests under `tests/integration/`:
 *   - schema_sync.test.ts  (TASK-016): MCP ↔ nexus-sdk-js schema parity
 *   - mcp_protocol.test.ts (TASK-017): E2E MCP protocol round-trip
 *
 * Both tests carry their own `describe.skipIf(...)` guards. This config
 * simply wires the correct include glob so `npm run test:integration` hits
 * both files without pulling in the vi.mock-isolated unit tests.
 *
 * Gate note: `test:integration` requires:
 *   1. @nexusm/sdk@1.3.0 installed in node_modules (Gate-1 SDK publish)
 *   2. `npm run build` to have produced dist/index.js (mcp_protocol.test.ts)
 *   3. A reachable Nexus API at NEXUS_TEST_API_URL (mcp_protocol.test.ts)
 *
 * Exclude the unit directory explicitly to prevent double-running tests
 * when someone invokes `vitest run` without a config flag.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/unit/**', 'node_modules/**', 'dist/**'],
    // Integration tests spawn subprocesses and make real network calls.
    // Give each test file a generous per-test timeout.
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
