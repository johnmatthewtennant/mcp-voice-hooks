import { TestServer } from '../test-utils/test-server.js';

describe('Session routing bug fixes', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Bug 1: Default session should not steal active status', () => {
    it('browser endpoints do not create default session when real sessions exist', async () => {
      // Register a real session first
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'real-session' }),
      });

      // Browser calls getActiveSession-based endpoints
      await fetch(`${server.url}/api/utterances`);
      await fetch(`${server.url}/api/conversation`);

      // Check that no default session was created
      const sessionsRes = await fetch(`${server.url}/api/sessions`);
      const data = await sessionsRes.json() as any;
      const defaultSession = data.sessions.find((s: any) => s.sessionId === 'default');
      expect(defaultSession).toBeUndefined();
    });

    it('registerIfFirst upgrades from default to real session', async () => {
      // First, create a default session by calling a browser endpoint (no hooks yet)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello before any session' }),
      });

      // Now register a real session via hooks
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'real-session' }),
      });

      // The active session should now be the real session, not default
      const realKey = JSON.stringify(['real-session', 'main']);
      expect(server.activeCompositeKey).toBe(realKey);
    });

    it('default session does not become active when real session already active', async () => {
      // Register real session as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'real-session' }),
      });

      const realKey = JSON.stringify(['real-session', 'main']);
      expect(server.activeCompositeKey).toBe(realKey);

      // Call browser endpoints that would previously create/return default session
      await fetch(`${server.url}/api/utterances`);
      await fetch(`${server.url}/api/conversation`);
      await fetch(`${server.url}/api/utterances/status`);

      // Active should still be the real session
      expect(server.activeCompositeKey).toBe(realKey);
    });
  });

  describe('Bug 2: Conversation history should not mix between sessions', () => {
    it('main agent and subagent have completely separate conversation histories', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });

      // Register main agent as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Add utterance to main agent (via browser, goes to active session)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Message for A' }),
      });

      // Dequeue the pending utterance (mark as delivered) so pre-speak won't block
      const keyA = JSON.stringify(['session-A', 'main']);
      const sessionA = server.sessions.get(keyA)!;
      sessionA.queue.utterances.forEach(u => {
        if (u.status === 'pending') sessionA.queue.markDelivered(u.id);
      });

      // Main agent speaks (whitelist + speak)
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Response from A' },
        }),
      });
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response from A' }),
      });

      // Subagent speaks (inactive, stored in subagent's history)
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          agent_id: 'subagent-B',
          tool_input: { text: 'Response from B' },
        }),
      });

      // Verify main agent has its messages (user + assistant)
      const aMessages = sessionA.queue.messages;
      expect(aMessages.some(m => m.text === 'Message for A' && m.role === 'user')).toBe(true);
      expect(aMessages.some(m => m.text === 'Response from A' && m.role === 'assistant')).toBe(true);
      // B's message should NOT be in A's history
      expect(aMessages.some(m => m.text === 'Response from B')).toBe(false);

      // Verify subagent has only its own message
      const keyB = JSON.stringify(['session-A', 'subagent-B']);
      const sessionB = server.sessions.get(keyB);
      expect(sessionB).toBeDefined();
      const bMessages = sessionB!.queue.messages;
      expect(bMessages.some(m => m.text === 'Response from B' && m.role === 'assistant')).toBe(true);
      // A's messages should NOT be in B's history
      expect(bMessages.some(m => m.text === 'Message for A')).toBe(false);
      expect(bMessages.some(m => m.text === 'Response from A')).toBe(false);
    });

    it('speak endpoint routes to correct session via whitelist', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });

      // Register main agent as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Register subagent (inactive, same session_id)
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A', agent_id: 'subagent-B' }),
      });

      // Main agent pre-speak whitelists text
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          tool_input: { text: 'Hello from active' },
        }),
      });

      // Speak endpoint should store in main agent session (the whitelisted session)
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello from active' }),
      });

      // Verify message ended up in main agent, not subagent
      const keyA = JSON.stringify(['session-A', 'main']);
      const sessionA = server.sessions.get(keyA);
      expect(sessionA!.queue.messages.some(m => m.text === 'Hello from active' && m.role === 'assistant')).toBe(true);

      const keyB = JSON.stringify(['session-A', 'subagent-B']);
      const sessionB = server.sessions.get(keyB);
      expect(sessionB!.queue.messages.some(m => m.text === 'Hello from active')).toBe(false);
    });
  });

  describe('Bug 3: Session switching key format', () => {
    it('session key is valid JSON and can be used to switch sessions', async () => {
      // Register two sessions
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-B' }),
      });

      // Get sessions list (like the sidebar would)
      const sessionsRes = await fetch(`${server.url}/api/sessions`);
      const data = await sessionsRes.json() as any;

      // Verify keys are valid JSON
      for (const session of data.sessions) {
        expect(() => JSON.parse(session.key)).not.toThrow();
        const parsed = JSON.parse(session.key);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(2);
      }

      // Switch to session-B using the key from the sessions list
      const sessionB = data.sessions.find((s: any) => s.sessionId === 'session-B');
      const switchRes = await fetch(`${server.url}/api/active-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: sessionB.key }),
      });
      const switchData = await switchRes.json() as any;
      expect(switchData.success).toBe(true);
      expect(switchData.activeKey).toBe(sessionB.key);
    });

    it('conversation endpoint returns only the active session messages after switch', async () => {
      // Register two sessions and add messages to each
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-B' }),
      });

      // Add a message to session-A (currently active)
      const keyA = JSON.stringify(['session-A', 'main']);
      await fetch(`${server.url}/api/active-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyA }),
      });
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Message for A' }),
      });

      // Switch to session-B and add a message there
      const keyB = JSON.stringify(['session-B', 'main']);
      await fetch(`${server.url}/api/active-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyB }),
      });
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Message for B' }),
      });

      // Conversation should only contain session-B's messages
      const convRes = await fetch(`${server.url}/api/conversation`);
      const convData = await convRes.json() as any;
      expect(convData.messages.some((m: any) => m.text === 'Message for B')).toBe(true);
      expect(convData.messages.some((m: any) => m.text === 'Message for A')).toBe(false);

      // Switch back to session-A
      await fetch(`${server.url}/api/active-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyA }),
      });

      // Conversation should only contain session-A's messages
      const convRes2 = await fetch(`${server.url}/api/conversation`);
      const convData2 = await convRes2.json() as any;
      expect(convData2.messages.some((m: any) => m.text === 'Message for A')).toBe(true);
      expect(convData2.messages.some((m: any) => m.text === 'Message for B')).toBe(false);
    });

    it('session key with special characters survives round-trip', async () => {
      // Register a session with a UUID-like ID (contains hyphens)
      const sessionId = 'abc-123-def-456';
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });

      // Get the key back from sessions endpoint
      const sessionsRes = await fetch(`${server.url}/api/sessions`);
      const data = await sessionsRes.json() as any;
      const session = data.sessions.find((s: any) => s.sessionId === sessionId);
      expect(session).toBeDefined();

      // Key should be parseable and contain original session ID
      const parsed = JSON.parse(session.key);
      expect(parsed[0]).toBe(sessionId);

      // Should be able to switch to it
      const switchRes = await fetch(`${server.url}/api/active-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: session.key }),
      });
      expect((await switchRes.json() as any).success).toBe(true);
    });
  });
});
