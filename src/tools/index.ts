/**
 * Tool registry. Exports the 4 MVP tools registered with the MCP server in
 * `src/index.ts`. The order here is the order returned by `tools/list`.
 *
 * Adding/removing a tool: update this file + add corresponding fixture in
 * `tests/unit/schema_sync.test.ts`.
 */

import { contextRetrieveTool } from './context.js';
import { memoryCreateTool } from './memory_create.js';
import { memoryFeedbackTool } from './memory_feedback.js';
import { memorySearchTool } from './memory_search.js';
import type { ToolDefinition } from './types.js';

export const tools: readonly ToolDefinition[] = [
  contextRetrieveTool,
  memorySearchTool,
  memoryCreateTool,
  memoryFeedbackTool,
] as const;

export const toolsByName: ReadonlyMap<string, ToolDefinition> = new Map(
  tools.map((t) => [t.name, t]),
);

export type { ToolDefinition } from './types.js';
