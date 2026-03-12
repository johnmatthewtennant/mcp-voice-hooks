import { TestServer } from '../test-utils/test-server.js';

describe('Per-session state and session lifecycle', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Session auto-creation', () => {
    it('first hook call creates a session and sets it as active', async () => {
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess-1' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
      expect(server.activeCompositeKey).toBe(JSON.stringify(['sess-1', 'main']));
    });

    it('missing session_id defaults to "default"', async () => {
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(server.activeCompositeKey).toBe(JSON.stringify(['default', 'main']));
    });
  });

  describe('Backward compatibility', () => {
    it('single-session mode works without session_id in requests', async () => {
      // Enable voice
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Add utterance (no session_id in this endpoint, goes to active session)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });

      // Get utterances
      const res = await fetch(`${server.url}/api/utterances`);
      const data = await res.json() as any;
      expect(data.utterances.length).toBe(1);
      expect(data.utterances[0].text).toBe('Hello');

      // Get conversation
      const convRes = await fetch(`${server.url}/api/conversation`);
      const convData = await convRes.json() as any;
      expect(convData.messages.length).toBe(1);
    });
  });

  describe('Multi-session isolation', () => {
    it('inactive session pre-speak stores message in conversation history', async () => {
      // Enable voice
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Set session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Session-B tries to speak (inactive, blocked)
      const res = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-B',
          tool_input: { text: 'I am B' },
        }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('block');

      // Check the message was stored in conversation history
      const convRes = await fetch(`${server.url}/api/conversation`);
      const convData = await convRes.json() as any;
      const assistantMsgs = convData.messages.filter((m: any) => m.role === 'assistant');
      expect(assistantMsgs.some((m: any) => m.text === 'I am B')).toBe(true);
    });
  });
});
