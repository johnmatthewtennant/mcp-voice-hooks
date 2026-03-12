import { TestServer } from '../test-utils/test-server.js';

describe('Background Voice Enforcement', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /api/background-voice-enforcement', () => {
    it('returns disabled by default', async () => {
      const res = await fetch(`${server.url}/api/background-voice-enforcement`);
      const data = await res.json() as any;
      expect(data.enabled).toBe(false);
    });
  });

  describe('POST /api/background-voice-enforcement', () => {
    it('enables enforcement', async () => {
      const res = await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.enabled).toBe(true);

      // Verify GET returns updated value
      const getRes = await fetch(`${server.url}/api/background-voice-enforcement`);
      const getData = await getRes.json() as any;
      expect(getData.enabled).toBe(true);
    });

    it('disables enforcement', async () => {
      // Enable first
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Disable
      const res = await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      const data = await res.json() as any;
      expect(data.enabled).toBe(false);
    });
  });

  describe('Stop hook with background enforcement', () => {
    it('inactive session stops freely when enforcement is off', async () => {
      // Create two sessions: active (main) and inactive (sub-agent)
      const mainKey = JSON.stringify(['session1', 'main']);
      const subKey = JSON.stringify(['session1', 'agent-1']);

      // Register main as active via post-tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1' }),
      });

      // Sub-agent uses a tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1', agent_type: 'explore' }),
      });

      // Sub-agent tries to stop (enforcement is off, voice responses off)
      const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1' }),
      });
      const stopData = await stopRes.json() as any;
      expect(stopData.decision).toBe('approve');
    });

    it('inactive session is blocked when enforcement is on and has not spoken since tool use', async () => {
      // Enable enforcement
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Register main as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1' }),
      });

      // Sub-agent uses a tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1', agent_type: 'explore' }),
      });

      // Sub-agent tries to stop
      const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1' }),
      });
      const stopData = await stopRes.json() as any;
      expect(stopData.decision).toBe('block');
      expect(stopData.reason).toContain('speak tool');
    });

    it('inactive session can stop after speaking when enforcement is on', async () => {
      // Enable enforcement
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Register main as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1' }),
      });

      // Sub-agent uses a tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1', agent_type: 'explore' }),
      });

      // Sub-agent speaks (pre-speak stores in conversation history for inactive session)
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'session1',
          agent_id: 'agent-1',
          tool_input: { text: 'I found the answer.' },
        }),
      });

      // Sub-agent tries to stop - should be allowed now
      const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1' }),
      });
      const stopData = await stopRes.json() as any;
      expect(stopData.decision).toBe('approve');
    });

    it('inactive session without tool use can stop even with enforcement on', async () => {
      // Enable enforcement
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      // Register main as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1' }),
      });

      // Sub-agent tries to stop without having used any tools
      const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'session1', agent_id: 'agent-1' }),
      });
      const stopData = await stopRes.json() as any;
      expect(stopData.decision).toBe('approve');
    });

    it('reset clears enforcement state', async () => {
      await fetch(`${server.url}/api/background-voice-enforcement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });

      server.reset();

      expect(server.backgroundVoiceEnforcement).toBe(false);
    });
  });
});
