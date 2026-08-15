import { TestServer } from '../test-utils/test-server.js';

describe('Speak Endpoint Integration Tests', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('POST /api/speak', () => {
    it('should record the text without audio when voice input is not active', async () => {
      // Voice input is inactive by default, so no audio transport exists.
      const response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test message' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.spoken).toBe(false);

      // The point of the change: the reply still reaches the conversation UI
      // even though it could not be spoken aloud.
      const conversation = await fetch(`${server.url}/api/conversation`);
      const { messages } = await conversation.json() as any;
      const assistantMessages = messages.filter((m: any) => m.role === 'assistant');

      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('Test message');
    });

    it('should return 200 success when voice responses are enabled', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Then try to speak
      const response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test message' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data).toHaveProperty('success', true);
      expect(data).toHaveProperty('message', 'Text spoken successfully');
    });

    it('should return 400 error when text is missing', async () => {
      const response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data).toEqual({
        error: 'Text is required'
      });
    });

    it('should return 400 error when text is empty', async () => {
      const response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '  ' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data).toEqual({
        error: 'Text is required'
      });
    });

    it('should handle voice preference state changes correctly', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Speak should work
      let response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First test' })
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).spoken).toBe(true);

      // Disable voice input
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      });

      // Speak still succeeds, but is recorded silently rather than spoken
      response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second test' })
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).spoken).toBe(false);

      // Re-enable voice responses
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Speak should work again
      response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Third test' })
      });
      expect(response.status).toBe(200);
    });
  });

  // An attached browser tab is a reply route in its own right: the user can read
  // a chat bubble without the microphone ever being switched on.
  describe('chat UI attached without the microphone', () => {
    it('should refuse to wait when neither the mic nor a browser is available', async () => {
      const response = await fetch(`${server.url}/api/wait-for-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error).toBe(
        'Voice input is not active and no browser is connected. Cannot wait for utterances.'
      );
    });

    it('should wait when a browser is attached even with the mic off', async () => {
      server.chatClientCount = 1;

      const response = await fetch(`${server.url}/api/wait-for-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      // Not the 400 refusal — the wait is allowed to proceed.
      expect(response.status).toBe(200);
    });

    it('should still require a spoken response for delivered utterances', async () => {
      server.chatClientCount = 1;

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'a typed message' })
      });

      // post-tool delivers the pending utterance.
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // The stop hook now sees it delivered-but-unresponded and must block,
      // exactly as it would with the microphone on.
      const response = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('unresponded');
    });

    it('should allow stopping once no reply route remains', async () => {
      // Same setup, but with nothing attached: no mic, no browser. Nobody would
      // see a reply, so the turn is free to end.
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'a typed message' })
      });

      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const response = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await response.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

});
