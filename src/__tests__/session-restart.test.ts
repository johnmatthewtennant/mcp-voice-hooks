import { TestServer } from '../test-utils/test-server.js';

describe('Session selection behavior', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('first session auto-selects when no session is selected', async () => {
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-first' }),
    });
    expect(server.selectedSessionKey).toBe(JSON.stringify(['session-first', 'main']));
  });

  it('second session does NOT auto-select (browser must switch)', async () => {
    // First session auto-selects
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-A' }),
    });

    // Enable voice
    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });

    // Second session arrives — does NOT steal selection
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-B' }),
    });

    // Selection stays with session-A
    expect(server.selectedSessionKey).toBe(JSON.stringify(['session-A', 'main']));

    // Voice state is NOT reset (only browser selection changes routing)
    const prefs = server.getVoicePreferences();
    expect(prefs.voiceActive).toBe(true);
  });

  it('browser can switch selection via /api/active-session', async () => {
    // Register both sessions
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

    // Browser switches to session-B
    const switchRes = await fetch(`${server.url}/api/active-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: JSON.stringify(['session-B', 'main']) }),
    });
    const switchData = await switchRes.json() as any;
    expect(switchData.success).toBe(true);
    expect(server.selectedSessionKey).toBe(JSON.stringify(['session-B', 'main']));
  });

  it('new session hooks work correctly for the selected session', async () => {
    // Register session
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-new' }),
    });

    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });

    // Add an utterance so stop hook has something to check
    await fetch(`${server.url}/api/potential-utterances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello new session' }),
    });

    const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-new' }),
    });
    const stopData = await stopRes.json() as any;
    // Should block because there are pending utterances — session is selected
    expect(stopData.decision).toBe('block');
  });

  it('does not reset for subagent hooks within the same session', async () => {
    // Register main session
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1' }),
    });

    // Enable voice
    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });

    // Subagent from the same session sends hook — should NOT change selection
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', agent_id: 'subagent-1' }),
    });

    const prefs = server.getVoicePreferences();
    expect(prefs.voiceActive).toBe(true);
    expect(server.selectedSessionKey).toBe(JSON.stringify(['session-1', 'main']));
  });
});
