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
      expect(server.selectedSessionKey).toBe(JSON.stringify(['sess-1', 'main']));
    });

    it('missing session_id defaults to "default"', async () => {
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(server.selectedSessionKey).toBe(JSON.stringify(['default', 'main']));
    });
  });

  describe('Backward compatibility', () => {
    it('single-session mode works without session_id in requests', async () => {
      // Enable voice
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
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
    it('two sessions have separate queues', async () => {
      // Register session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Add utterance — goes to active session (session-A)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello from A' }),
      });

      // Register session-B (does NOT become active — autoSelectIfNone only sets the first)
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-B' }),
      });

      // Verify session-A has the utterance
      const keyA = JSON.stringify(['session-A', 'main']);
      const sessionA = server.sessions.get(keyA);
      expect(sessionA).toBeDefined();
      expect(sessionA!.queue.utterances.length).toBe(1);
      expect(sessionA!.queue.utterances[0].text).toBe('Hello from A');

      // Verify session-B's queue is empty
      const keyB = JSON.stringify(['session-B', 'main']);
      const sessionB = server.sessions.get(keyB);
      expect(sessionB).toBeDefined();
      expect(sessionB!.queue.utterances.length).toBe(0);
    });

    it('background session pre-speak whitelists text and approves', async () => {
      // Enable voice
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });

      // Set main agent as selected
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Subagent tries to speak (background session, approved and whitelisted)
      const res = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          agent_id: 'subagent-B',
          tool_input: { text: 'I am B' },
        }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');

      // Text should be whitelisted (all sessions now get whitelisted)
      expect(server.speakWhitelist.has('I am B')).toBe(true);

      // When speak is called, text gets stored in conversation history
      // but no TTS audio plays (background session)
      const speakRes = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'I am B' }),
      });
      const speakData = await speakRes.json() as any;
      expect(speakData.success).toBe(true);

      // Verify the message was stored in subagent-B's conversation history via speak
      const sessionBKey = JSON.stringify(['session-A', 'subagent-B']);
      const sessionB = server.sessions.get(sessionBKey);
      expect(sessionB).toBeDefined();
      const assistantMsgs = sessionB!.queue.messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs.some(m => m.text === 'I am B')).toBe(true);
    });
  });

  describe('Inactive session voice enforcement', () => {
    it('inactive session stop blocks when unspoken after tool use with background enforcement', async () => {
      // Set main agent as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Enable background voice enforcement (explicit opt-in for subagent speaking)
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Subagent uses a tool (creates session, sets lastToolUseTimestamp)
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A', agent_id: 'subagent-B' }),
      });

      // Subagent tries to stop — should block (hasn't spoken since tool use)
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A', agent_id: 'subagent-B' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('speak');
    });

    it('background session speak satisfies speak requirement for stop', async () => {
      // Enable voice responses (required for /api/speak to work)
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });

      // Set main agent as selected
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Enable background voice enforcement
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Subagent uses a tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A', agent_id: 'subagent-B' }),
      });

      // Subagent pre-speak whitelists, then speak stores and sets lastSpeakTimestamp
      const preSpeakRes = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session-A',
          agent_id: 'subagent-B',
          tool_input: { text: 'My response' },
        }),
      });
      const preSpeakData = await preSpeakRes.json() as any;
      expect(preSpeakData.decision).toBe('approve');

      // Call speak endpoint to actually set lastSpeakTimestamp
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'My response' }),
      });

      // Subagent tries to stop — should now approve
      const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A', agent_id: 'subagent-B' }),
      });
      const stopData = await stopRes.json() as any;
      expect(stopData.decision).toBe('approve');
    });

    it('inactive session stop approves with no prior tool use', async () => {
      // Set session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Enable voice responses
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });

      // Session-C created via stop (no prior tool use — lastToolUseTimestamp is null)
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-C' }),
      });
      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('voice input before session attach migrates to first real session', async () => {
      // Voice input arrives before any hook fires (goes to default session)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello before session' }),
      });

      // Verify utterance is in default session
      const defaultKey = JSON.stringify(['default', 'main']);
      const defaultSession = server.sessions.get(defaultKey);
      expect(defaultSession).toBeDefined();
      expect(defaultSession!.queue.utterances.length).toBe(1);
      expect(defaultSession!.queue.utterances[0].text).toBe('Hello before session');

      // First hook fires with a real session ID — should migrate
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'real-session' }),
      });

      // Verify utterance migrated to real session
      const realKey = JSON.stringify(['real-session', 'main']);
      const realSession = server.sessions.get(realKey);
      expect(realSession).toBeDefined();
      expect(realSession!.queue.utterances.length).toBe(1);
      expect(realSession!.queue.utterances[0].text).toBe('Hello before session');

      // Verify default session queue is now empty
      expect(defaultSession!.queue.utterances.length).toBe(0);
      expect(defaultSession!.queue.messages.length).toBe(0);
    });

    it('sessions response includes messageCount', async () => {
      // Register session-A as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session-A' }),
      });

      // Add an utterance to session-A
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });

      const res = await fetch(`${server.url}/api/sessions`);
      const data = await res.json() as any;
      const sessionA = data.sessions.find((s: any) => s.sessionId === 'session-A');
      expect(sessionA).toBeDefined();
      expect(sessionA.messageCount).toBe(1);
    });
  });
});
