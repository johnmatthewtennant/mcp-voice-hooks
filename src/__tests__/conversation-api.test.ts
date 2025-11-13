import { TestServer } from '../test-utils/test-server.js';

describe('Conversation API', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /api/conversation', () => {
    it('should return empty array when no messages exist', async () => {
      const response = await fetch(`${server.url}/api/conversation`);
      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.messages).toEqual([]);
    });

    it('should include user message after posting utterance', async () => {
      // Enable voice input
      await fetch(`${server.url}/api/voice-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Add a user utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello world' })
      });

      // Fetch conversation
      const response = await fetch(`${server.url}/api/conversation`);
      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0]).toMatchObject({
        role: 'user',
        text: 'Hello world',
        status: 'pending'
      });
      expect(data.messages[0].id).toBeDefined();
      expect(data.messages[0].timestamp).toBeDefined();
    });

    it('should include assistant message after speak is called', async () => {
      // Enable voice responses
      await fetch(`${server.url}/api/voice-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });

      // Call speak endpoint
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Assistant response' })
      });

      // Fetch conversation
      const response = await fetch(`${server.url}/api/conversation`);
      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.messages.length).toBe(1);
      expect(data.messages[0]).toMatchObject({
        role: 'assistant',
        text: 'Assistant response'
      });
      expect(data.messages[0].id).toBeDefined();
      expect(data.messages[0].timestamp).toBeDefined();
      expect(data.messages[0].status).toBeUndefined(); // Assistant messages don't have status
    });

    it('should sync status updates between utterances and messages', async () => {
      // Enable voice input and responses
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

      // Add user message
      const addResponse = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'User message' })
      });
      const addData = await addResponse.json() as any;
      const messageId = addData.utterance.id;

      // Check status is pending in conversation
      let convResponse = await fetch(`${server.url}/api/conversation`);
      let convData = await convResponse.json() as any;
      expect(convData.messages[0].status).toBe('pending');

      // Dequeue (should mark as delivered)
      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Check status is delivered in conversation
      convResponse = await fetch(`${server.url}/api/conversation`);
      convData = await convResponse.json() as any;
      expect(convData.messages[0].status).toBe('delivered');

      // Speak (should mark as responded)
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response' })
      });

      // Check status is responded in conversation
      convResponse = await fetch(`${server.url}/api/conversation`);
      convData = await convResponse.json() as any;
      const userMessage = convData.messages.find((m: any) => m.id === messageId);
      expect(userMessage.status).toBe('responded');
    });

    it('should return messages in chronological order (oldest first)', async () => {
      // Enable voice input and responses
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

      // Add messages with small delays to ensure proper ordering
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First message' })
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Assistant reply' })
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Third message' })
      });

      // Fetch conversation
      const response = await fetch(`${server.url}/api/conversation`);
      const data = await response.json() as any;

      expect(data.messages.length).toBe(3);
      expect(data.messages[0].text).toBe('First message');
      expect(data.messages[1].text).toBe('Assistant reply');
      expect(data.messages[2].text).toBe('Third message');
    });
  });
});
