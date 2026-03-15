import { TestServer } from '../test-utils/test-server.js';

describe('Session restart detection', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('resets voice state when a new Claude session_id is detected', async () => {
    // Simulate first Claude session registering
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-old' }),
    });
    expect(server.activeCompositeKey).toBe(JSON.stringify(['session-old', 'main']));

    // Browser enables voice
    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });

    const prefsBefore = server.getVoicePreferences();
    expect(prefsBefore.voiceActive).toBe(true);

    // Claude restarts — new session_id arrives via hook
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-new' }),
    });

    // Active session should switch to the new one
    expect(server.activeCompositeKey).toBe(JSON.stringify(['session-new', 'main']));

    // Voice state should be reset
    const prefsAfter = server.getVoicePreferences();
    expect(prefsAfter.voiceActive).toBe(false);
  });

  it('new session becomes active and hooks work correctly after restart', async () => {
    // First session registers and enables voice
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-old' }),
    });
    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });

    // Claude restarts with new session
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-new' }),
    });

    // Browser re-syncs voice state (simulating what syncVoiceStateToServer does)
    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });

    // New session should be active and voice should work
    const prefs = server.getVoicePreferences();
    expect(prefs.voiceActive).toBe(true);

    // Stop hook on the new session should work as active (not inactive)
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
    // Should block because there are pending utterances — proving the new session is active
    expect(stopData.decision).toBe('block');
  });

  it('does not reset when same session_id sends another hook', async () => {
    // Register session
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

    // Same session sends another hook — should NOT reset
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1' }),
    });

    const prefs = server.getVoicePreferences();
    expect(prefs.voiceActive).toBe(true);
  });

  it('switches active to new session_id even if old session was recently active', async () => {
    // Register session A
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

    // Session B arrives immediately — should still switch active and reset voice
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-B' }),
    });

    expect(server.activeCompositeKey).toBe(JSON.stringify(['session-B', 'main']));

    const prefs = server.getVoicePreferences();
    expect(prefs.voiceActive).toBe(false);
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

    // Subagent from the same session sends hook — should NOT reset
    await fetch(`${server.url}/api/hooks/post-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', agent_id: 'subagent-1' }),
    });

    const prefs = server.getVoicePreferences();
    expect(prefs.voiceActive).toBe(true);
    expect(server.activeCompositeKey).toBe(JSON.stringify(['session-1', 'main']));
  });
});
