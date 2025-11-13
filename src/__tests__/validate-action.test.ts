import { TestServer } from '../test-utils/test-server.js';

describe('validate-action endpoint', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('input validation', () => {
    it('should reject invalid action types', async () => {
      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'invalid' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data).toEqual({
        error: 'Invalid action. Must be "tool-use" or "stop"'
      });
    });

    it('should reject missing action', async () => {
      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data).toEqual({
        error: 'Invalid action. Must be "tool-use" or "stop"'
      });
    });
  });

  describe('tool-use action', () => {
    it('should allow when no utterances exist', async () => {
      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tool-use' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data).toEqual({ allowed: true });
    });

    it('should block when pending utterances exist and voice input is active', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add a pending utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tool-use' })
      });

      const data = await response.json() as any;

      expect(data.allowed).toBe(false);
      expect(data.requiredAction).toBe('dequeue_utterances');
      expect(data.reason).toContain('1 pending utterance(s)');
    });

    it('should allow when voice responses disabled and delivered utterances exist', async () => {
      // Add and dequeue an utterance (makes it delivered)
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Voice responses are disabled by default
      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tool-use' })
      });

      const data = await response.json() as any;

      expect(data).toEqual({ allowed: true });
    });

    it('should block when voice responses enabled and delivered utterances exist', async () => {
      // Enable voice input and voice responses
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      // Add two utterances and dequeue them
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'World' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tool-use' })
      });

      const data = await response.json() as any;

      expect(data.allowed).toBe(false);
      expect(data.requiredAction).toBe('speak');
      expect(data.reason).toContain('2 delivered utterance(s)');
    });

    it('should allow when all utterances are responded', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add, dequeue, and speak (marks as responded)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response' })
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tool-use' })
      });

      const data = await response.json() as any;

      expect(data).toEqual({ allowed: true });
    });
  });

  describe('stop action', () => {
    it('should allow when voice input is not active', async () => {
      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });

      const data = await response.json() as any;

      expect(data).toEqual({ allowed: true });
    });

    it('should allow when voice input is active but no utterances exist', async () => {
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });

      const data = await response.json() as any;

      expect(data).toEqual({ allowed: true });
    });

    it('should block when voice input is active and utterances exist', async () => {
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      // Add, dequeue, and speak to get a responded utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response' })
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });

      const data = await response.json() as any;

      expect(data.allowed).toBe(false);
      expect(data.requiredAction).toBe('wait_for_utterance');
      expect(data.reason).toContain('Stopping is not allowed');
    });

    it('should block with pending utterances when voice input is active', async () => {
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });

      const data = await response.json() as any;

      expect(data.allowed).toBe(false);
      expect(data.requiredAction).toBe('dequeue_utterances');
      expect(data.reason).toContain('1 pending utterance(s)');
    });

    it('should prioritize speak over wait when voice enabled', async () => {
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add and dequeue (creates delivered utterance)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });

      const data = await response.json() as any;

      expect(data.allowed).toBe(false);
      expect(data.requiredAction).toBe('speak');
      expect(data.reason).toContain('1 delivered utterance(s)');
    });
  });

  describe('action priority', () => {
    it('should prioritize dequeue over speak', async () => {
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add one pending and one delivered utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First' })
      });

      // Manually create a delivered utterance by adding, dequeuing one, then adding another
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Add another pending
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Third' })
      });

      const response = await fetch(`${server.url}/api/validate-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tool-use' })
      });

      const data = await response.json() as any;

      // Should prioritize dequeue over speak
      expect(data.requiredAction).toBe('dequeue_utterances');
    });
  });
});
