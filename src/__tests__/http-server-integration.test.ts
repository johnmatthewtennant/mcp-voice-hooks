import { TestServer } from '../test-utils/test-server.js';

describe('HTTP Server Integration Tests', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('POST /api/potential-utterances', () => {
    it('should add an utterance and return it with pending status', async () => {
      const response = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello world' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.utterance).toMatchObject({
        text: 'Hello world',
        status: 'pending'
      });
      expect(data.utterance.id).toBeDefined();
      expect(data.utterance.timestamp).toBeDefined();
    });

    it('should return 400 when text is empty', async () => {
      const response = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data.error).toBe('Text is required');
    });

    it('should trim whitespace from utterance text', async () => {
      const response = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '  Hello world  ' })
      });

      const data = await response.json() as any;

      expect(data.utterance.text).toBe('Hello world');
    });
  });

  describe('GET /api/utterances', () => {
    it('should return empty array when no utterances exist', async () => {
      const response = await fetch(`${server.url}/api/utterances`);
      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.utterances).toEqual([]);
    });

    it('should return utterances in reverse chronological order', async () => {
      // Add three utterances
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Third' })
      });

      // Retrieve utterances
      const response = await fetch(`${server.url}/api/utterances`);
      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.utterances.length).toBe(3);
      expect(data.utterances[0].text).toBe('Third');
      expect(data.utterances[1].text).toBe('Second');
      expect(data.utterances[2].text).toBe('First');
    });

    it('should respect the limit query parameter', async () => {
      // Add three utterances
      for (let i = 1; i <= 5; i++) {
        await fetch(`${server.url}/api/potential-utterances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Utterance ${i}` })
        });
      }

      // Retrieve with limit=2
      const response = await fetch(`${server.url}/api/utterances?limit=2`);
      const data = await response.json() as any;

      expect(data.utterances.length).toBe(2);
    });
  });

  describe('GET /api/utterances/status', () => {
    it('should return correct counts for utterance states', async () => {
      // Add some utterances
      const res1 = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Pending 1' })
      });
      const data1 = await res1.json() as any;

      const res2 = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Pending 2' })
      });
      const data2 = await res2.json() as any;

      // Mark one as delivered
      server.getQueue().markDelivered(data1.utterance.id);

      // Check status
      const response = await fetch(`${server.url}/api/utterances/status`);
      const data = await response.json() as any;

      expect(data.total).toBe(2);
      expect(data.pending).toBe(1);
      expect(data.delivered).toBe(1);
    });
  });

  describe('POST /api/voice-input', () => {
    it('should update voice input state', async () => {
      const response = await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(server.getVoicePreferences().voiceInputActive).toBe(true);
    });

    it('should return 400 when active is not boolean', async () => {
      const response = await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: 'yes' })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data.error).toBe('active must be a boolean');
    });
  });

  describe('POST /api/voice-responses', () => {
    it('should update voice responses state', async () => {
      const response = await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(server.getVoicePreferences().voiceResponsesEnabled).toBe(true);
    });
  });

  describe('DELETE /api/utterances', () => {
    it('should clear all utterances', async () => {
      // Add some utterances
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test 1' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test 2' })
      });

      // Clear them
      const response = await fetch(`${server.url}/api/utterances`, {
        method: 'DELETE'
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify they're gone
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusResponse.json() as any;
      expect(statusData.total).toBe(0);
    });
  });

  describe('POST /api/dequeue-utterances', () => {
    it('should return error when voice input is not active', async () => {
      // Add an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test' })
      });

      // Try to dequeue without activating voice input
      const response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Voice input is not active');
    });

    it('should dequeue pending utterances and mark them as delivered', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add utterances with explicit timestamps to ensure proper ordering
      const timestamp1 = new Date('2025-01-01T10:00:00Z');
      const timestamp2 = new Date('2025-01-01T10:00:01Z');

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First', timestamp: timestamp1.toISOString() })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second', timestamp: timestamp2.toISOString() })
      });

      // Dequeue
      const response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.utterances.length).toBe(2);
      expect(data.utterances[0].text).toBe('Second');
      expect(data.utterances[1].text).toBe('First');

      // Verify they're marked as delivered
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusResponse.json() as any;
      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(2);
    });
  });
});
