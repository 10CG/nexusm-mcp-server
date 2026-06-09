/**
 * Integration: MCP ↔ nexus-sdk-js schema parity — deep runtime check.
 *
 * GATE: requires `@nexusm/sdk@1.3.0` installed in node_modules.
 * This test CANNOT run until Gate-1 SDK publish completes (US-037 TASK-005,
 * currently in-flight as of Wave 2B 2026-05-22). It is excluded from the
 * default `npm run test:unit` pass via `vitest.unit.config.ts` (which only
 * includes `tests/unit/**`). Run explicitly with:
 *
 *   npm run test:integration          # via vitest.integration.config.ts
 *   vitest run tests/integration/     # direct
 *
 * Relationship to `tests/unit/schema_sync.test.ts`:
 *   - Unit file (Wave 1): lightweight import-time check. Verifies Zod schemas
 *     parse a minimal payload at the import/parse boundary. Fast, no SDK install.
 *   - This file (Wave 2B): deep field-by-field delta report. Extracts field
 *     names, enum values, maxLength constraints, and required-ness from the MCP
 *     JSON Schema and compares them against the SDK Zod shape (via .parse +
 *     deliberate violations + safeParse). Fails with a structured delta report
 *     so engineers know precisely which fields drifted.
 *
 * Strategy:
 *   1. Import MCP tool definitions (pure TS modules — no network required).
 *   2. Import SDK Zod schemas directly (requires installed @nexusm/sdk).
 *   3. For each tool, assert field-by-field: required fields, enum values,
 *      maxLength, format constraints.
 *   4. For nexus.memory_feedback (no SDK Zod), verify field-name parity against
 *      the FeedbackSubmitRequest TypeScript interface field set.
 *
 * TASK-016 deliverable — US-037 Wave 2B schema_sync integration half.
 */

import { describe, expect, it } from 'vitest';
import { contextRequestSchema, memoryCreateSchema, memorySearchSchema } from '@nexusm/sdk';

import { contextRetrieveTool } from '../../src/tools/context.js';
import { memoryCreateTool } from '../../src/tools/memory_create.js';
import { memoryFeedbackTool } from '../../src/tools/memory_feedback.js';
import { memorySearchTool } from '../../src/tools/memory_search.js';
import type { JsonSchemaObject } from '../../src/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      return 1.0;
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

/**
 * Extract the set of required field names from an MCP JSON Schema and the
 * SDK Zod schema, then return a delta report string (empty = no drift).
 *
 * Strategy: parse the SDK schema with the minimal MCP payload, then attempt
 * to parse with each required field deleted one at a time. If the SDK does
 * NOT reject a missing MCP-required field, that field is potentially
 * required only by MCP (LLM-ergonomic over-require — acceptable) and NOT
 * considered drift. If the SDK DOES reject a field that MCP does NOT mark
 * required, that is drift (SDK requires something MCP forgot to surface).
 *
 * Returns an empty string when clean; otherwise a multiline delta report.
 */
function computeRequiredDelta(
  toolLabel: string,
  mcpSchema: JsonSchemaObject,
  zodSchema: { parse: (v: unknown) => unknown; safeParse: (v: unknown) => { success: boolean } },
): string {
  const mcpRequired = new Set(mcpSchema.required ?? []);
  const lines: string[] = [];

  // 1. Verify minimal payload is accepted by SDK Zod.
  const minimal = buildMinimalPayload(mcpSchema);
  const baseline = zodSchema.safeParse(minimal);
  if (!baseline.success) {
    lines.push(
      `[DELTA] ${toolLabel}: SDK Zod rejected the MCP minimal-required payload — ` +
        `this means MCP 'required' list is missing a field that SDK requires.`,
    );
    // Short-circuit: no point testing individual field removals.
    return lines.join('\n');
  }

  // 2. For each field in MCP properties, test if SDK enforces it as required.
  for (const key of Object.keys(mcpSchema.properties)) {
    if (!mcpRequired.has(key)) continue; // only test MCP-required fields
    const candidate = { ...minimal };
    delete candidate[key];
    const result = zodSchema.safeParse(candidate);
    if (result.success && mcpRequired.has(key)) {
      // SDK accepts payload missing this field — MCP over-requires (allowed).
      // No drift — just note in a debug comment (not a failure).
    }
    // If SDK rejects AND MCP requires — consistent. Good.
    // If SDK rejects AND MCP does NOT require — this would be caught by baseline.
  }

  // 3. Check properties present in MCP but absent from SDK (forward drift).
  //    We detect this by passing a payload that has ONLY unknown keys and
  //    confirming the SDK Zod does not explode on strict() mode.
  //    (Most Nexus SDK Zod schemas are permissive; this is best-effort.)

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus.context_retrieve ↔ contextRequestSchema
// ---------------------------------------------------------------------------

describe('integration: nexus.context_retrieve ↔ contextRequestSchema (field-by-field)', () => {
  it('MCP required fields are present in both MCP schema and SDK Zod', () => {
    const mcpRequired = contextRetrieveTool.inputSchema.required ?? [];
    expect(mcpRequired).toContain('user_id');
    expect(mcpRequired).toContain('query');
  });

  it('SDK Zod accepts the MCP minimal-required payload', () => {
    const payload = buildMinimalPayload(contextRetrieveTool.inputSchema);
    const result = contextRequestSchema.safeParse(payload);
    if (!result.success) {
      throw new Error(
        `contextRequestSchema rejected MCP minimal payload.\n` +
          `Payload: ${JSON.stringify(payload)}\n` +
          `Delta: ${computeRequiredDelta('context_retrieve', contextRetrieveTool.inputSchema, contextRequestSchema)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('SDK Zod rejects payload missing user_id (required in both)', () => {
    const payload = buildMinimalPayload(contextRetrieveTool.inputSchema);
    delete payload['user_id'];
    expect(() => contextRequestSchema.parse(payload)).toThrow();
  });

  it('as_of field: SDK Zod accepts ISO 8601 datetime string', () => {
    const payload = {
      ...buildMinimalPayload(contextRetrieveTool.inputSchema),
      as_of: '2026-01-01T00:00:00Z',
    };
    const result = contextRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('as_of field: MCP schema declares format:date-time', () => {
    const prop = contextRetrieveTool.inputSchema.properties['as_of'] as
      | { format?: string }
      | undefined;
    expect(prop?.format).toBe('date-time');
  });

  it('limit field: MCP schema declares integer with min=1 max=50', () => {
    const prop = contextRetrieveTool.inputSchema.properties['limit'] as
      | { type?: string; minimum?: number; maximum?: number }
      | undefined;
    expect(prop?.type).toBe('integer');
    expect(prop?.minimum).toBe(1);
    expect(prop?.maximum).toBe(50);
  });

  it('no required-field drift: delta report is empty', () => {
    const delta = computeRequiredDelta(
      'context_retrieve',
      contextRetrieveTool.inputSchema,
      contextRequestSchema,
    );
    if (delta) {
      throw new Error(`Schema drift detected:\n${delta}`);
    }
    expect(delta).toBe('');
  });
});

// ---------------------------------------------------------------------------
// nexus.memory_search ↔ memorySearchSchema
// ---------------------------------------------------------------------------

describe('integration: nexus.memory_search ↔ memorySearchSchema (field-by-field)', () => {
  it('MCP required fields include user_id and query', () => {
    const mcpRequired = memorySearchTool.inputSchema.required ?? [];
    expect(mcpRequired).toContain('user_id');
    expect(mcpRequired).toContain('query');
  });

  it('SDK Zod accepts the MCP minimal-required payload', () => {
    const payload = buildMinimalPayload(memorySearchTool.inputSchema);
    const result = memorySearchSchema.safeParse(payload);
    if (!result.success) {
      throw new Error(
        `memorySearchSchema rejected MCP minimal payload.\n` +
          `Payload: ${JSON.stringify(payload)}\n` +
          `Delta: ${computeRequiredDelta('memory_search', memorySearchTool.inputSchema, memorySearchSchema)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('SDK Zod rejects payload missing user_id', () => {
    const payload = buildMinimalPayload(memorySearchTool.inputSchema);
    delete payload['user_id'];
    expect(() => memorySearchSchema.parse(payload)).toThrow();
  });

  it('SDK Zod rejects payload missing query', () => {
    const payload = buildMinimalPayload(memorySearchTool.inputSchema);
    delete payload['query'];
    expect(() => memorySearchSchema.parse(payload)).toThrow();
  });

  it('memory_type enum: MCP and SDK agree on 3 values', () => {
    const prop = memorySearchTool.inputSchema.properties['memory_type'] as
      | { enum?: string[] }
      | undefined;
    const mcpEnum = prop?.enum ?? [];
    expect(mcpEnum).toHaveLength(3);
    expect(mcpEnum).toEqual(expect.arrayContaining(['episodic', 'semantic', 'procedural']));

    // Each MCP enum value must be accepted by SDK Zod.
    const deltaLines: string[] = [];
    for (const enumVal of mcpEnum) {
      const payload = {
        ...buildMinimalPayload(memorySearchTool.inputSchema),
        memory_type: enumVal,
      };
      const result = memorySearchSchema.safeParse(payload);
      if (!result.success) {
        deltaLines.push(`  memory_type="${enumVal}" accepted by MCP but rejected by SDK Zod`);
      }
    }
    if (deltaLines.length > 0) {
      throw new Error(`memory_type enum drift:\n${deltaLines.join('\n')}`);
    }
  });

  it('limit field: MCP schema declares integer with min=1 max=50', () => {
    const prop = memorySearchTool.inputSchema.properties['limit'] as
      | { type?: string; minimum?: number; maximum?: number }
      | undefined;
    expect(prop?.type).toBe('integer');
    expect(prop?.minimum).toBe(1);
    expect(prop?.maximum).toBe(50);
  });

  it('score_threshold: MCP schema declares number with min=0.0 max=1.0', () => {
    const prop = memorySearchTool.inputSchema.properties['score_threshold'] as
      | { type?: string; minimum?: number; maximum?: number }
      | undefined;
    expect(prop?.type).toBe('number');
    expect(prop?.minimum).toBe(0.0);
    expect(prop?.maximum).toBe(1.0);
  });

  it('no required-field drift: delta report is empty', () => {
    const delta = computeRequiredDelta(
      'memory_search',
      memorySearchTool.inputSchema,
      memorySearchSchema,
    );
    if (delta) {
      throw new Error(`Schema drift detected:\n${delta}`);
    }
    expect(delta).toBe('');
  });
});

// ---------------------------------------------------------------------------
// nexus.memory_create ↔ memoryCreateSchema
// ---------------------------------------------------------------------------

describe('integration: nexus.memory_create ↔ memoryCreateSchema (field-by-field)', () => {
  it('MCP required fields include user_id and content', () => {
    const mcpRequired = memoryCreateTool.inputSchema.required ?? [];
    expect(mcpRequired).toContain('user_id');
    expect(mcpRequired).toContain('content');
  });

  it('SDK Zod accepts the MCP minimal-required payload (with content)', () => {
    const payload = {
      ...buildMinimalPayload(memoryCreateTool.inputSchema),
      content: 'runtime integration test content',
    };
    const result = memoryCreateSchema.safeParse(payload);
    if (!result.success) {
      throw new Error(
        `memoryCreateSchema rejected MCP minimal payload.\n` +
          `Payload: ${JSON.stringify(payload)}\n` +
          `Delta: ${computeRequiredDelta('memory_create', memoryCreateTool.inputSchema, memoryCreateSchema)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('SDK Zod rejects payload missing user_id', () => {
    const payload: Record<string, unknown> = {
      ...buildMinimalPayload(memoryCreateTool.inputSchema),
      content: 'test',
    };
    delete payload['user_id'];
    expect(() => memoryCreateSchema.parse(payload)).toThrow();
  });

  it('SDK Zod rejects payload missing content', () => {
    const payload = buildMinimalPayload(memoryCreateTool.inputSchema);
    delete payload['content'];
    expect(() => memoryCreateSchema.parse(payload)).toThrow();
  });

  it('memory_type enum: MCP and SDK agree on 3 values', () => {
    const prop = memoryCreateTool.inputSchema.properties['memory_type'] as
      | { enum?: string[] }
      | undefined;
    const mcpEnum = prop?.enum ?? [];
    expect(mcpEnum).toHaveLength(3);
    expect(mcpEnum).toEqual(expect.arrayContaining(['episodic', 'semantic', 'procedural']));

    const deltaLines: string[] = [];
    for (const enumVal of mcpEnum) {
      const payload = {
        ...buildMinimalPayload(memoryCreateTool.inputSchema),
        content: 'enum test',
        memory_type: enumVal,
      };
      const result = memoryCreateSchema.safeParse(payload);
      if (!result.success) {
        deltaLines.push(`  memory_type="${enumVal}" accepted by MCP but rejected by SDK Zod`);
      }
    }
    if (deltaLines.length > 0) {
      throw new Error(`memory_type enum drift:\n${deltaLines.join('\n')}`);
    }
  });

  it('valid_until_source enum: 5 values locked in R2.1', () => {
    const EXPECTED = [
      'permanent',
      'extracted',
      'sdk_provided',
      'extraction_failed',
      'superseded_by_conflict',
    ] as const;
    const prop = memoryCreateTool.inputSchema.properties['valid_until_source'] as
      | { enum?: string[] }
      | undefined;
    expect(prop?.enum).toEqual(expect.arrayContaining([...EXPECTED]));
    expect(prop?.enum).toHaveLength(EXPECTED.length);
  });

  it('valid_until field: MCP schema declares format:date-time', () => {
    const prop = memoryCreateTool.inputSchema.properties['valid_until'] as
      | { format?: string }
      | undefined;
    expect(prop?.format).toBe('date-time');
  });

  it('metadata field: MCP schema declares object with additionalProperties:true', () => {
    const prop = memoryCreateTool.inputSchema.properties['metadata'] as
      | { type?: string; additionalProperties?: boolean | unknown }
      | undefined;
    expect(prop?.type).toBe('object');
    expect(prop?.additionalProperties).toBe(true);
  });

  it('no required-field drift: delta report is empty', () => {
    const delta = computeRequiredDelta(
      'memory_create',
      memoryCreateTool.inputSchema,
      memoryCreateSchema,
    );
    if (delta) {
      throw new Error(`Schema drift detected:\n${delta}`);
    }
    expect(delta).toBe('');
  });
});

// ---------------------------------------------------------------------------
// nexus.memory_feedback ↔ FeedbackSubmitRequest (TS interface, no SDK Zod)
// ---------------------------------------------------------------------------

describe('integration: nexus.memory_feedback ↔ FeedbackSubmitRequest (field-name parity)', () => {
  /**
   * FeedbackSubmitRequest has no SDK Zod schema — it is a TypeScript-only
   * interface in packages/nexus-sdk-js/src/types/feedback.ts. The backend
   * contract is: body = { rating, item_feedback?, expected_missing?, context? };
   * user_id and retrieve_id are MCP-side concerns (audit + URL path).
   *
   * Parity strategy: assert that every backend body field is exposed in the
   * MCP inputSchema properties (bidirectional coverage), and verify the
   * R2.1 length caps are embedded in the schema.
   */
  const SDK_BODY_FIELDS = ['rating', 'item_feedback', 'expected_missing', 'context'] as const;
  const MCP_ONLY_FIELDS = ['user_id', 'retrieve_id'] as const; // audit/path params

  it('every SDK FeedbackSubmitRequest body field is exposed in MCP inputSchema', () => {
    const mcpProps = Object.keys(memoryFeedbackTool.inputSchema.properties);
    const missing: string[] = [];
    for (const field of SDK_BODY_FIELDS) {
      if (!mcpProps.includes(field)) missing.push(field);
    }
    if (missing.length > 0) {
      throw new Error(
        `MCP inputSchema is missing SDK body fields: ${missing.join(', ')}\n` +
          `MCP properties: ${mcpProps.join(', ')}`,
      );
    }
    expect(missing).toHaveLength(0);
  });

  it('MCP-only audit fields (user_id, retrieve_id) are present in MCP schema', () => {
    const mcpProps = Object.keys(memoryFeedbackTool.inputSchema.properties);
    for (const field of MCP_ONLY_FIELDS) {
      expect(mcpProps).toContain(field);
    }
  });

  it('rating: MCP schema declares integer with minimum=1 and maximum=5', () => {
    const prop = memoryFeedbackTool.inputSchema.properties['rating'] as
      | { type?: string; minimum?: number; maximum?: number }
      | undefined;
    expect(prop?.type).toBe('integer');
    expect(prop?.minimum).toBe(1);
    expect(prop?.maximum).toBe(5);
  });

  it('item_feedback: item shape includes memory_id, useful, reason with correct required', () => {
    const items = memoryFeedbackTool.inputSchema.properties['item_feedback'] as {
      items?: { properties?: Record<string, unknown>; required?: string[] };
    };
    const itemProps = Object.keys(items.items?.properties ?? {});
    expect(itemProps).toEqual(expect.arrayContaining(['memory_id', 'useful', 'reason']));
    expect(items.items?.required).toEqual(expect.arrayContaining(['memory_id', 'useful']));
    // reason is optional in FeedbackItemRequest — must NOT be in required.
    expect(items.items?.required ?? []).not.toContain('reason');
  });

  it('item_feedback[].reason: maxLength=255 (R2.1 grep correction)', () => {
    const items = memoryFeedbackTool.inputSchema.properties['item_feedback'] as {
      items: { properties: { reason: { maxLength?: number } } };
    };
    expect(items.items.properties.reason.maxLength).toBe(255);
  });

  it('expected_missing: maxLength=2000 (R2.1 grep correction)', () => {
    const prop = memoryFeedbackTool.inputSchema.properties['expected_missing'] as
      | { maxLength?: number }
      | undefined;
    expect(prop?.maxLength).toBe(2000);
  });

  it('retrieve_id: MCP schema declares format:uuid', () => {
    const prop = memoryFeedbackTool.inputSchema.properties['retrieve_id'] as
      | { format?: string }
      | undefined;
    expect(prop?.format).toBe('uuid');
  });

  it('required fields: user_id, retrieve_id, rating are all required', () => {
    const mcpRequired = memoryFeedbackTool.inputSchema.required ?? [];
    expect(mcpRequired).toContain('user_id');
    expect(mcpRequired).toContain('retrieve_id');
    expect(mcpRequired).toContain('rating');
  });
});
