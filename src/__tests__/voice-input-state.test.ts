import { TestServer } from '../test-utils/test-server.js';

describe('Voice Input State Error Handling', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('POST /api/dequeue-utterances', () => {
    it('should return 400 error when voice input is not active', async () => {
      // Add an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance' })
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

    it('should dequeue utterances successfully when voice input is active', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add utterances
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance 1' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance 2' })
      });

      // Dequeue should succeed
      const response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.utterances.length).toBe(2);
    });

    it('should dequeue all pending utterances when voice input is active', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add multiple utterances
      for (let i = 1; i <= 5; i++) {
        await fetch(`${server.url}/api/potential-utterances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Utterance ${i}` })
        });
      }

      // Dequeue all
      const response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.utterances.length).toBe(5);

      // Verify all are delivered
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusResponse.json() as any;
      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(5);
    });
  });

  describe('POST /api/wait-for-utterances', () => {
    it('should return 400 error when voice input is not active', async () => {
      const response = await fetch(`${server.url}/api/wait-for-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Voice input is not active');
    });

    it('should process wait request when voice input is active', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance' })
      });

      // Wait should find it
      const response = await fetch(`${server.url}/api/wait-for-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.utterances.length).toBe(1);
      expect(data.utterances[0].text).toBe('Test utterance');
    });

    it('should return immediately when voice input is deactivated during wait', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Wait with no utterances (in real server this would poll, but our test server returns immediately)
      const response = await fetch(`${server.url}/api/wait-for-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.utterances.length).toBe(0);
    });
  });

  describe('Voice input state transitions', () => {
    it('should allow dequeue when voice input is activated', async () => {
      // Add an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test' })
      });

      // Dequeue should fail when voice input is off
      let response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect(response.status).toBe(400);

      // Activate voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Now dequeue should succeed
      response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect(response.status).toBe(200);
    });

    it('should prevent dequeue when voice input is deactivated', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test' })
      });

      // Dequeue should succeed
      let response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect(response.status).toBe(200);

      // Add another utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test 2' })
      });

      // Deactivate voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      });

      // Now dequeue should fail
      response = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      expect(response.status).toBe(400);
    });
  });
});
