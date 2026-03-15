import { EventEmitter } from 'events';

describe('Connection-drop timeout - Unit Tests', () => {
  let serverEvents: EventEmitter;
  let voicePreferences: { voiceInputActive: boolean; voiceResponsesEnabled: boolean };
  let ttsClients: Map<any, string | null>;

  beforeEach(() => {
    serverEvents = new EventEmitter();
    voicePreferences = { voiceInputActive: true, voiceResponsesEnabled: false };
    ttsClients = new Map();
  });

  /**
   * Simulates the polling sleep from waitForUtteranceCore:
   * resolves after 100ms OR immediately when allClientsDisconnected fires.
   */
  function interruptibleSleep(): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        serverEvents.removeListener('allClientsDisconnected', onDisconnect);
        resolve();
      }, 100);
      const onDisconnect = () => {
        clearTimeout(timer);
        resolve();
      };
      serverEvents.once('allClientsDisconnected', onDisconnect);
    });
  }

  /**
   * Simulates the SSE close handler logic from unified-server.ts
   */
  function simulateClientDisconnect(client: any) {
    const _sessionKey = ttsClients.get(client);
    ttsClients.delete(client);

    if (ttsClients.size === 0) {
      voicePreferences.voiceInputActive = false;
      voicePreferences.voiceResponsesEnabled = false;
      serverEvents.emit('allClientsDisconnected');
    }
  }

  it('should wake immediately when allClientsDisconnected is emitted', async () => {
    const start = Date.now();

    // Emit disconnect after 10ms
    setTimeout(() => serverEvents.emit('allClientsDisconnected'), 10);

    await interruptibleSleep();

    const elapsed = Date.now() - start;
    // Should resolve much faster than the 100ms timer
    expect(elapsed).toBeLessThan(50);
  });

  it('should wait full 100ms when no disconnect happens', async () => {
    const start = Date.now();

    await interruptibleSleep();

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('should clean up event listener after normal timeout', async () => {
    await interruptibleSleep();

    // Listener should be cleaned up
    expect(serverEvents.listenerCount('allClientsDisconnected')).toBe(0);
  });

  it('should clean up timer after disconnect event', async () => {
    setTimeout(() => serverEvents.emit('allClientsDisconnected'), 5);
    await interruptibleSleep();

    // Listener should be cleaned up
    expect(serverEvents.listenerCount('allClientsDisconnected')).toBe(0);
  });

  it('should interrupt wait loop when last SSE client disconnects', async () => {
    const client1 = { id: 'client1' };
    const client2 = { id: 'client2' };
    ttsClients.set(client1, null);
    ttsClients.set(client2, null);

    const start = Date.now();

    // Start waiting
    const waitPromise = interruptibleSleep();

    // First client disconnects — should NOT interrupt (one client remains)
    simulateClientDisconnect(client1);
    expect(ttsClients.size).toBe(1);
    expect(voicePreferences.voiceInputActive).toBe(true);

    // Second client disconnects after 10ms — should interrupt
    setTimeout(() => simulateClientDisconnect(client2), 10);

    await waitPromise;

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(voicePreferences.voiceInputActive).toBe(false);
    expect(ttsClients.size).toBe(0);
  });

  it('should exit wait loop early when voice input deactivated on disconnect', async () => {
    const client = { id: 'client' };
    ttsClients.set(client, null);

    // Simulate a simplified wait loop (2 iterations max)
    let iterations = 0;
    const maxIterations = 100; // would take 10s without interrupt

    const loopPromise = (async () => {
      while (iterations < maxIterations) {
        // Check voice input (same as waitForUtteranceCore)
        if (!voicePreferences.voiceInputActive) {
          return 'voice_deactivated';
        }
        iterations++;
        await interruptibleSleep();
      }
      return 'max_iterations';
    })();

    // Disconnect after 15ms
    setTimeout(() => simulateClientDisconnect(client), 15);

    const result = await loopPromise;

    expect(result).toBe('voice_deactivated');
    // Should have run very few iterations (disconnect wakes the sleep immediately,
    // next loop iteration sees voiceInputActive=false)
    expect(iterations).toBeLessThanOrEqual(2);
  });
});
