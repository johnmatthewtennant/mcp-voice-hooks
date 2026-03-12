import { TestServer } from '../test-utils/test-server.js';

describe('Pre-speak whitelist and multi-session routing', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
    // Enable voice responses for speak tests
    await fetch(`${server.url}/api/voice-responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Active session routing', () => {
    it('first session_id becomes active by default', async () => {
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
      // session-A is now active
      expect(server.activeCompositeKey).toBe(JSON.stringify(['session-A', 'main']));
    });

    it('second session_id is inactive', async () => {
      // First call sets active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Second session is inactive — stop should approve immediately
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-B' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('sub-agent (same session_id, different agent_id) is inactive', async () => {
      // Main agent sets active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Sub-agent has agent_id, different composite key
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A', agent_id: 'sub-1' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('Pre-speak whitelist', () => {
    it('pre-speak for active session whitelists text and approves', async () => {
      const res = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Hello world' },
        }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
      // Text should be in whitelist
      expect(server.speakWhitelist.has('Hello world')).toBe(true);
    });

    it('speak endpoint accepts whitelisted text', async () => {
      // First whitelist via pre-speak
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Hello world' },
        }),
      });

      // Then speak
      const res = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello world' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('speak endpoint rejects non-whitelisted text when multi-session active', async () => {
      // Activate a session first (so activeCompositeKey is set)
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Whitelisted text' },
        }),
      });

      // Try to speak different text
      const res = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Not whitelisted' }),
      });
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toBe('Speak not authorized');
    });

    it('whitelist handles duplicate identical texts (multiset count)', async () => {
      // Whitelist same text twice
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Same text' },
        }),
      });
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Same text' },
        }),
      });

      // Both speaks should succeed
      const res1 = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Same text' }),
      });
      expect(res1.status).toBe(200);

      const res2 = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Same text' }),
      });
      expect(res2.status).toBe(200);

      // Third should fail
      const res3 = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Same text' }),
      });
      expect(res3.status).toBe(403);
    });

    it('pre-speak for inactive session blocks and stores in history', async () => {
      // Set session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // session-B tries to speak
      const res = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-B',
          tool_input: { text: 'I am session B' },
        }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('active session only');

      // Verify text was stored in session-B's conversation history
      const sessionBKey = JSON.stringify(['session-B', 'main']);
      const sessionB = server.sessions.get(sessionBKey);
      expect(sessionB).toBeDefined();
      const assistantMessages = sessionB!.queue.messages.filter(m => m.role === 'assistant');
      expect(assistantMessages.some(m => m.text === 'I am session B')).toBe(true);
    });
  });

  describe('Post-tool hook routing', () => {
    it('inactive session post-tool approves immediately', async () => {
      // Set session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // session-B post-tool should just approve
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-B' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('active session post-tool dequeues pending utterances', async () => {
      // Register session-A as active first
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Add an utterance (goes to active session)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hey there' }),
      });

      // Active session post-tool should dequeue
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('Hey there');
    });
  });

  describe('Stop hook routing', () => {
    it('inactive session stop approves immediately even with pending utterances', async () => {
      // Set session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Add an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Pending message' }),
      });

      // session-B stop should approve regardless
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-B' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('Backward compatibility', () => {
    it('missing session_id falls back to default session', async () => {
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
      // Should have created a default key
      expect(server.activeCompositeKey).toBe(JSON.stringify(['default', 'main']));
    });
  });
});
