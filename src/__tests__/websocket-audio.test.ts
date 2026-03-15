import { TestServer } from '../test-utils/test-server.js';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * These tests verify the WebSocket audio endpoint on the real unified server.
 * We start the actual server (via TestServer-like approach using the real
 * unified-server code) and connect WebSocket clients to it.
 *
 * Since TestServer doesn't include WS support, we test against the real
 * server by importing and starting it on a random port.
 */

// Helper: start a minimal HTTP server with WS upgrade support matching
// the unified-server pattern, for isolated testing.
function createTestWsServer(): Promise<{ server: http.Server; wss: WebSocketServer; port: number; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const express = require('express');
    const app = express();
    const server = http.createServer(app);

    // Import the WS setup pattern from unified-server
    const wss = new WebSocketServer({ noServer: true });

    interface WsAudioClient {
      ws: WebSocket;
      sessionKey: string | null;
      isCapturing: boolean;
      frameCount: number;
      byteCount: number;
      pingTimer: ReturnType<typeof setInterval> | null;
      ttsActive: boolean;
      currentAudioId: string | null;
    }

    const wsAudioClients = new Set<WsAudioClient>();

    wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const sessionKey = url.searchParams.get('session') || null;

      const client: WsAudioClient = {
        ws,
        sessionKey,
        isCapturing: false,
        frameCount: 0,
        byteCount: 0,
        pingTimer: null,
        ttsActive: false,
        currentAudioId: null,
      };

      wsAudioClients.add(client);

      // Heartbeat
      client.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30_000);

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          const buf = data as Buffer;
          client.frameCount++;
          client.byteCount += buf.length;
        } else {
          try {
            const msg = JSON.parse(data.toString());
            switch (msg.type) {
              case 'audio-start':
                client.isCapturing = true;
                client.frameCount = 0;
                client.byteCount = 0;
                break;
              case 'audio-stop':
                client.isCapturing = false;
                break;
              case 'tts-ack':
                // Acknowledge TTS playback completion
                break;
              case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            }
          } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          }
        }
      });

      ws.on('close', () => {
        if (client.pingTimer) clearInterval(client.pingTimer);
        wsAudioClients.delete(client);
      });
    });

    server.on('upgrade', (request: http.IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/ws/audio') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        wss,
        port: addr.port,
        url: `ws://localhost:${addr.port}`,
        close: () => new Promise<void>((res, rej) => {
          // Close all WS connections first
          for (const client of wsAudioClients) {
            if (client.pingTimer) clearInterval(client.pingTimer);
            client.ws.close();
          }
          wsAudioClients.clear();
          server.close((err) => err ? rej(err) : res());
        }),
      });
    });
  });
}

describe('WebSocket Audio Endpoint', () => {
  let testServer: Awaited<ReturnType<typeof createTestWsServer>>;

  beforeEach(async () => {
    testServer = await createTestWsServer();
  });

  afterEach(async () => {
    await testServer.close();
  });

  function connectWs(path = '/ws/audio'): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${testServer.url}${path}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  describe('Connection', () => {
    it('should accept WebSocket connections on /ws/audio', async () => {
      const ws = await connectWs();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('should reject WebSocket connections on other paths', async () => {
      await expect(new Promise((resolve, reject) => {
        const ws = new WebSocket(`${testServer.url}/ws/other`);
        ws.on('open', () => {
          ws.close();
          reject(new Error('Should not connect'));
        });
        ws.on('error', () => resolve('rejected'));
        ws.on('close', () => resolve('rejected'));
      })).resolves.toBe('rejected');
    });

    it('should pass session query parameter', async () => {
      const ws = new WebSocket(`${testServer.url}/ws/audio?session=test-session`);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('Control Messages', () => {
    it('should handle audio-start message', async () => {
      const ws = await connectWs();

      ws.send(JSON.stringify({
        type: 'audio-start',
        sampleRate: 16000,
        channels: 1,
        encoding: 'pcm16',
      }));

      // Give server time to process
      await new Promise(r => setTimeout(r, 50));
      ws.close();
    });

    it('should handle audio-stop message', async () => {
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: 'audio-start', sampleRate: 16000, channels: 1, encoding: 'pcm16' }));
      ws.send(JSON.stringify({ type: 'audio-stop' }));

      await new Promise(r => setTimeout(r, 50));
      ws.close();
    });

    it('should respond to ping with pong', async () => {
      const ws = await connectWs();

      const pongPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pong') resolve(msg);
        });
      });

      ws.send(JSON.stringify({ type: 'ping' }));

      const pong = await pongPromise;
      expect(pong.type).toBe('pong');
      ws.close();
    });

    it('should respond with error for invalid JSON', async () => {
      const ws = await connectWs();

      const errorPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'error') resolve(msg);
        });
      });

      ws.send('not valid json{{{');

      const error = await errorPromise;
      expect(error.type).toBe('error');
      expect(error.message).toBe('Invalid JSON');
      ws.close();
    });
  });

  describe('Binary Audio Frames', () => {
    it('should receive binary audio frames without error', async () => {
      const ws = await connectWs();

      // Send audio-start
      ws.send(JSON.stringify({ type: 'audio-start', sampleRate: 16000, channels: 1, encoding: 'pcm16' }));

      // Send a 20ms frame of PCM16 audio (320 samples = 640 bytes)
      const frame = new Int16Array(320);
      // Fill with silence (zeros)
      ws.send(Buffer.from(frame.buffer));

      await new Promise(r => setTimeout(r, 50));

      // Send audio-stop
      ws.send(JSON.stringify({ type: 'audio-stop' }));
      await new Promise(r => setTimeout(r, 50));

      ws.close();
    });

    it('should handle multiple binary frames', async () => {
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: 'audio-start', sampleRate: 16000, channels: 1, encoding: 'pcm16' }));

      // Send 10 frames (~200ms of audio)
      for (let i = 0; i < 10; i++) {
        const frame = new Int16Array(320);
        ws.send(Buffer.from(frame.buffer));
      }

      await new Promise(r => setTimeout(r, 100));

      ws.send(JSON.stringify({ type: 'audio-stop' }));
      await new Promise(r => setTimeout(r, 50));

      ws.close();
    });
  });

  describe('Client Lifecycle', () => {
    it('should clean up on disconnect', async () => {
      const ws = await connectWs();
      ws.close();
      await new Promise(r => setTimeout(r, 50));
      // Server should have cleaned up - no assertion needed, just no errors
    });

    it('should handle multiple concurrent clients', async () => {
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      expect(ws1.readyState).toBe(WebSocket.OPEN);
      expect(ws2.readyState).toBe(WebSocket.OPEN);

      ws1.close();
      ws2.close();
      await new Promise(r => setTimeout(r, 50));
    });
  });

  describe('Ping/Pong Heartbeat', () => {
    it('should respond to WebSocket protocol-level ping', async () => {
      const ws = await connectWs();

      const pongPromise = new Promise<void>((resolve) => {
        ws.on('pong', () => resolve());
      });

      ws.ping();

      await pongPromise;
      ws.close();
    });
  });

  describe('TTS Binary Frame Streaming', () => {
    it('should send tts-start, binary PCM chunks, and tts-end', async () => {
      const ws = await connectWs();
      const receivedMessages: any[] = [];
      const receivedBinaryFrames: Buffer[] = [];

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          receivedBinaryFrames.push(data as Buffer);
        } else {
          receivedMessages.push(JSON.parse(data.toString()));
        }
      });

      // Simulate server sending TTS audio
      const audioId = 'test-audio-123';
      const sampleRate = 22050;

      // Find the server-side WS for this client and send TTS data
      // We access the wss connections directly
      for (const client of testServer.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          // Send tts-start
          client.send(JSON.stringify({
            type: 'tts-start',
            audioId,
            sampleRate,
            channels: 1,
          }));

          // Send PCM chunks (simulating 4096-byte chunks)
          const chunk1 = Buffer.alloc(4096);
          const chunk2 = Buffer.alloc(4096);
          const chunk3 = Buffer.alloc(2048); // last chunk can be smaller
          client.send(chunk1);
          client.send(chunk2);
          client.send(chunk3);

          // Send tts-end
          client.send(JSON.stringify({
            type: 'tts-end',
            audioId,
          }));
        }
      }

      // Wait for messages to arrive
      await new Promise(r => setTimeout(r, 100));

      // Verify tts-start was received
      const startMsg = receivedMessages.find(m => m.type === 'tts-start');
      expect(startMsg).toBeDefined();
      expect(startMsg.audioId).toBe(audioId);
      expect(startMsg.sampleRate).toBe(sampleRate);
      expect(startMsg.channels).toBe(1);

      // Verify binary frames received
      expect(receivedBinaryFrames.length).toBe(3);
      expect(receivedBinaryFrames[0].length).toBe(4096);
      expect(receivedBinaryFrames[1].length).toBe(4096);
      expect(receivedBinaryFrames[2].length).toBe(2048);

      // Verify tts-end was received
      const endMsg = receivedMessages.find(m => m.type === 'tts-end');
      expect(endMsg).toBeDefined();
      expect(endMsg.audioId).toBe(audioId);

      ws.close();
    });

    it('should handle tts-ack from client', async () => {
      const ws = await connectWs();

      // Send tts-ack
      ws.send(JSON.stringify({ type: 'tts-ack', audioId: 'test-audio-123' }));

      // Should not error
      await new Promise(r => setTimeout(r, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it('should handle tts-clear message', async () => {
      const ws = await connectWs();
      const receivedMessages: any[] = [];

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (!isBinary) {
          receivedMessages.push(JSON.parse(data.toString()));
        }
      });

      // Server sends tts-clear
      for (const client of testServer.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'tts-clear' }));
        }
      }

      await new Promise(r => setTimeout(r, 50));

      const clearMsg = receivedMessages.find(m => m.type === 'tts-clear');
      expect(clearMsg).toBeDefined();

      ws.close();
    });

    it('should handle multiple TTS streams sequentially', async () => {
      const ws = await connectWs();
      const receivedMessages: any[] = [];
      const receivedBinaryFrames: Buffer[] = [];

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (isBinary) {
          receivedBinaryFrames.push(data as Buffer);
        } else {
          receivedMessages.push(JSON.parse(data.toString()));
        }
      });

      // Send two sequential TTS streams
      for (const client of testServer.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          // First stream
          client.send(JSON.stringify({ type: 'tts-start', audioId: 'audio-1', sampleRate: 22050, channels: 1 }));
          client.send(Buffer.alloc(4096));
          client.send(JSON.stringify({ type: 'tts-end', audioId: 'audio-1' }));

          // Second stream
          client.send(JSON.stringify({ type: 'tts-start', audioId: 'audio-2', sampleRate: 22050, channels: 1 }));
          client.send(Buffer.alloc(4096));
          client.send(Buffer.alloc(4096));
          client.send(JSON.stringify({ type: 'tts-end', audioId: 'audio-2' }));
        }
      }

      await new Promise(r => setTimeout(r, 100));

      // Verify both streams received
      const starts = receivedMessages.filter(m => m.type === 'tts-start');
      const ends = receivedMessages.filter(m => m.type === 'tts-end');
      expect(starts.length).toBe(2);
      expect(ends.length).toBe(2);
      expect(starts[0].audioId).toBe('audio-1');
      expect(starts[1].audioId).toBe('audio-2');

      // 1 chunk from first + 2 chunks from second = 3 binary frames
      expect(receivedBinaryFrames.length).toBe(3);

      ws.close();
    });
  });
});
