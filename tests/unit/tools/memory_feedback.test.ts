/**
 * Tests for src/tools/memory_feedback.ts (US-037 TASK-012, Wave 2).
 *
 * Verifies the wired handler against the R2.1 grep-corrected schema
 * (proposal §"R2.1 grep 修正" Tool 4):
 *
 *   1. Happy path — valid args produce a SDK call with `retrieve_id`
 *      as the URL path argument and a body that excludes `user_id`.
 *   2. rating=0  → MCP InvalidParams (NexusError).
 *   3. rating=6  → MCP InvalidParams (NexusError).
 *   4. item_feedback[0].reason with 256 chars → InvalidParams
 *      (backend cap is 255 per R2.1 D-1; we hard-reject in MCP layer).
 *   5. expected_missing with 2001 chars → InvalidParams
 *      (backend cap is 2000 per R2.1 D-1).
 *   6. user_id privacy — captured SDK body MUST NOT contain `user_id`
 *      (R2.1 D-1 backend contract: PUT /feedback/{retrieve_id} derives
 *      user_id from retrieve_log, not the body).
 *
 * Strategy: `vi.mock('@nexusm/sdk', ...)` replaces `NexusClient` with a
 * spyable stub. We capture both positional args of `feedback.submit` so
 * test 1 + test 6 can assert on (retrieveId, body) precisely.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpErrorCode, NexusError } from '../../../src/errors.js';

// vi.hoisted keeps the spy reference accessible inside the hoisted
// vi.mock factory (vitest hoists vi.mock above imports).
const { submitSpy } = vi.hoisted(() => ({
  submitSpy: vi.fn<
    [string, Record<string, unknown>],
    Promise<{
      feedback_id: string;
      retrieve_id: string;
      status: string;
      created_at: string;
    }>
  >(),
}));

vi.mock('@nexusm/sdk', () => {
  return {
    NexusClient: vi.fn().mockImplementation(() => ({
      feedback: {
        submit: (retrieveId: string, body: Record<string, unknown>) =>
          submitSpy(retrieveId, body),
      },
    })),
  };
});

// Pre-set env vars so loadAuthConfig() inside the lazy client builder
// does not exit. Values are arbitrary — the SDK is fully mocked, so no
// HTTP traffic occurs.
process.env.NEXUS_API_URL = 'http://test.local';
process.env.NEXUS_API_TOKEN = 'sk-test-SECRET-DO-NOT-LEAK';
process.env.NEXUS_TENANT_ID = 'test-tenant';

// Import after vi.mock + env setup so the SDK mock is wired before the
// module's top-level imports execute.
const { memoryFeedbackTool, __resetClientForTesting, __setAuditLoggerForTesting } =
  await import('../../../src/tools/memory_feedback.js');

const VALID_RETRIEVE_ID = '11111111-1111-1111-1111-111111111111';
const VALID_MEMORY_ID = '22222222-2222-2222-2222-222222222222';
const VALID_USER_ID = 'user-42';

function happyResponse() {
  return {
    feedback_id: '33333333-3333-3333-3333-333333333333',
    retrieve_id: VALID_RETRIEVE_ID,
    status: 'accepted',
    created_at: '2026-05-22T00:00:00Z',
  };
}

beforeEach(() => {
  submitSpy.mockReset();
  submitSpy.mockResolvedValue(happyResponse());
  __resetClientForTesting();
  // Silence audit logger to keep test output clean.
  __setAuditLoggerForTesting(() => {});
});

describe('memory_feedback — happy path', () => {
  it('forwards retrieve_id as URL path arg and a user_id-free body to the SDK', async () => {
    const result = await memoryFeedbackTool.handler({
      user_id: VALID_USER_ID,
      retrieve_id: VALID_RETRIEVE_ID,
      rating: 4,
      item_feedback: [{ memory_id: VALID_MEMORY_ID, useful: true, reason: 'helpful' }],
      expected_missing: 'wanted more recent context',
      context: { client: 'claude-code', session_id: 'abc' },
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [retrieveIdArg, bodyArg] = submitSpy.mock.calls[0]!;

    // retrieve_id passed positionally (URL path), not in body.
    expect(retrieveIdArg).toBe(VALID_RETRIEVE_ID);

    // Body has the expected fields...
    expect(bodyArg).toMatchObject({
      rating: 4,
      item_feedback: [{ memory_id: VALID_MEMORY_ID, useful: true, reason: 'helpful' }],
      expected_missing: 'wanted more recent context',
      context: { client: 'claude-code', session_id: 'abc' },
    });

    // ...and the handler returns the SDK response as MCP structuredContent.
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'accepted',
      retrieve_id: VALID_RETRIEVE_ID,
    });
  });
});

describe('memory_feedback — rating range validation', () => {
  it('rejects rating=0 with InvalidParams (NexusError)', async () => {
    let caught: unknown = null;
    try {
      await memoryFeedbackTool.handler({
        user_id: VALID_USER_ID,
        retrieve_id: VALID_RETRIEVE_ID,
        rating: 0,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('rejects rating=6 with InvalidParams (NexusError)', async () => {
    let caught: unknown = null;
    try {
      await memoryFeedbackTool.handler({
        user_id: VALID_USER_ID,
        retrieve_id: VALID_RETRIEVE_ID,
        rating: 6,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe('memory_feedback — length-cap validation (R2.1 D-1)', () => {
  it('rejects item_feedback[0].reason at 256 chars (cap is 255)', async () => {
    const reason256 = 'x'.repeat(256);
    let caught: unknown = null;
    try {
      await memoryFeedbackTool.handler({
        user_id: VALID_USER_ID,
        retrieve_id: VALID_RETRIEVE_ID,
        rating: 3,
        item_feedback: [{ memory_id: VALID_MEMORY_ID, useful: false, reason: reason256 }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect((caught as NexusError).message).toMatch(/reason.*255/);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('rejects expected_missing at 2001 chars (cap is 2000)', async () => {
    const em2001 = 'y'.repeat(2001);
    let caught: unknown = null;
    try {
      await memoryFeedbackTool.handler({
        user_id: VALID_USER_ID,
        retrieve_id: VALID_RETRIEVE_ID,
        rating: 3,
        expected_missing: em2001,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NexusError);
    expect((caught as NexusError).mcpErrorCode).toBe(McpErrorCode.InvalidParams);
    expect((caught as NexusError).message).toMatch(/expected_missing.*2000/);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe('memory_feedback — user_id privacy (R2.1 D-1 backend contract)', () => {
  it('strips user_id from the SDK request body even when supplied in the MCP args', async () => {
    await memoryFeedbackTool.handler({
      user_id: VALID_USER_ID,
      retrieve_id: VALID_RETRIEVE_ID,
      rating: 5,
      item_feedback: [{ memory_id: VALID_MEMORY_ID, useful: true }],
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [, bodyArg] = submitSpy.mock.calls[0]!;

    // Critical R2.1 D-1 check: backend FeedbackRequest must not see user_id.
    expect(bodyArg).not.toHaveProperty('user_id');
    // And the value itself doesn't appear under any other key.
    for (const v of Object.values(bodyArg)) {
      expect(v).not.toBe(VALID_USER_ID);
    }
    // Sanity: the call still carried the expected payload.
    expect(bodyArg.rating).toBe(5);
  });
});
