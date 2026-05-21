/**
 * Shared types for MCP tool definitions.
 *
 * Each tool exports a {@link ToolDefinition} carrying:
 *  - JSON Schema input/output (locked in proposal §"R2 工具 Schema 锁定" + R2.1)
 *  - Async handler that returns an MCP {@link CallToolResult}
 *
 * In Wave 1 TASK-003 every handler returns NOT_IMPLEMENTED. Subsequent tasks
 * (TASK-007..010) wire each handler to the nexus-sdk-js client.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** JSON Schema fragment as embedded in tool definitions. Intentionally loose
 * (`unknown` properties) — the locked schemas use JSON-Schema-draft-07 idioms
 * that TypeScript can't capture without a heavyweight schema library. */
export type JsonSchemaObject = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * Standard NOT_IMPLEMENTED result for Wave 1 scaffold handlers.
 *
 * MCP best practice: tool-level errors are reported via `isError: true` in
 * the result, not as a JSON-RPC protocol error. The LLM can then see the
 * error and self-correct (per CallToolResult spec).
 */
export function notImplementedResult(toolName: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `NOT_IMPLEMENTED: ${toolName} handler is a Wave 1 scaffold and will be wired to nexus-sdk-js in TASK-007..010.`,
      },
    ],
  };
}
