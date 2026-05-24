/**
 * Unit tests for src/metrics.ts (US-037 Wave 2 TASK-014).
 *
 * Test strategy
 * =============
 * Each test resets the registry by calling `.resetMetrics()` on the imported
 * singleton counters/histograms so state does not bleed between cases.
 * The metrics HTTP server is tested without actually starting a port listener
 * by calling `registry.metrics()` directly after emitter calls.
 *
 * Cases (5 required by TASK-014 spec)
 * =====================================
 * 1. Counter increments on `emitToolCall('nexus.memory_search', 'success', 'cursor')`
 *    → `/metrics` text body contains the expected Prometheus line.
 * 2. Histogram observes a duration; bucket/sum appears in metrics output.
 * 3. Unknown client `emitToolCall(..., ..., 'foobar')` → `client` label =
 *    `'unknown'` and `nexus_mcp_unknown_client_total{raw="foobar"}` increments.
 * 4. `MCP_TOOL_DESCRIPTION_VERSION` Info gauge exposes hash label at value 1.
 * 5. `registry.metrics()` returns Prometheus text format (Content-Type header
 *    check via the `registry.contentType` string).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registry,
  MCP_TOOL_CALLS_TOTAL,
  MCP_TOOL_DURATION_SECONDS,
  MCP_TOOLS_LIST_CALLS_TOTAL,
  MCP_TOOL_DESCRIPTION_VERSION,
  MCP_UNKNOWN_CLIENT_TOTAL,
  emitToolCall,
  emitToolsList,
  emitToolDuration,
  emitUnknownClient,
  setDescriptionHash,
} from '../../src/metrics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset all metric values between tests so counter state doesn't bleed.
 * `prom-client` Counter/Histogram expose `.reset()` for this purpose.
 */
function resetAllMetrics(): void {
  MCP_TOOL_CALLS_TOTAL.reset();
  MCP_TOOL_DURATION_SECONDS.reset();
  MCP_TOOLS_LIST_CALLS_TOTAL.reset();
  MCP_UNKNOWN_CLIENT_TOTAL.reset();
  // Gauge: reset by setting all label sets back to 0 — simpler to just
  // reset through the registry for the Info gauge.
  MCP_TOOL_DESCRIPTION_VERSION.reset();
}

beforeEach(() => {
  resetAllMetrics();
});

// ---------------------------------------------------------------------------
// Case 1: Counter increments on emitToolCall — output contains expected line
// ---------------------------------------------------------------------------

describe('Case 1 — emitToolCall increments nexus_mcp_tool_calls_total', () => {
  it('after emitToolCall the metrics text contains the labelled counter line', async () => {
    emitToolCall('nexus.memory_search', 'success', 'cursor');

    const output = await registry.metrics();

    // The Prometheus text format encodes labels as {k="v",...}.
    // Counter names get `_total` suffix appended by prom-client.
    expect(output).toContain('nexus_mcp_tool_calls_total');
    expect(output).toContain('tool="nexus.memory_search"');
    expect(output).toContain('status="success"');
    expect(output).toContain('client="cursor"');

    // Check that the counter value is exactly 1.
    // prom-client formats: nexus_mcp_tool_calls_total{...} 1
    const lineRegex =
      /nexus_mcp_tool_calls_total\{[^}]*tool="nexus\.memory_search"[^}]*status="success"[^}]*client="cursor"[^}]*\}\s+1(\s|$)/m;
    expect(output).toMatch(lineRegex);
  });

  it('emitToolCall twice results in counter value 2', async () => {
    emitToolCall('nexus.memory_create', 'error', 'claude-code');
    emitToolCall('nexus.memory_create', 'error', 'claude-code');

    const output = await registry.metrics();
    const lineRegex =
      /nexus_mcp_tool_calls_total\{[^}]*tool="nexus\.memory_create"[^}]*status="error"[^}]*client="claude-code"[^}]*\}\s+2(\s|$)/m;
    expect(output).toMatch(lineRegex);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Histogram observes duration
// ---------------------------------------------------------------------------

describe('Case 2 — emitToolDuration observes in nexus_mcp_tool_duration_seconds', () => {
  it('after emitToolDuration the metrics output contains _sum and _bucket for the tool', async () => {
    emitToolDuration('nexus.context_retrieve', 0.123);

    const output = await registry.metrics();

    expect(output).toContain('nexus_mcp_tool_duration_seconds');
    // prom-client appends _sum for histogram total observed value
    expect(output).toContain('nexus_mcp_tool_duration_seconds_sum');
    expect(output).toContain('tool="nexus.context_retrieve"');
    // The sum should include our observed value
    const sumRegex =
      /nexus_mcp_tool_duration_seconds_sum\{[^}]*tool="nexus\.context_retrieve"[^}]*\}\s+0\.123(\s|$)/m;
    expect(output).toMatch(sumRegex);
  });
});

// ---------------------------------------------------------------------------
// Case 3: Unknown client guard
// ---------------------------------------------------------------------------

describe('Case 3 — unknown client label coercion and debug counter', () => {
  it('emitToolCall with unknown client sets client="unknown" and increments debug counter', async () => {
    emitToolCall('nexus.memory_search', 'success', 'foobar');

    const output = await registry.metrics();

    // The tool call counter must use client="unknown", not "foobar"
    expect(output).toContain('client="unknown"');
    // The raw "foobar" must NOT appear as a client label value on the main counter
    // (it should only appear in the debug counter's raw label)
    const mainCounterFoobar = /nexus_mcp_tool_calls_total\{[^}]*client="foobar"[^}]*\}/m;
    expect(output).not.toMatch(mainCounterFoobar);

    // The debug counter must have raw="foobar" with value 1
    expect(output).toContain('nexus_mcp_unknown_client_total');
    expect(output).toContain('raw="foobar"');
    const debugRegex = /nexus_mcp_unknown_client_total\{[^}]*raw="foobar"[^}]*\}\s+1(\s|$)/m;
    expect(output).toMatch(debugRegex);
  });

  it('emitUnknownClient directly increments the debug counter', async () => {
    emitUnknownClient('myCustomClient');

    const output = await registry.metrics();
    expect(output).toContain('raw="myCustomClient"');
    const debugRegex =
      /nexus_mcp_unknown_client_total\{[^}]*raw="myCustomClient"[^}]*\}\s+1(\s|$)/m;
    expect(output).toMatch(debugRegex);
  });

  it('known client cursor does NOT trigger unknown counter', async () => {
    emitToolCall('nexus.memory_search', 'success', 'cursor');

    const output = await registry.metrics();

    // The unknown counter should not have been incremented for 'cursor'
    // (the metric may appear in output as 0 or not at all)
    const debugRegex = /nexus_mcp_unknown_client_total\{[^}]*raw="cursor"[^}]*\}\s+[1-9]/m;
    expect(output).not.toMatch(debugRegex);
  });
});

// ---------------------------------------------------------------------------
// Case 4: tool_description_version Info gauge exposes hash label
// ---------------------------------------------------------------------------

describe('Case 4 — nexus_mcp_tool_description_version Info gauge', () => {
  it('setDescriptionHash registers a gauge with the hash label at value 1', async () => {
    setDescriptionHash('a1b2c3d4');

    const output = await registry.metrics();

    expect(output).toContain('nexus_mcp_tool_description_version');
    expect(output).toContain('hash="a1b2c3d4"');
    const gaugeRegex = /nexus_mcp_tool_description_version\{[^}]*hash="a1b2c3d4"[^}]*\}\s+1(\s|$)/m;
    expect(output).toMatch(gaugeRegex);
  });
});

// ---------------------------------------------------------------------------
// Case 5: Metrics endpoint Content-Type header is Prometheus text format
// ---------------------------------------------------------------------------

describe('Case 5 — registry contentType is Prometheus text format', () => {
  it('registry.contentType is text/plain with version=0.0.4 (Prometheus exposition format)', () => {
    const contentType = registry.contentType;
    // prom-client sets this to:
    // 'text/plain; version=0.0.4; charset=utf-8'
    expect(contentType).toMatch(/text\/plain/);
    expect(contentType).toContain('version=0.0.4');
  });

  it('registry.metrics() output starts with a HELP or TYPE comment (valid Prometheus text)', async () => {
    // Ensure at least one metric is registered so output is non-trivial.
    emitToolCall('nexus.memory_feedback', 'success', 'windsurf');

    const output = await registry.metrics();
    // Prometheus text format starts with # HELP or # TYPE lines.
    expect(output).toMatch(/^#\s+(HELP|TYPE)/m);
  });
});

// ---------------------------------------------------------------------------
// Bonus: emitToolsList
// ---------------------------------------------------------------------------

describe('emitToolsList — nexus_mcp_tools_list_calls_total', () => {
  it('increments the tools-list counter with the normalised client label', async () => {
    emitToolsList('cline');
    emitToolsList('cline');

    const output = await registry.metrics();
    expect(output).toContain('nexus_mcp_tools_list_calls_total');
    const lineRegex = /nexus_mcp_tools_list_calls_total\{[^}]*client="cline"[^}]*\}\s+2(\s|$)/m;
    expect(output).toMatch(lineRegex);
  });
});
