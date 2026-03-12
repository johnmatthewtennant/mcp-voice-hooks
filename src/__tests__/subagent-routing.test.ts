import { TestServer } from '../test-utils/test-server.js';

describe('Sub-agent routing', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  const subagentBody = {
    session_id: 'test-session',
    agent_id: 'agent-123',
    agent_type: 'Explore',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
  };

  const mainAgentBody = {
    session_id: 'test-session',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
  };

  describe('POST /api/hooks/post-tool', () => {
    it('should instantly approve for sub-agents', async () => {
      const response = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subagentBody),
      });

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      expect(data.decision).toBe('approve');
    });

    it('should use normal routing for main agent (no agent_id)', async () => {
      const response = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mainAgentBody),
      });

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      // Main agent with no pending utterances gets approve
      expect(data.decision).toBe('approve');
    });

    it('should not dequeue utterances for sub-agents', async () => {
      // Add a pending utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello from user' }),
      });

      // Sub-agent hook should NOT dequeue
      const response = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subagentBody),
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('approve');

      // Utterance should still be pending
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const status = await statusResponse.json() as any;
      expect(status.pending).toBe(1);
    });
  });

  describe('POST /api/hooks/stop', () => {
    it('should instantly approve for sub-agents', async () => {
      const response = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subagentBody, hook_event_name: 'Stop' }),
      });

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      expect(data.decision).toBe('approve');
    });

    it('should not dequeue utterances for sub-agents on stop', async () => {
      // Add a pending utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Important message' }),
      });

      // Sub-agent stop hook should NOT dequeue
      const response = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subagentBody, hook_event_name: 'Stop' }),
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('approve');

      // Utterance should still be pending for the main agent
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const status = await statusResponse.json() as any;
      expect(status.pending).toBe(1);
    });
  });

  describe('POST /api/hooks/pre-speak', () => {
    it('should block sub-agents from using speak', async () => {
      const response = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...subagentBody, hook_event_name: 'PreToolUse', tool_name: 'speak' }),
      });

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('sub-agent');
    });

    it('should allow main agent to use speak', async () => {
      const response = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mainAgentBody),
      });

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      // Main agent with no pending utterances gets approve
      expect(data.decision).toBe('approve');
    });
  });
});
