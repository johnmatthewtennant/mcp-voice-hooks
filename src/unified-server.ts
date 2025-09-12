#!/usr/bin/env node

import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { debugLog } from './debug.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const WAIT_TIMEOUT_SECONDS = 60;
const HTTP_PORT = process.env.MCP_VOICE_HOOKS_PORT ? parseInt(process.env.MCP_VOICE_HOOKS_PORT) : 5111;
const AUTO_DELIVER_VOICE_INPUT = process.env.MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT !== 'false'; // Default to true (auto-deliver enabled)

// Promisified exec for async/await
const execAsync = promisify(exec);

// Function to play a sound notification
async function playNotificationSound() {
  try {
    // Use macOS system sound
    await execAsync('afplay /System/Library/Sounds/Funk.aiff');
    debugLog('[Sound] Played notification sound');
  } catch (error) {
    debugLog(`[Sound] Failed to play sound: ${error}`);
    // Don't throw - sound is not critical
  }
}

// Shared utterance queue
interface Utterance {
  id: string;
  text: string;
  timestamp: Date;
  status: 'pending' | 'delivered' | 'responded';
}

class UtteranceQueue {
  utterances: Utterance[] = [];

  add(text: string, timestamp?: Date): Utterance {
    const utterance: Utterance = {
      id: randomUUID(),
      text: text.trim(),
      timestamp: timestamp || new Date(),
      status: 'pending'
    };

    this.utterances.push(utterance);
    debugLog(`[Queue] queued: "${utterance.text}"	[id: ${utterance.id}]`);
    return utterance;
  }

  getRecent(limit: number = 10): Utterance[] {
    return this.utterances
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  markDelivered(id: string): void {
    const utterance = this.utterances.find(u => u.id === id);
    if (utterance) {
      utterance.status = 'delivered';
      debugLog(`[Queue] delivered: "${utterance.text}"	[id: ${id}]`);
    }
  }

  clear(): void {
    const count = this.utterances.length;
    this.utterances = [];
    debugLog(`[Queue] Cleared ${count} utterances`);
  }
}

// Determine if we're running in MCP-managed mode
const IS_MCP_MANAGED = process.argv.includes('--mcp-managed');

// Global state
const queue = new UtteranceQueue();
let lastToolUseTimestamp: Date | null = null;
let lastSpeakTimestamp: Date | null = null;

// Voice preferences (controlled by browser)
let voicePreferences = {
  voiceResponsesEnabled: false,
  voiceInputActive: false
};

// HTTP Server Setup (always created)
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.post('/api/potential-utterances', (req: Request, res: Response) => {
  const { text, timestamp } = req.body;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  const parsedTimestamp = timestamp ? new Date(timestamp) : undefined;
  const utterance = queue.add(text, parsedTimestamp);
  res.json({
    success: true,
    utterance: {
      id: utterance.id,
      text: utterance.text,
      timestamp: utterance.timestamp,
      status: utterance.status,
    },
  });
});

app.get('/api/utterances', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 10;
  const utterances = queue.getRecent(limit);

  res.json({
    utterances: utterances.map(u => ({
      id: u.id,
      text: u.text,
      timestamp: u.timestamp,
      status: u.status,
    })),
  });
});

app.get('/api/utterances/status', (_req: Request, res: Response) => {
  const total = queue.utterances.length;
  const pending = queue.utterances.filter(u => u.status === 'pending').length;
  const delivered = queue.utterances.filter(u => u.status === 'delivered').length;

  res.json({
    total,
    pending,
    delivered,
  });
});

// Shared dequeue logic
function dequeueUtterancesCore() {
  // Check if voice input is active
  if (!voicePreferences.voiceInputActive) {
    return {
      success: false,
      error: 'Voice input is not active. Cannot dequeue utterances when voice input is disabled.'
    };
  }

  const pendingUtterances = queue.utterances
    .filter(u => u.status === 'pending')
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Mark as delivered
  pendingUtterances.forEach(u => {
    queue.markDelivered(u.id);
  });

  return {
    success: true,
    utterances: pendingUtterances.map(u => ({
      text: u.text,
      timestamp: u.timestamp,
    })),
  };
}

// MCP server integration
app.post('/api/dequeue-utterances', (_req: Request, res: Response) => {
  const result = dequeueUtterancesCore();

  if (!result.success && result.error) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
});

// Shared wait for utterance logic
async function waitForUtteranceCore() {
  // Check if voice input is active
  if (!voicePreferences.voiceInputActive) {
    return {
      success: false,
      error: 'Voice input is not active. Cannot wait for utterances when voice input is disabled.'
    };
  }

  const secondsToWait = WAIT_TIMEOUT_SECONDS;
  const maxWaitMs = secondsToWait * 1000;
  const startTime = Date.now();

  debugLog(`[WaitCore] Starting wait_for_utterance (${secondsToWait}s)`);

  // Notify frontend that wait has started
  notifyWaitStatus(true);

  let firstTime = true;

  // Poll for utterances
  while (Date.now() - startTime < maxWaitMs) {
    // Check if voice input is still active
    if (!voicePreferences.voiceInputActive) {
      debugLog('[WaitCore] Voice input deactivated during wait_for_utterance');
      notifyWaitStatus(false); // Notify wait has ended
      return {
        success: true,
        utterances: [],
        message: 'Voice input was deactivated',
        waitTime: Date.now() - startTime,
      };
    }

    const pendingUtterances = queue.utterances.filter(
      u => u.status === 'pending'
    );

    if (pendingUtterances.length > 0) {
      // Found utterances

      // Sort by timestamp (oldest first)
      const sortedUtterances = pendingUtterances
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Mark utterances as delivered
      sortedUtterances.forEach(u => {
        queue.markDelivered(u.id);
      });

      notifyWaitStatus(false); // Notify wait has ended
      return {
        success: true,
        utterances: sortedUtterances.map(u => ({
          id: u.id,
          text: u.text,
          timestamp: u.timestamp,
          status: 'delivered', // They are now delivered
        })),
        count: pendingUtterances.length,
        waitTime: Date.now() - startTime,
      };
    }

    if (firstTime) {
      firstTime = false;
      // Play notification sound since we're about to start waiting
      await playNotificationSound();
    }

    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Timeout reached - no utterances found
  notifyWaitStatus(false); // Notify wait has ended
  return {
    success: true,
    utterances: [],
    message: `No utterances found after waiting ${secondsToWait} seconds.`,
    waitTime: maxWaitMs,
  };
}

// Wait for utterance endpoint
app.post('/api/wait-for-utterances', async (_req: Request, res: Response) => {
  const result = await waitForUtteranceCore();

  // If error response, return 400 status
  if (!result.success && result.error) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
});


// API for pre-tool hook to check for pending utterances
app.get('/api/has-pending-utterances', (_req: Request, res: Response) => {
  const pendingCount = queue.utterances.filter(u => u.status === 'pending').length;
  const hasPending = pendingCount > 0;

  res.json({
    hasPending,
    pendingCount
  });
});

// Unified action validation endpoint
app.post('/api/validate-action', (req: Request, res: Response) => {
  const { action } = req.body;
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;

  if (!action || !['tool-use', 'stop'].includes(action)) {
    res.status(400).json({ error: 'Invalid action. Must be "tool-use" or "stop"' });
    return;
  }

  // Only check for pending utterances if voice input is active
  if (voicePreferences.voiceInputActive) {
    const pendingUtterances = queue.utterances.filter(u => u.status === 'pending');
    if (pendingUtterances.length > 0) {
      res.json({
        allowed: false,
        requiredAction: 'dequeue_utterances',
        reason: `${pendingUtterances.length} pending utterance(s) must be dequeued first. Please use dequeue_utterances to process them.`
      });
      return;
    }
  }

  // Check for delivered but unresponded utterances (when voice enabled)
  if (voiceResponsesEnabled) {
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    if (deliveredUtterances.length > 0) {
      res.json({
        allowed: false,
        requiredAction: 'speak',
        reason: `${deliveredUtterances.length} delivered utterance(s) require voice response. Please use the speak tool to respond before proceeding.`
      });
      return;
    }
  }

  // For stop action, check if we should wait (only if voice input is active)
  if (action === 'stop' && voicePreferences.voiceInputActive) {
    if (queue.utterances.length > 0) {
      res.json({
        allowed: false,
        requiredAction: 'wait_for_utterance',
        reason: 'Assistant tried to end its response. Stopping is not allowed without first checking for voice input. Assistant should now use wait_for_utterance to check for voice input'
      });
      return;
    }
  }

  // All checks passed - action is allowed
  res.json({
    allowed: true
  });
});

// Unified hook handler
function handleHookRequest(attemptedAction: 'tool' | 'speak' | 'wait' | 'stop' | 'post-tool'): { decision: 'approve' | 'block', reason?: string } | Promise<{ decision: 'approve' | 'block', reason?: string }> {
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;
  const voiceInputActive = voicePreferences.voiceInputActive;

  // 1. Check for pending utterances (different behavior based on action and settings)
  if (voiceInputActive) {
    const pendingUtterances = queue.utterances.filter(u => u.status === 'pending');
    if (pendingUtterances.length > 0) {
      if (AUTO_DELIVER_VOICE_INPUT) {
        // Auto mode: auto-dequeue for all actions
        const dequeueResult = dequeueUtterancesCore();

        if (dequeueResult.success && dequeueResult.utterances && dequeueResult.utterances.length > 0) {
          // Reverse to show oldest first
          const reversedUtterances = dequeueResult.utterances.reverse();

          return {
            decision: 'block',
            reason: formatVoiceUtterances(reversedUtterances)
          };
        }
      } else {
        // Manual mode: always block and tell assistant to use dequeue_utterances tool
        return {
          decision: 'block',
          reason: `${pendingUtterances.length} pending utterance(s) available. Use the dequeue_utterances tool to retrieve them.`
        };
      }
    }
  }

  // 2. Check for delivered utterances (when voice enabled)
  if (voiceResponsesEnabled) {
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    if (deliveredUtterances.length > 0) {
      // Only allow speak to proceed
      if (attemptedAction === 'speak') {
        return { decision: 'approve' };
      }
      return {
        decision: 'block',
        reason: `${deliveredUtterances.length} delivered utterance(s) require voice response. Please use the speak tool to respond before proceeding.`
      };
    }
  }

  // 3. Handle tool and post-tool actions
  if (attemptedAction === 'tool' || attemptedAction === 'post-tool') {
    lastToolUseTimestamp = new Date();
    return { decision: 'approve' };
  }

  // 4. Handle wait for utterance
  if (attemptedAction === 'wait') {
    if (voiceResponsesEnabled && lastToolUseTimestamp &&
      (!lastSpeakTimestamp || lastSpeakTimestamp < lastToolUseTimestamp)) {
      return {
        decision: 'block',
        reason: 'Assistant must speak after using tools. Please use the speak tool to respond before waiting for utterances.'
      };
    }
    return { decision: 'approve' };
  }

  // 5. Handle speak
  if (attemptedAction === 'speak') {
    return { decision: 'approve' };
  }

  // 6. Handle stop
  if (attemptedAction === 'stop') {
    // Check if must speak after tool use
    if (voiceResponsesEnabled && lastToolUseTimestamp &&
      (!lastSpeakTimestamp || lastSpeakTimestamp < lastToolUseTimestamp)) {
      return {
        decision: 'block',
        reason: 'Assistant must speak after using tools. Please use the speak tool to respond before proceeding.'
      };
    }

    // Check if should wait for utterances (only if voice input is active)
    if (voiceInputActive) {
      if (AUTO_DELIVER_VOICE_INPUT) {
        // Auto-wait for utterances
        return (async () => {
          try {
            debugLog(`[Stop Hook] Auto-calling wait_for_utterance...`);
            const data = await waitForUtteranceCore();
            debugLog(`[Stop Hook] wait_for_utterance response: ${JSON.stringify(data)}`);

            // If error (voice input not active), treat as no utterances found
            if (!data.success && data.error) {
              return {
                decision: 'approve' as const,
                reason: data.error
              };
            }

            // If utterances were found, block and return them
            if (data.utterances && data.utterances.length > 0) {
              return {
                decision: 'block' as const,
                reason: formatVoiceUtterances(data.utterances)
              };
            }

            // If no utterances found (including when voice was deactivated), approve stop
            return {
              decision: 'approve' as const,
              reason: data.message || 'No utterances found during wait'
            };
          } catch (error) {
            debugLog(`[Stop Hook] Error calling wait_for_utterance: ${error}`);
            // In auto-deliver mode, fail open on errors
            return {
              decision: 'approve' as const,
              reason: 'Auto-wait encountered an error, proceeding'
            };
          }
        })();
      } else {
        // Manual mode: block and tell assistant to use wait_for_utterance tool
        return {
          decision: 'block',
          reason: 'Assistant tried to end its response, but voice input is active. Stopping is not allowed without first checking for voice input. Assistant should now use wait_for_utterance to check for voice input'
        };
      }
    }

    return {
      decision: 'approve',
      reason: 'No utterances since last timeout'
    };
  }

  // Default to approve (shouldn't reach here)
  return { decision: 'approve' };
}

// Dedicated hook endpoints that return in Claude's expected format
app.post('/api/hooks/stop', async (_req: Request, res: Response) => {
  const result = await handleHookRequest('stop');
  res.json(result);
});

// Pre-speak hook endpoint
app.post('/api/hooks/pre-speak', (_req: Request, res: Response) => {
  const result = handleHookRequest('speak');
  res.json(result);
});

// Pre-wait hook endpoint
app.post('/api/hooks/pre-wait', (_req: Request, res: Response) => {
  const result = handleHookRequest('wait');
  res.json(result);
});

// Post-tool hook endpoint
app.post('/api/hooks/post-tool', (_req: Request, res: Response) => {
  // Use the unified handler with 'post-tool' action
  const result = handleHookRequest('post-tool');
  res.json(result);
});

// API to clear all utterances
app.delete('/api/utterances', (_req: Request, res: Response) => {
  const clearedCount = queue.utterances.length;
  queue.clear();

  res.json({
    success: true,
    message: `Cleared ${clearedCount} utterances`,
    clearedCount
  });
});

// Server-Sent Events for TTS notifications
const ttsClients = new Set<Response>();

app.get('/api/tts-events', (_req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  // Add client to set
  ttsClients.add(res);

  // Remove client on disconnect
  res.on('close', () => {
    ttsClients.delete(res);
    
    // If no clients remain, disable voice features
    if (ttsClients.size === 0) {
      debugLog('[SSE] Last browser disconnected, disabling voice features');
      if (voicePreferences.voiceInputActive || voicePreferences.voiceResponsesEnabled) {
        debugLog(`[SSE] Voice features disabled - Input: ${voicePreferences.voiceInputActive} -> false, Responses: ${voicePreferences.voiceResponsesEnabled} -> false`);
        voicePreferences.voiceInputActive = false;
        voicePreferences.voiceResponsesEnabled = false;
      }
    } else {
      debugLog(`[SSE] Browser disconnected, ${ttsClients.size} client(s) remaining`);
    }
  });
});

// Helper function to notify all connected TTS clients
function notifyTTSClients(text: string) {
  const message = JSON.stringify({ type: 'speak', text });
  ttsClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

// Helper function to notify all connected clients about wait status
function notifyWaitStatus(isWaiting: boolean) {
  const message = JSON.stringify({ type: 'waitStatus', isWaiting });
  ttsClients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

// Helper function to format voice utterances for display
function formatVoiceUtterances(utterances: any[]): string {
  const utteranceTexts = utterances
    .map(u => `"${u.text}"`)
    .join('\n');

  return `Assistant received voice input from the user (${utterances.length} utterance${utterances.length !== 1 ? 's' : ''}):\n\n${utteranceTexts}${getVoiceResponseReminder()}`;
}

// API for voice preferences
app.post('/api/voice-preferences', (req: Request, res: Response) => {
  const { voiceResponsesEnabled } = req.body;

  // Update preferences
  voicePreferences.voiceResponsesEnabled = !!voiceResponsesEnabled;

  debugLog(`[Preferences] Updated: voiceResponses=${voicePreferences.voiceResponsesEnabled}`);

  res.json({
    success: true,
    preferences: voicePreferences
  });
});

// API for voice input state
app.post('/api/voice-input-state', (req: Request, res: Response) => {
  const { active } = req.body;

  // Update voice input state
  voicePreferences.voiceInputActive = !!active;

  debugLog(`[Voice Input] ${voicePreferences.voiceInputActive ? 'Started' : 'Stopped'} listening`);

  res.json({
    success: true,
    voiceInputActive: voicePreferences.voiceInputActive
  });
});

// API for text-to-speech
app.post('/api/speak', async (req: Request, res: Response) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  // Check if voice responses are enabled
  if (!voicePreferences.voiceResponsesEnabled) {
    debugLog(`[Speak] Voice responses disabled, returning error`);
    res.status(400).json({
      error: 'Voice responses are disabled',
      message: 'Cannot speak when voice responses are disabled'
    });
    return;
  }

  try {
    // Always notify browser clients - they decide how to speak
    notifyTTSClients(text);
    debugLog(`[Speak] Sent text to browser for TTS: "${text}"`);

    // Note: The browser will decide whether to use system voice or browser voice

    // Mark all delivered utterances as responded
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    deliveredUtterances.forEach(u => {
      u.status = 'responded';
      debugLog(`[Queue] marked as responded: "${u.text}"	[id: ${u.id}]`);
    });

    lastSpeakTimestamp = new Date();

    res.json({
      success: true,
      message: 'Text spoken successfully',
      respondedCount: deliveredUtterances.length
    });
  } catch (error) {
    debugLog(`[Speak] Failed to speak text: ${error}`);
    res.status(500).json({
      error: 'Failed to speak text',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// API for system text-to-speech (always uses Mac say command)
app.post('/api/speak-system', async (req: Request, res: Response) => {
  const { text, rate = 150 } = req.body;

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  try {
    // Execute text-to-speech using macOS say command
    // Note: Mac say command doesn't support volume control
    await execAsync(`say -r ${rate} "${text.replace(/"/g, '\\"')}"`);
    debugLog(`[Speak System] Spoke text using macOS say: "${text}" (rate: ${rate})`);

    res.json({
      success: true,
      message: 'Text spoken successfully via system voice'
    });
  } catch (error) {
    debugLog(`[Speak System] Failed to speak text: ${error}`);
    res.status(500).json({
      error: 'Failed to speak text via system voice',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start HTTP server
app.listen(HTTP_PORT, async () => {
  if (!IS_MCP_MANAGED) {
    console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
    console.log(`[Mode] Running in ${IS_MCP_MANAGED ? 'MCP-managed' : 'standalone'} mode`);
    console.log(`[Auto-deliver] Voice input auto-delivery is ${AUTO_DELIVER_VOICE_INPUT ? 'enabled (tools hidden)' : 'disabled (tools shown)'}`);
  } else {
    // In MCP mode, write to stderr to avoid interfering with protocol
    console.error(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
    console.error(`[Mode] Running in MCP-managed mode`);
    console.error(`[Auto-deliver] Voice input auto-delivery is ${AUTO_DELIVER_VOICE_INPUT ? 'enabled (tools hidden)' : 'disabled (tools shown)'}`);
  }

  // Auto-open browser if no frontend connects within 3 seconds
  const autoOpenBrowser = process.env.MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER !== 'false'; // Default to true
  if (IS_MCP_MANAGED && autoOpenBrowser) {
    setTimeout(async () => {
      if (ttsClients.size === 0) {
        debugLog('[Browser] No frontend connected, opening browser...');
        try {
          const open = (await import('open')).default;
          await open(`http://localhost:${HTTP_PORT}`);
        } catch (error) {
          debugLog('[Browser] Failed to open browser:', error);
        }
      } else {
        debugLog(`[Browser] Frontend already connected (${ttsClients.size} client(s))`)
      }
    }, 3000);
  }
});

// Helper function to get voice response reminder
function getVoiceResponseReminder(): string {
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;
  return voiceResponsesEnabled
    ? '\n\nThe user has enabled voice responses, so use the \'speak\' tool to respond to the user\'s voice input before proceeding.'
    : '';
}

// MCP Server Setup (only if MCP-managed)
if (IS_MCP_MANAGED) {
  // Use stderr in MCP mode to avoid interfering with protocol
  console.error('[MCP] Initializing MCP server...');

  const mcpServer = new Server(
    {
      name: 'voice-hooks',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool handlers
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];

    // Only show dequeue_utterances and wait_for_utterance if auto-deliver is disabled
    if (!AUTO_DELIVER_VOICE_INPUT) {
      tools.push(
        {
          name: 'dequeue_utterances',
          description: 'Dequeue pending utterances and mark them as delivered',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'wait_for_utterance',
          description: 'Wait for an utterance to be available or until timeout',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        }
      );
    }

    // Always show the speak tool
    tools.push({
      name: 'speak',
      description: 'Speak text using text-to-speech and mark delivered utterances as responded',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to speak',
          },
        },
        required: ['text'],
      },
    });

    return { tools };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'dequeue_utterances') {
        const response = await fetch(`http://localhost:${HTTP_PORT}/api/dequeue-utterances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        const data = await response.json() as any;

        // Check if the request was successful
        if (!response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${data.error || 'Failed to dequeue utterances'}`,
              },
            ],
          };
        }

        if (data.utterances.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No recent utterances found.',
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Dequeued ${data.utterances.length} utterance(s):\n\n${data.utterances.reverse().map((u: any) => `"${u.text}"\t[time: ${new Date(u.timestamp).toISOString()}]`).join('\n')
                }${getVoiceResponseReminder()}`,
            },
          ],
        };
      }

      if (name === 'wait_for_utterance') {
        debugLog(`[MCP] Calling wait_for_utterance`);

        const response = await fetch(`http://localhost:${HTTP_PORT}/api/wait-for-utterances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        const data = await response.json() as any;

        // Check if the request was successful
        if (!response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${data.error || 'Failed to wait for utterances'}`,
              },
            ],
          };
        }

        if (data.utterances && data.utterances.length > 0) {
          const utteranceTexts = data.utterances
            .map((u: any) => `[${u.timestamp}] "${u.text}"`)
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `Found ${data.count} utterance(s):\n\n${utteranceTexts}${getVoiceResponseReminder()}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: data.message || `No utterances found. Timed out.`,
              },
            ],
          };
        }
      }

      if (name === 'speak') {
        const text = args?.text as string;

        if (!text || !text.trim()) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: Text is required for speak tool',
              },
            ],
            isError: true,
          };
        }

        const response = await fetch(`http://localhost:${HTTP_PORT}/api/speak`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });

        const data = await response.json() as any;

        if (response.ok) {
          return {
            content: [
              {
                type: 'text',
                text: '',  // Return empty string for success
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Error speaking text: ${data.error || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  mcpServer.connect(transport);
  // Use stderr in MCP mode to avoid interfering with protocol
  console.error('[MCP] Server connected via stdio');
} else {
  // Only log in standalone mode
  if (!IS_MCP_MANAGED) {
    console.log('[MCP] Skipping MCP server initialization (not in MCP-managed mode)');
  }
}