/**
 * Vitest config for the unit-only test pass (Wave 2 mid_audit qa-engineer
 * I-4 + C-1 amendments, 2026-05-22).
 *
 * The default `npm test` script (`vitest run`) picks up every `*.test.ts`
 * file, including `tests/unit/schema_sync.test.ts` which imports
 * `@nexusm/sdk` Zod schemas at runtime. That import fails until Gate-1
 * publishes `@nexusm/sdk@1.3.0` to npm — which would mean all 34+
 * mocked unit tests are blocked by an unrelated install failure.
 *
 * This config excludes `schema_sync.test.ts` so the CI `test:unit` step
 * can run the vi.mock-isolated tests without an SDK install requirement.
 * Once Gate-1 completes (or in Wave 2B TASK-016 hardening), the full
 * `npm test` will run schema_sync too.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/unit/schema_sync.test.ts', 'node_modules/**', 'dist/**'],
  },
});
