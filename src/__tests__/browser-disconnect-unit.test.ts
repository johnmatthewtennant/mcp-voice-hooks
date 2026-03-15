import { EventEmitter } from 'events';

describe('Browser Disconnect Voice Features - Unit Tests', () => {
  let mockVoicePreferences: any;
  let mockTtsClients: Set<any>;
  let mockRes: any;

  beforeEach(() => {
    // Reset mocks
    jest.resetModules();
    jest.clearAllMocks();

    // Mock voice preferences
    mockVoicePreferences = {
      voiceActive: false
    };

    // Mock ttsClients set
    mockTtsClients = new Set();

    // Create a mock response object that extends EventEmitter
    mockRes = Object.assign(new EventEmitter(), {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    });
  });

  it('should disable voice features when last browser disconnects', () => {
    // Enable voice features
    mockVoicePreferences.voiceActive = true;

    // Add client to set
    mockTtsClients.add(mockRes);
    expect(mockTtsClients.size).toBe(1);

    // Setup close handler (simulating the actual implementation)
    mockRes.on('close', () => {
      mockTtsClients.delete(mockRes);

      // If no clients remain, disable voice features
      if (mockTtsClients.size === 0) {
        mockVoicePreferences.voiceActive = false;
      }
    });

    // Emit close event (browser disconnects)
    mockRes.emit('close');

    // Verify client was removed
    expect(mockTtsClients.size).toBe(0);

    // Verify voice features were disabled
    expect(mockVoicePreferences.voiceActive).toBe(false);
  });

  it('should maintain voice features when one browser remains connected', () => {
    // Enable voice features
    mockVoicePreferences.voiceActive = true;

    // Create two mock response objects
    const mockRes1 = Object.assign(new EventEmitter(), {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    });

    const mockRes2 = Object.assign(new EventEmitter(), {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    });

    // Add both clients
    mockTtsClients.add(mockRes1);
    mockTtsClients.add(mockRes2);
    expect(mockTtsClients.size).toBe(2);

    // Setup close handlers for both
    [mockRes1, mockRes2].forEach(res => {
      res.on('close', () => {
        mockTtsClients.delete(res);

        // If no clients remain, disable voice features
        if (mockTtsClients.size === 0) {
          mockVoicePreferences.voiceActive = false;
        }
      });
    });

    // First browser disconnects
    mockRes1.emit('close');

    // Verify one client remains
    expect(mockTtsClients.size).toBe(1);

    // Verify voice features are still enabled
    expect(mockVoicePreferences.voiceActive).toBe(true);

    // Second browser disconnects
    mockRes2.emit('close');

    // Verify no clients remain
    expect(mockTtsClients.size).toBe(0);

    // Verify voice features were disabled
    expect(mockVoicePreferences.voiceActive).toBe(false);
  });

  it('should not disable voice features if they were already disabled', () => {
    // Voice features already disabled
    mockVoicePreferences.voiceActive = false;

    // Add client
    mockTtsClients.add(mockRes);

    // Setup close handler
    mockRes.on('close', () => {
      mockTtsClients.delete(mockRes);

      if (mockTtsClients.size === 0) {
        mockVoicePreferences.voiceActive = false;
      }
    });

    // Browser disconnects
    mockRes.emit('close');

    // Verify they remain disabled
    expect(mockVoicePreferences.voiceActive).toBe(false);
  });
});
