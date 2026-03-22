import { TestServer } from '../test-utils/test-server.js';

describe('Pre-speak hook: block while user is speaking', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();

    // Enable voice
    await fetch(`${server.url}/api/voice-active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true })
    });

    // Make a pre-speak request to register the session as active
    await fetch(`${server.url}/api/hooks/pre-speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'test-session',
        tool_input: { text: 'init' }
      })
    });
  });

  afterEach(async () => {
    // Ensure isUserSpeaking is cleared so server can shut down cleanly
    server.isUserSpeaking = false;
    await server.stop();
  });

  function preSpeakRequest(text: string = 'Hello world') {
    return fetch(`${server.url}/api/hooks/pre-speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'test-session',
        tool_input: { text }
      })
    });
  }

  it('should approve immediately when user is not speaking', async () => {
    server.isUserSpeaking = false;

    const response = await preSpeakRequest();
    const data = await response.json() as any;

    expect(data.decision).toBe('approve');
  });

  it('should block and wait when user is speaking, then approve after silence', async () => {
    server.isUserSpeaking = true;

    // Start the pre-speak request (it will block)
    const requestPromise = preSpeakRequest();

    // Simulate user stopping speaking after 200ms
    setTimeout(() => {
      server.isUserSpeaking = false;
    }, 200);

    const response = await requestPromise;
    const data = await response.json() as any;

    expect(data.decision).toBe('approve');
  });

  it('should still block for pending utterances even when user is speaking', async () => {
    // Add a pending utterance to the active session
    await fetch(`${server.url}/api/potential-utterances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hey Claude' })
    });

    server.isUserSpeaking = true;

    const response = await preSpeakRequest();
    const data = await response.json() as any;

    // Should block for pending utterances immediately (no user-speaking wait)
    expect(data.decision).toBe('block');
    expect(data.reason).toContain('pending');
  });

  it('should approve without waiting for inactive sessions (subagents)', async () => {
    server.isUserSpeaking = true;

    // Subagent: same session_id but different agent_id — this won't switch active key
    const response = await fetch(`${server.url}/api/hooks/pre-speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'test-session',
        agent_id: 'subagent-1',
        tool_input: { text: 'Hello from subagent' }
      })
    });
    const data = await response.json() as any;

    // Inactive sessions (subagents) should approve immediately (no user-speaking check)
    expect(data.decision).toBe('approve');
  });

  it('should block with utterances when finalized text arrives after user stops speaking', async () => {
    server.isUserSpeaking = true;

    const requestPromise = preSpeakRequest();

    // Finalized text arrives while user is still speaking
    setTimeout(async () => {
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Actually wait, I changed my mind' })
      });
    }, 100);

    // User stops speaking after 200ms
    setTimeout(() => {
      server.isUserSpeaking = false;
    }, 200);

    const response = await requestPromise;
    const data = await response.json() as any;

    expect(data.decision).toBe('block');
    expect(data.reason).toContain('Actually wait');
  });

  it('should approve when user stops speaking and no text arrives during grace period', async () => {
    server.isUserSpeaking = true;

    const requestPromise = preSpeakRequest();

    // User stops speaking after 200ms — no utterance added
    setTimeout(() => {
      server.isUserSpeaking = false;
    }, 200);

    const response = await requestPromise;
    const data = await response.json() as any;

    // No finalized text after grace period — false alarm, approve
    expect(data.decision).toBe('approve');
  });

  it('should measure blocking duration approximately matches user speaking duration', async () => {
    server.isUserSpeaking = true;
    const startTime = Date.now();

    const requestPromise = preSpeakRequest();

    // Stop speaking after ~300ms
    setTimeout(() => {
      server.isUserSpeaking = false;
    }, 300);

    await requestPromise;
    const elapsed = Date.now() - startTime;

    // Should have waited at least ~200ms but not much more than ~800ms
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });
});
