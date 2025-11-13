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
    it('should return 400 error when voice responses are disabled', async () => {
      // Ensure voice responses are disabled (default state)
      const response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test message' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data).toEqual({
        error: 'Voice responses are disabled',
        message: 'Cannot speak when voice responses are disabled'
      });
    });

    it('should return 200 success when voice responses are enabled', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
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
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      // Speak should work
      let response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First test' })
      });
      expect(response.status).toBe(200);

      // Disable voice responses
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });

      // Speak should now fail
      response = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second test' })
      });
      expect(response.status).toBe(400);

      // Re-enable voice responses
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
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

  describe('POST /api/speak-system', () => {
    it('should always work regardless of voice response setting', async () => {
      // Disable voice responses
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      });

      // System speak should still work
      const response = await fetch(`${server.url}/api/speak-system`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'System test message' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        message: 'Text spoken successfully via system voice'
      });
    });

    it('should return 400 error when text is missing', async () => {
      const response = await fetch(`${server.url}/api/speak-system`, {
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

    it('should accept custom rate parameter', async () => {
      const response = await fetch(`${server.url}/api/speak-system`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Test with custom rate',
          rate: 300
        })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        success: true,
        message: 'Text spoken successfully via system voice'
      });
    });
  });
});
