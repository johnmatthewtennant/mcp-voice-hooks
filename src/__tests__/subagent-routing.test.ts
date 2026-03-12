import { TestServer } from '../test-utils/test-server.js';

/**
 * Sub-agent routing tests.
 *
 * Sub-agent detection is handled client-side in the hook commands (hooks.json).
 * The hooks check for agent_id in the stdin JSON and return approve/block
 * without hitting the server. These tests verify the server endpoints still
 * work correctly for main agent requests (no agent_id).
 */
describe('Hook endpoints (main agent, no agent_id)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('POST /api/hooks/post-tool', () => {
    it('should approve when no pending utterances', async () => {
      const response = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test', hook_event_name: 'PostToolUse' }),
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('should dequeue and block when utterances pending', async () => {
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });

      const response = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test', hook_event_name: 'PostToolUse' }),
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('Hello');
    });
  });

  describe('POST /api/hooks/pre-speak', () => {
    it('should approve when no pending utterances', async () => {
      const response = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test', hook_event_name: 'PreToolUse' }),
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('POST /api/hooks/stop', () => {
    it('should approve when no pending utterances', async () => {
      const response = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }),
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('approve');
    });
  });
});
