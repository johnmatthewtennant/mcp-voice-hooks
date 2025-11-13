import { TestServer } from '../test-utils/test-server.js';

describe('utterance state transitions', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();

    // Enable voice input and voice responses for tests
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
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('state transition: pending -> delivered', () => {
    it('should transition from pending to delivered when dequeued', async () => {
      // Add an utterance (starts as pending)
      const addResponse = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello world' })
      });
      const addData = await addResponse.json() as any;

      expect(addData.utterance.status).toBe('pending');

      // Dequeue it (should become delivered)
      const dequeueResponse = await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const dequeueData = await dequeueResponse.json() as any;

      expect(dequeueData.success).toBe(true);
      expect(dequeueData.utterances.length).toBe(1);

      // Check status
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusResponse.json() as any;

      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(1);
      expect(statusData.responded).toBe(0);
    });

    it('should handle multiple utterances', async () => {
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

      // Check status - all pending
      let statusResponse = await fetch(`${server.url}/api/utterances/status`);
      let statusData = await statusResponse.json() as any;

      expect(statusData.total).toBe(3);
      expect(statusData.pending).toBe(3);
      expect(statusData.delivered).toBe(0);

      // Dequeue all
      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Check status - all delivered
      statusResponse = await fetch(`${server.url}/api/utterances/status`);
      statusData = await statusResponse.json() as any;

      expect(statusData.total).toBe(3);
      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(3);
    });
  });

  describe('state transition: delivered -> responded', () => {
    it('should transition from delivered to responded when speak is called', async () => {
      // Add and dequeue an utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Check status - should be delivered
      let statusResponse = await fetch(`${server.url}/api/utterances/status`);
      let statusData = await statusResponse.json() as any;

      expect(statusData.delivered).toBe(1);
      expect(statusData.responded).toBe(0);

      // Speak
      const speakResponse = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response text' })
      });
      const speakData = await speakResponse.json() as any;

      expect(speakResponse.status).toBe(200);
      expect(speakData.success).toBe(true);
      expect(speakData.respondedCount).toBe(1);

      // Check status - should be responded
      statusResponse = await fetch(`${server.url}/api/utterances/status`);
      statusData = await statusResponse.json() as any;

      expect(statusData.delivered).toBe(0);
      expect(statusData.responded).toBe(1);
    });

    it('should mark all delivered utterances as responded', async () => {
      // Add and dequeue multiple utterances
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

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Speak should mark all as responded
      const speakResponse = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response' })
      });
      const speakData = await speakResponse.json() as any;

      expect(speakData.respondedCount).toBe(2);

      // Check status
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusResponse.json() as any;

      expect(statusData.delivered).toBe(0);
      expect(statusData.responded).toBe(2);
    });

    it('should handle speak with no delivered utterances', async () => {
      // Speak without any delivered utterances
      const speakResponse = await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response' })
      });
      const speakData = await speakResponse.json() as any;

      expect(speakResponse.status).toBe(200);
      expect(speakData.success).toBe(true);
      expect(speakData.respondedCount).toBe(0);
    });
  });

  describe('complete conversation flow', () => {
    it('should follow pending -> delivered -> responded cycle', async () => {
      // 1. Add utterance (pending)
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'User input' })
      });

      let statusResponse = await fetch(`${server.url}/api/utterances/status`);
      let statusData = await statusResponse.json() as any;

      expect(statusData.pending).toBe(1);
      expect(statusData.delivered).toBe(0);
      expect(statusData.responded).toBe(0);

      // 2. Dequeue (delivered)
      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      statusResponse = await fetch(`${server.url}/api/utterances/status`);
      statusData = await statusResponse.json() as any;

      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(1);
      expect(statusData.responded).toBe(0);

      // 3. Speak (responded)
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Assistant response' })
      });

      statusResponse = await fetch(`${server.url}/api/utterances/status`);
      statusData = await statusResponse.json() as any;

      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(0);
      expect(statusData.responded).toBe(1);
    });

    it('should handle multiple conversation turns', async () => {
      // First turn
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First input' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First response' })
      });

      // Second turn
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second input' })
      });

      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Second response' })
      });

      // Final status
      const statusResponse = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusResponse.json() as any;

      expect(statusData.total).toBe(2);
      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(0);
      expect(statusData.responded).toBe(2);
    }, 10000); // Increase timeout for this test that makes 4 speak calls
  });
});
