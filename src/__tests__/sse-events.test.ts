import { TestServer } from '../test-utils/test-server.js';
import { EventSource } from 'eventsource';

describe('SSE Events Integration Tests', () => {
  let server: TestServer;
  let eventSource: EventSource;
  const receivedEvents: any[] = [];

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
    receivedEvents.length = 0; // Clear events array
  });

  afterEach(async () => {
    if (eventSource) {
      eventSource.close();
    }
    await server.stop();
  });

  const connectSSE = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      eventSource = new EventSource(`${server.url}/api/events`);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          receivedEvents.push(data);
        } catch (error) {
          console.error('Failed to parse SSE event:', error);
        }
      };

      eventSource.onerror = (error) => {
        reject(error);
      };

      // Wait for connection
      eventSource.addEventListener('message', function handler(event) {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') {
          eventSource.removeEventListener('message', handler);
          resolve();
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => reject(new Error('SSE connection timeout')), 5000);
    });
  };

  const waitForEvent = (eventType: string, timeout = 2000): Promise<any> => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const checkEvents = () => {
        const event = receivedEvents.find(e => e.type === eventType);
        if (event) {
          resolve(event);
        } else if (Date.now() - startTime > timeout) {
          reject(new Error(`Timeout waiting for event: ${eventType}`));
        } else {
          setTimeout(checkEvents, 50);
        }
      };

      checkEvents();
    });
  };

  describe('SSE Connection', () => {
    it('should establish SSE connection and receive connected event', async () => {
      await connectSSE();

      const connectedEvent = receivedEvents.find(e => e.type === 'connected');
      expect(connectedEvent).toBeDefined();
    });

    it('should accept connections on /api/tts-events for backward compatibility', async () => {
      return new Promise<void>((resolve, reject) => {
        const legacyEventSource = new EventSource(`${server.url}/api/tts-events`);

        legacyEventSource.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'connected') {
            legacyEventSource.close();
            resolve();
          }
        };

        legacyEventSource.onerror = (error) => {
          legacyEventSource.close();
          reject(error);
        };

        setTimeout(() => {
          legacyEventSource.close();
          reject(new Error('Timeout waiting for connected event'));
        }, 5000);
      });
    });
  });

  describe('utterance-added event', () => {
    it('should broadcast utterance-added event when utterance is created', async () => {
      await connectSSE();

      // Add utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance' })
      });

      // Wait for event
      const event = await waitForEvent('utterance-added');

      expect(event.type).toBe('utterance-added');
      expect(event.utterance).toMatchObject({
        text: 'Test utterance',
        status: 'pending'
      });
      expect(event.utterance.id).toBeDefined();
      expect(event.utterance.timestamp).toBeDefined();
    });

    it('should broadcast multiple utterance-added events for multiple utterances', async () => {
      await connectSSE();

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

      // Wait a bit for all events
      await new Promise(resolve => setTimeout(resolve, 500));

      const addedEvents = receivedEvents.filter(e => e.type === 'utterance-added');
      expect(addedEvents.length).toBe(3);
      expect(addedEvents[0].utterance.text).toBe('First');
      expect(addedEvents[1].utterance.text).toBe('Second');
      expect(addedEvents[2].utterance.text).toBe('Third');
    });
  });

  describe('utterance-status-changed event', () => {
    it('should broadcast utterance-status-changed event when utterance is marked as delivered', async () => {
      await connectSSE();

      // Add utterance
      const addResponse = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance' })
      });
      const addData = await addResponse.json() as any;
      const utteranceId = addData.utterance.id;

      // Clear events so we only see the status change
      receivedEvents.length = 0;

      // Dequeue utterances (marks as delivered)
      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST'
      });

      // Wait for status change event
      const event = await waitForEvent('utterance-status-changed');

      expect(event.type).toBe('utterance-status-changed');
      expect(event.utterance.id).toBe(utteranceId);
      expect(event.utterance.status).toBe('delivered');
    });

    it('should broadcast utterance-status-changed event when utterance is marked as responded', async () => {
      await connectSSE();

      // Enable voice responses
      await fetch(`${server.url}/api/voice-preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceResponsesEnabled: true })
      });

      // Add utterance
      const addResponse = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance' })
      });
      const addData = await addResponse.json() as any;
      const utteranceId = addData.utterance.id;

      // Dequeue utterances
      await fetch(`${server.url}/api/dequeue-utterances`, {
        method: 'POST'
      });

      // Wait for delivered status change
      await waitForEvent('utterance-status-changed');

      // Clear events so we only see the responded status change
      receivedEvents.length = 0;

      // Speak (marks delivered utterances as responded)
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Response' })
      });

      // Wait for responded status change event
      const event = await waitForEvent('utterance-status-changed');

      expect(event.type).toBe('utterance-status-changed');
      expect(event.utterance.id).toBe(utteranceId);
      expect(event.utterance.status).toBe('responded');
    });
  });

  describe('utterance-deleted event', () => {
    it('should broadcast utterance-deleted event when pending utterance is deleted', async () => {
      await connectSSE();

      // Add utterance
      const addResponse = await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test utterance' })
      });
      const addData = await addResponse.json() as any;
      const utteranceId = addData.utterance.id;

      // Clear events
      receivedEvents.length = 0;

      // Delete utterance
      await fetch(`${server.url}/api/utterances/${utteranceId}`, {
        method: 'DELETE'
      });

      // Wait for deleted event
      const event = await waitForEvent('utterance-deleted');

      expect(event.type).toBe('utterance-deleted');
      expect(event.id).toBe(utteranceId);
    });
  });

  describe('queue-cleared event', () => {
    it('should broadcast queue-cleared event when all utterances are deleted', async () => {
      await connectSSE();

      // Add some utterances
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

      // Clear events
      receivedEvents.length = 0;

      // Clear queue
      await fetch(`${server.url}/api/utterances`, {
        method: 'DELETE'
      });

      // Wait for cleared event
      const event = await waitForEvent('queue-cleared');

      expect(event.type).toBe('queue-cleared');
    });
  });

  describe('Multiple clients', () => {
    it('should broadcast events to all connected clients', async () => {
      const client1Events: any[] = [];
      const client2Events: any[] = [];

      // Connect client 1
      const client1 = new EventSource(`${server.url}/api/events`);
      client1.onmessage = (event) => {
        client1Events.push(JSON.parse(event.data));
      };

      // Connect client 2
      const client2 = new EventSource(`${server.url}/api/events`);
      client2.onmessage = (event) => {
        client2Events.push(JSON.parse(event.data));
      };

      // Wait for both to connect
      await new Promise(resolve => setTimeout(resolve, 500));

      // Add utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Broadcast test' })
      });

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 500));

      // Both clients should receive the event
      const client1Added = client1Events.find(e => e.type === 'utterance-added');
      const client2Added = client2Events.find(e => e.type === 'utterance-added');

      expect(client1Added).toBeDefined();
      expect(client2Added).toBeDefined();
      expect(client1Added.utterance.text).toBe('Broadcast test');
      expect(client2Added.utterance.text).toBe('Broadcast test');

      client1.close();
      client2.close();
    });
  });
});
