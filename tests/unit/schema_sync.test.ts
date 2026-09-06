/**
 * MCP ↔ nexus-sdk-js schema parity check.
 *
 * Purpose (proposal §"R2 工具 Schema 锁定" + C-2 testing note):
 *   Catch backend / SDK schema drift early. If nexus-sdk-js's Zod schemas
 *   evolve (rename a field, change required-ness, change a type) the MCP
 *   tool input schemas must be reconciled in the same PR. CI fails here.
 *
 * Strategy:
 *   For each MCP tool whose backend has a Zod request schema in
 *   `@nexus/sdk`, build the smallest valid payload from the MCP schema's
 *   `required` list and assert the SDK Zod schema accepts it. Conversely
 *   we send a payload missing each MCP-required field and assert the SDK
 *   Zod rejects it (only for fields the SDK also marks required, since MCP
 *   may over-require for LLM ergonomics — e.g., MCP requires `query` even
 *   though SDK ContextRequest accepts query-less calls).
 *
 *   nexus.memory_feedback has no Zod schema (only TS interface) — its
 *   parity check covers field-name overlap against FeedbackSubmitRequest.
 *
 * Coverage boundary 1 (worth knowing before trusting this file): every check
 * here compares `inputSchema` against an SDK **request** schema. Tool
 * `outputSchema` has no comparand at all — the SDK response types are
 * TypeScript-only, so nothing runtime-introspectable exists to diff them
 * against. That gap is why nexus#400 (memory_create labelling the row PK as
 * `memory_id`) stayed green here.
 *
 * Coverage boundary 2, easier to miss: NONE of the `expect()` calls in this
 * file run in CI. `vitest.unit.config.ts` excludes this file from `test:unit`
 * (it imports the real SDK Zod schemas at runtime), and no workflow step runs
 * a bare `vitest run` — so every assertion here is developer-invoked only
 * (`npx vitest run tests/unit/schema_sync.test.ts`). What IS CI-enforced is
 * compilation: `npm run type-check` compiles tests/ via
 * tsconfig.typecheck.json, so a TYPE-level tie to an SDK type is a live lock
 * even though the assertion around it never executes. That is exactly what
 * the nexus#400 block at the bottom is, and all it is.
 *
 * Corollary: anything that needs a RUNTIME gate belongs in
 * tests/unit/tools/*.test.ts, which `test:unit` does run. The nexus#400
 * outputSchema `format` / `required` assertions live there
 * (tests/unit/tools/memory_create.test.ts) for that reason.
 */

import { describe, expect, it } from 'vitest';
import { contextRequestSchema, memoryCreateSchema, memorySearchSchema } from '@nexusm/sdk';
import type { Memory } from '@nexusm/sdk';

import { contextRetrieveTool } from '../../src/tools/context.js';
import { memoryCreateTool } from '../../src/tools/memory_create.js';
import { memoryFeedbackTool } from '../../src/tools/memory_feedback.js';
import { memorySearchTool } from '../../src/tools/memory_search.js';
import type { JsonSchemaObject } from '../../src/tools/types.js';

/** Build a minimal valid payload satisfying every MCP `required` field. */
function buildMinimalPayload(schema: JsonSchemaObject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const prop = schema.properties[key] as { type?: string } | undefined;
    out[key] = sampleValueFor(prop?.type ?? 'string', key);
  }
  return out;
}

function sampleValueFor(type: string, fieldName: string): unknown {
  if (fieldName.endsWith('_id') || fieldName === 'retrieve_id') {
    return '00000000-0000-0000-0000-000000000001';
  }
  switch (type) {
    case 'string':
      return 'sample';
    case 'integer':
      return 1;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'sample';
  }
}

describe('nexus.context_retrieve ↔ contextRequestSchema', () => {
  it('SDK Zod accepts the MCP minimal-required payload', () => {
    const payload = buildMinimalPayload(contextRetrieveTool.inputSchema);
    expect(() => contextRequestSchema.parse(payload)).not.toThrow();
  });

  it('user_id is required by both MCP and SDK', () => {
    expect(contextRetrieveTool.inputSchema.required).toContain('user_id');
    const payload = buildMinimalPayload(contextRetrieveTool.inputSchema);
    delete payload.user_id;
    expect(() => contextRequestSchema.parse(payload)).toThrow();
  });

  it('as_of (added in SDK v1.3.0) round-trips when supplied', () => {
    const payload = {
      ...buildMinimalPayload(contextRetrieveTool.inputSchema),
      as_of: '2026-01-01T00:00:00Z',
    };
    expect(() => contextRequestSchema.parse(payload)).not.toThrow();
  });
});

describe('nexus.memory_search ↔ memorySearchSchema', () => {
  it('SDK Zod accepts the MCP minimal-required payload', () => {
    const payload = buildMinimalPayload(memorySearchTool.inputSchema);
    expect(() => memorySearchSchema.parse(payload)).not.toThrow();
  });

  it('user_id and query are required by both MCP and SDK', () => {
    expect(memorySearchTool.inputSchema.required).toEqual(
      expect.arrayContaining(['user_id', 'query']),
    );
    for (const field of ['user_id', 'query']) {
      const payload = buildMinimalPayload(memorySearchTool.inputSchema);
      delete payload[field];
      expect(() => memorySearchSchema.parse(payload)).toThrow();
    }
  });

  it('memory_type enum matches SDK ("episodic" | "semantic" | "procedural")', () => {
    const prop = memorySearchTool.inputSchema.properties.memory_type as { enum?: string[] };
    expect(prop.enum).toEqual(['episodic', 'semantic', 'procedural']);
    for (const t of prop.enum ?? []) {
      const payload = { ...buildMinimalPayload(memorySearchTool.inputSchema), memory_type: t };
      expect(() => memorySearchSchema.parse(payload)).not.toThrow();
    }
  });
});

describe('nexus.memory_create ↔ memoryCreateSchema', () => {
  it('SDK Zod accepts the MCP minimal-required payload', () => {
    const payload = {
      ...buildMinimalPayload(memoryCreateTool.inputSchema),
      content: 'sample content',
    };
    expect(() => memoryCreateSchema.parse(payload)).not.toThrow();
  });

  it('user_id and content are required by both MCP and SDK', () => {
    expect(memoryCreateTool.inputSchema.required).toEqual(
      expect.arrayContaining(['user_id', 'content']),
    );
    for (const field of ['user_id', 'content']) {
      const payload: Record<string, unknown> = {
        ...buildMinimalPayload(memoryCreateTool.inputSchema),
        content: 'sample content',
      };
      delete payload[field];
      expect(() => memoryCreateSchema.parse(payload)).toThrow();
    }
  });

  it('memory_type enum matches SDK ("episodic" | "semantic" | "procedural")', () => {
    const prop = memoryCreateTool.inputSchema.properties.memory_type as { enum?: string[] };
    expect(prop.enum).toEqual(['episodic', 'semantic', 'procedural']);
  });
});

describe('nexus.memory_feedback ↔ FeedbackSubmitRequest (no SDK Zod, field-name parity)', () => {
  // FeedbackSubmitRequest is TS-only (see packages/nexus-sdk-js/src/types/feedback.ts).
  // The backend FeedbackRequest body is { rating, item_feedback?, expected_missing?, context? };
  // user_id and retrieve_id are MCP-side concerns (audit + URL path).
  const SDK_BODY_FIELDS = new Set(['rating', 'item_feedback', 'expected_missing', 'context']);

  it('every SDK FeedbackSubmitRequest body field is exposed in the MCP inputSchema', () => {
    const mcpProps = Object.keys(memoryFeedbackTool.inputSchema.properties);
    for (const field of SDK_BODY_FIELDS) {
      expect(mcpProps).toContain(field);
    }
  });

  it('item_feedback item shape matches FeedbackItemRequest (memory_id, useful, reason?)', () => {
    const items = memoryFeedbackTool.inputSchema.properties.item_feedback as {
      items?: { properties?: Record<string, unknown>; required?: string[] };
    };
    expect(items.items?.properties).toBeDefined();
    expect(Object.keys(items.items?.properties ?? {})).toEqual(
      expect.arrayContaining(['memory_id', 'useful', 'reason']),
    );
    expect(items.items?.required).toEqual(expect.arrayContaining(['memory_id', 'useful']));
  });

  it('reason maxLength = 255 and expected_missing maxLength = 2000 (R2.1 grep correction)', () => {
    const itemProps = (
      memoryFeedbackTool.inputSchema.properties.item_feedback as {
        items: { properties: { reason: { maxLength: number } } };
      }
    ).items.properties;
    expect(itemProps.reason.maxLength).toBe(255);

    const expectedMissing = memoryFeedbackTool.inputSchema.properties.expected_missing as {
      maxLength: number;
    };
    expect(expectedMissing.maxLength).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// nexus.memory_create outputSchema ↔ SDK Memory id fields (nexus#400)
// ---------------------------------------------------------------------------

describe('nexus.memory_create outputSchema ↔ SDK Memory id fields (nexus#400)', () => {
  it('SDK Memory still declares both id spaces (compile-time lock)', () => {
    // The lock is the TYPE ANNOTATION, not the expect() below it. If the SDK
    // renames or drops either field, these two indexed accesses stop
    // resolving and `npm run type-check` — a real CI step — fails. The
    // expect() calls do NOT run in CI (see "Coverage boundary 2" at the top of
    // this file); they are here only so the assignments have a use and the
    // body is a valid test. Runtime introspection is impossible anyway:
    // Memory is an interface and is erased.
    const compound: Memory['memory_id'] = 'tenant::user::00000000-0000-0000-0000-000000000001';
    const pk: Memory['id'] = '00000000-0000-0000-0000-000000000001';

    expect(typeof compound).toBe('string');
    expect(typeof pk).toBe('string');
  });

  // The outputSchema `format` / `required` assertions that used to sit here
  // were runtime-only, i.e. never executed by any CI step, while identical
  // assertions already run under `test:unit` in
  // tests/unit/tools/memory_create.test.ts. They were removed rather than
  // kept as an unexecuted duplicate.
});
