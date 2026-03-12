#!/usr/bin/env node

import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { debugLog } from './debug.js';
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

// Conversation message type for full conversation history
interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
  status?: 'pending' | 'delivered' | 'responded'; // Only for user messages
}

class UtteranceQueue {
  utterances: Utterance[] = [];
  messages: ConversationMessage[] = []; // Full conversation history

  add(text: string, timestamp?: Date): Utterance {
    const utterance: Utterance = {
      id: randomUUID(),
      text: text.trim(),
      timestamp: timestamp || new Date(),
      status: 'pending'
    };

    this.utterances.push(utterance);

    // Also add to conversation messages
    this.messages.push({
      id: utterance.id,
      role: 'user',
      text: utterance.text,
      timestamp: utterance.timestamp,
      status: utterance.status
    });

    debugLog(`[Queue] queued: "${utterance.text}"	[id: ${utterance.id}]`);
    return utterance;
  }

  addAssistantMessage(text: string): ConversationMessage {
    const message: ConversationMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: text.trim(),
      timestamp: new Date()
    };
    this.messages.push(message);
    debugLog(`[Queue] assistant message: "${message.text}"	[id: ${message.id}]`);
    return message;
  }

  getRecentMessages(limit: number = 50): ConversationMessage[] {
    return this.messages
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()) // Oldest first
      .slice(-limit); // Get last N messages
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

      // Sync status in messages array
      const message = this.messages.find(m => m.id === id && m.role === 'user');
      if (message) {
        message.status = 'delivered';
      }
    }
  }

  delete(id: string): boolean {
    const utterance = this.utterances.find(u => u.id === id);

    // Only allow deleting pending messages
    if (utterance && utterance.status === 'pending') {
      this.utterances = this.utterances.filter(u => u.id !== id);
      this.messages = this.messages.filter(m => m.id !== id);
      debugLog(`[Queue] Deleted pending message: "${utterance.text}"	[id: ${id}]`);
      return true;
    }

    return false;
  }

  clear(): void {
    const count = this.utterances.length;
    this.utterances = [];
    this.messages = []; // Clear conversation history too
    debugLog(`[Queue] Cleared ${count} utterances and conversation history`);
  }
}

// Determine if we're running in MCP-managed mode
const IS_MCP_MANAGED = process.argv.includes('--mcp-managed');

// Voice preferences (controlled by browser)
let voicePreferences = {
  voiceResponsesEnabled: false,
  voiceInputActive: false
};

// Multi-session state
// Composite key encoding: JSON.stringify([sessionId, agentId || "main"])
function compositeKey(sessionId: string, agentId?: string | null): string {
  return JSON.stringify([sessionId, agentId || 'main']);
}

// Per-session state
interface SessionState {
  key: string;
  sessionId: string;
  agentId: string | null;
  agentType: string | null;
  queue: UtteranceQueue;
  lastToolUseTimestamp: Date | null;
  lastSpeakTimestamp: Date | null;
  lastActivity: Date;
}

const sessions = new Map<string, SessionState>();
let activeCompositeKey: string | null = null;

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minute TTL

function getOrCreateSession(key: string, sessionId?: string, agentId?: string | null, agentType?: string | null): SessionState {
  let session = sessions.get(key);
  if (!session) {
    session = {
      key,
      sessionId: sessionId || 'default',
      agentId: agentId || null,
      agentType: agentType || null,
      queue: new UtteranceQueue(),
      lastToolUseTimestamp: null,
      lastSpeakTimestamp: null,
      lastActivity: new Date(),
    };
    sessions.set(key, session);
    debugLog(`[Session] Created: key=${key} session=${sessionId || 'default'} agent=${agentId || 'main'} type=${agentType || 'none'}`);
  }
  session.lastActivity = new Date();
  return session;
}

function getActiveSession(): SessionState {
  if (activeCompositeKey) {
    const session = sessions.get(activeCompositeKey);
    if (session) return session;
  }
  // Fallback: create/get default session without setting activeCompositeKey
  // (only hook endpoints should set activeCompositeKey via registerIfFirst)
  const defaultKey = compositeKey('default');
  return getOrCreateSession(defaultKey);
}

// Session TTL cleanup
function cleanupSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastActivity.getTime() > SESSION_TTL_MS) {
      sessions.delete(key);
      const wasActive = key === activeCompositeKey;
      if (wasActive) activeCompositeKey = null;
      debugLog(`[Session] TTL cleanup: key=${key} lastActivity=${session.lastActivity.toISOString()}`);
    }
  }
}

// Run session cleanup every 5 minutes
setInterval(cleanupSessions, 5 * 60 * 1000);

// Pre-speak text whitelist: text → { count, expiry }
// Global because MCP speak calls arrive without session identity.
// The pre-speak hook (which has identity) bridges this gap.
const speakWhitelist = new Map<string, { count: number; expiry: number }>();

const WHITELIST_TTL_MS = 5000; // 5 second TTL for whitelist entries

function addToWhitelist(text: string, key?: string): void {
  const existing = speakWhitelist.get(text);
  const expiry = Date.now() + WHITELIST_TTL_MS;
  if (existing) {
    existing.count++;
    existing.expiry = expiry;
  } else {
    speakWhitelist.set(text, { count: 1, expiry });
  }
  debugLog(`[Whitelist] Added: key=${key || 'unknown'} text="${text.slice(0, 30)}..." count=${speakWhitelist.get(text)!.count}`);
}

function checkWhitelist(text: string): boolean {
  cleanupWhitelist();
  const entry = speakWhitelist.get(text);
  if (entry && entry.count > 0) {
    entry.count--;
    if (entry.count === 0) {
      speakWhitelist.delete(text);
    }
    debugLog(`[Speak] Whitelist match: text="${text.slice(0, 30)}..." remaining=${entry.count}`);
    return true;
  }
  debugLog(`[Speak] Whitelist miss: text="${text.slice(0, 30)}..."`);
  return false;
}

function cleanupWhitelist(): void {
  const now = Date.now();
  for (const [text, entry] of speakWhitelist) {
    if (entry.expiry < now) {
      speakWhitelist.delete(text);
      debugLog(`[Whitelist] Expired "${text.substring(0, 50)}..."`);
    }
  }
}

// Run whitelist cleanup every 5 seconds
setInterval(cleanupWhitelist, WHITELIST_TTL_MS);

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

  const session = getActiveSession();
  const parsedTimestamp = timestamp ? new Date(timestamp) : undefined;
  const utterance = session.queue.add(text, parsedTimestamp);
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
  const session = getActiveSession();
  const utterances = session.queue.getRecent(limit);

  res.json({
    utterances: utterances.map(u => ({
      id: u.id,
      text: u.text,
      timestamp: u.timestamp,
      status: u.status,
    })),
  });
});

// GET /api/conversation - Returns full conversation history
app.get('/api/conversation', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const session = getActiveSession();
  const messages = session.queue.getRecentMessages(limit);

  res.json({
    messages: messages.map(m => ({
      id: m.id,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      status: m.status // Only present for user messages
    }))
  });
});

app.get('/api/utterances/status', (_req: Request, res: Response) => {
  const session = getActiveSession();
  const total = session.queue.utterances.length;
  const pending = session.queue.utterances.filter(u => u.status === 'pending').length;
  const delivered = session.queue.utterances.filter(u => u.status === 'delivered').length;

  res.json({
    total,
    pending,
    delivered,
  });
});

// Shared dequeue logic
function dequeueUtterancesCore(session?: SessionState) {
  const s = session || getActiveSession();
  // Always dequeue pending utterances regardless of voiceInputActive
  // This allows both typed and spoken messages to be dequeued
  const pendingUtterances = s.queue.utterances
    .filter(u => u.status === 'pending')
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Mark as delivered
  pendingUtterances.forEach(u => {
    s.queue.markDelivered(u.id);
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
  res.json(result);
});

// Shared wait for utterance logic
async function waitForUtteranceCore(session?: SessionState) {
  const s = session || getActiveSession();

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

  debugLog(`[WaitCore] Starting wait_for_utterance (${secondsToWait}s) session=${s.key}`);

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

    const pendingUtterances = s.queue.utterances.filter(
      u => u.status === 'pending'
    );

    if (pendingUtterances.length > 0) {
      // Found utterances

      // Sort by timestamp (oldest first)
      const sortedUtterances = pendingUtterances
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Mark utterances as delivered
      sortedUtterances.forEach(u => {
        s.queue.markDelivered(u.id);
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
  const session = getActiveSession();
  const pendingCount = session.queue.utterances.filter(u => u.status === 'pending').length;
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
  const session = getActiveSession();

  if (!action || !['tool-use', 'stop'].includes(action)) {
    res.status(400).json({ error: 'Invalid action. Must be "tool-use" or "stop"' });
    return;
  }

  // Only check for pending utterances if voice input is active
  if (voicePreferences.voiceInputActive) {
    const pendingUtterances = session.queue.utterances.filter(u => u.status === 'pending');
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
    const deliveredUtterances = session.queue.utterances.filter(u => u.status === 'delivered');
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
    if (session.queue.utterances.length > 0) {
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
function handleHookRequest(attemptedAction: 'tool' | 'speak' | 'stop' | 'post-tool', session?: SessionState): { decision: 'approve' | 'block', reason?: string } | Promise<{ decision: 'approve' | 'block', reason?: string }> {
  const s = session || getActiveSession();
  const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled;
  const voiceInputActive = voicePreferences.voiceInputActive;

  // 1. Check for pending utterances and auto-dequeue
  // Always check for pending utterances regardless of voiceInputActive
  // This allows typed messages to be dequeued even when mic is off
  const pendingUtterances = s.queue.utterances.filter(u => u.status === 'pending');
  if (pendingUtterances.length > 0) {
    // Always dequeue (dequeueUtterancesCore no longer requires voiceInputActive)
    const dequeueResult = dequeueUtterancesCore(s);

    if (dequeueResult.success && dequeueResult.utterances && dequeueResult.utterances.length > 0) {
      // Reverse to show oldest first
      const reversedUtterances = dequeueResult.utterances.reverse();

      return {
        decision: 'block',
        reason: formatVoiceUtterances(reversedUtterances)
      };
    }
  }

  // 2. Check for delivered utterances (when voice enabled)
  if (voiceResponsesEnabled) {
    const deliveredUtterances = s.queue.utterances.filter(u => u.status === 'delivered');
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
    s.lastToolUseTimestamp = new Date();
    return { decision: 'approve' };
  }

  // 4. Handle speak
  if (attemptedAction === 'speak') {
    return { decision: 'approve' };
  }

  // 5. Handle stop
  if (attemptedAction === 'stop') {
    // Check if must speak after tool use
    if (voiceResponsesEnabled && s.lastToolUseTimestamp &&
      (!s.lastSpeakTimestamp || s.lastSpeakTimestamp < s.lastToolUseTimestamp)) {
      return {
        decision: 'block',
        reason: 'Assistant must speak after using tools. Please use the speak tool to respond before proceeding.'
      };
    }

    // Auto-wait for utterances (only if voice input is active)
    if (voiceInputActive) {
      return (async () => {
        try {
          debugLog(`[Stop Hook] Auto-calling wait_for_utterance...`);
          const data = await waitForUtteranceCore(s);
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
          // Fail open on errors
          return {
            decision: 'approve' as const,
            reason: 'Auto-wait encountered an error, proceeding'
          };
        }
      })();
    }

    return {
      decision: 'approve',
      reason: 'No utterances since last timeout'
    };
  }

  // Default to approve (shouldn't reach here)
  return { decision: 'approve' };
}

// Parse composite key from hook request body and get/create session
function parseHookRequest(req: Request): { key: string; sessionId: string; agentId: string | null; session: SessionState } {
  const sessionId = req.body?.session_id || 'default';
  const agentId = req.body?.agent_id || null;
  const agentType = req.body?.agent_type || null;
  const key = compositeKey(sessionId, agentId);
  const session = getOrCreateSession(key, sessionId, agentId, agentType);
  return { key, sessionId, agentId, session };
}

// Pure check: is this key the active session?
function isActiveKey(key: string): boolean {
  return activeCompositeKey !== null && key === activeCompositeKey;
}

// Register the first session seen as active (separated from isActiveKey to avoid side effects)
function registerIfFirst(key: string): void {
  if (activeCompositeKey === null) {
    activeCompositeKey = key;
    debugLog(`[Session] Active changed: ${null} → ${key}`);
  }
}

// Log hook request body for debugging
function logHookRequest(req: Request, endpoint: string): void {
  const sessionId = req.body?.session_id || 'default';
  const agentId = req.body?.agent_id || null;
  const key = compositeKey(sessionId, agentId);
  const toolName = req.body?.tool_name;
  const active = isActiveKey(key) ? 'active' : 'inactive';
  debugLog(`[Hook] ${endpoint}: key=${key} active=${active === 'active'} tool=${toolName || 'n/a'}`);
}

// Dedicated hook endpoints that return in Claude's expected format
app.post('/api/hooks/stop', async (req: Request, res: Response) => {
  logHookRequest(req, 'stop');
  const { key, session } = parseHookRequest(req);
  registerIfFirst(key);

  // Inactive session: enforce "must speak after tool use" but skip voice input routing
  if (!isActiveKey(key)) {
    if (voicePreferences.voiceResponsesEnabled && session.lastToolUseTimestamp &&
      (!session.lastSpeakTimestamp || session.lastSpeakTimestamp < session.lastToolUseTimestamp)) {
      res.json({
        decision: 'block',
        reason: 'Assistant must use the speak tool to provide a response before stopping. Your voice output will be stored in session history.'
      });
      return;
    }
    debugLog(`[Hook] stop: key=${key} active=false (approve)`);
    res.json({ decision: 'approve' });
    return;
  }

  const result = await handleHookRequest('stop', session);
  res.json(result);
});

// Pre-speak hook endpoint
app.post('/api/hooks/pre-speak', (req: Request, res: Response) => {
  logHookRequest(req, 'pre-speak');
  const { key, session } = parseHookRequest(req);
  registerIfFirst(key);
  const toolInput = req.body?.tool_input;
  const speakText = toolInput?.text;

  // Active session: approve and whitelist the text
  if (isActiveKey(key)) {
    const result = handleHookRequest('speak', session);
    // If approved and we have text, add to whitelist
    if (speakText && (result as any).decision !== 'block') {
      addToWhitelist(speakText, key);
    }
    res.json(result);
    return;
  }

  // Inactive session: store in that session's conversation history, block TTS
  if (speakText) {
    session.queue.addAssistantMessage(speakText);
    session.lastSpeakTimestamp = new Date();
    debugLog(`[Speak] Stored for inactive session: key=${key} text="${speakText.slice(0, 30)}..."`);
  }
  res.json({
    decision: 'block',
    reason: 'Voice output stored in session history. TTS is routed to the active session only.'
  });
});

// Post-tool hook endpoint
app.post('/api/hooks/post-tool', (req: Request, res: Response) => {
  logHookRequest(req, 'post-tool');
  const { key, session } = parseHookRequest(req);
  registerIfFirst(key);

  // Inactive session: still track tool use but don't route voice
  if (!isActiveKey(key)) {
    session.lastToolUseTimestamp = new Date();
    debugLog(`[Hook] post-tool: key=${key} active=false (approve, tracking tool use)`);
    res.json({ decision: 'approve' });
    return;
  }

  const result = handleHookRequest('post-tool', session);
  res.json(result);
});

// API to clear all utterances
// Delete specific utterance by ID
app.delete('/api/utterances/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const session = getActiveSession();
  const deleted = session.queue.delete(id);

  if (deleted) {
    res.json({
      success: true,
      message: 'Message deleted'
    });
  } else {
    res.status(400).json({
      error: 'Only pending messages can be deleted',
      success: false
    });
  }
});

// Delete all utterances
app.delete('/api/utterances', (_req: Request, res: Response) => {
  const session = getActiveSession();
  const clearedCount = session.queue.utterances.length;
  session.queue.clear();

  res.json({
    success: true,
    message: `Cleared ${clearedCount} utterances`,
    clearedCount
  });
});

// Server-Sent Events for TTS notifications
// Map from client response to the session key it's viewing (null = active session)
const ttsClients = new Map<Response, string | null>();

app.get('/api/tts-events', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Tag connection with the session it wants to watch (default: active session)
  const sessionKey = (req.query.session as string) || null;

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  // Add client to map
  ttsClients.set(res, sessionKey);
  debugLog(`[SSE] Client connected: session=${sessionKey || 'active'}`);

  // Remove client on disconnect
  res.on('close', () => {
    const disconnectedSessionKey = ttsClients.get(res);
    ttsClients.delete(res);

    // If no clients remain, disable voice features
    if (ttsClients.size === 0) {
      debugLog(`[SSE] Client disconnected: session=${disconnectedSessionKey || 'active'} (last client, disabling voice)`);
      if (voicePreferences.voiceInputActive || voicePreferences.voiceResponsesEnabled) {
        debugLog(`[SSE] Voice features disabled - Input: ${voicePreferences.voiceInputActive} -> false, Responses: ${voicePreferences.voiceResponsesEnabled} -> false`);
        voicePreferences.voiceInputActive = false;
        voicePreferences.voiceResponsesEnabled = false;
      }
    } else {
      debugLog(`[SSE] Client disconnected: session=${disconnectedSessionKey || 'active'}`);
    }
  });
});

// Helper function to notify TTS clients viewing the active session
function notifyTTSClients(text: string) {
  const message = JSON.stringify({ type: 'speak', text, sessionKey: activeCompositeKey });
  ttsClients.forEach((viewingKey, client) => {
    // Send to clients watching the active session (null) or explicitly this session
    if (viewingKey === null || viewingKey === activeCompositeKey) {
      client.write(`data: ${message}\n\n`);
    }
  });
}

// Helper function to notify clients viewing the active session about wait status
function notifyWaitStatus(isWaiting: boolean) {
  const message = JSON.stringify({ type: 'waitStatus', isWaiting, sessionKey: activeCompositeKey });
  ttsClients.forEach((viewingKey, client) => {
    if (viewingKey === null || viewingKey === activeCompositeKey) {
      client.write(`data: ${message}\n\n`);
    }
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

// API for session management
app.get('/api/sessions', (_req: Request, res: Response) => {
  const sessionList = Array.from(sessions.values()).map(s => ({
    key: s.key,
    sessionId: s.sessionId,
    agentId: s.agentId,
    agentType: s.agentType,
    isActive: s.key === activeCompositeKey,
    lastActivity: s.lastActivity,
    utteranceCount: s.queue.utterances.length,
    messageCount: s.queue.messages.length,
    pendingCount: s.queue.utterances.filter(u => u.status === 'pending').length,
  }));

  res.json({
    sessions: sessionList,
    activeKey: activeCompositeKey,
  });
});

app.post('/api/active-session', (req: Request, res: Response) => {
  const { key } = req.body;

  if (!key || !sessions.has(key)) {
    res.status(400).json({ error: 'Invalid session key' });
    return;
  }

  const previousKey = activeCompositeKey;
  activeCompositeKey = key;
  debugLog(`[Session] Active changed: ${previousKey} → ${key}`);

  res.json({
    success: true,
    activeKey: activeCompositeKey,
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

  // Check whitelist: only speak if text was approved by pre-speak hook
  // Skip whitelist check if no multi-session is active (single session backward compat)
  if (activeCompositeKey !== null && !checkWhitelist(text)) {
    // checkWhitelist already logged the miss
    res.status(403).json({
      error: 'Speak not authorized',
      message: 'This text was not approved by the pre-speak hook for the active session'
    });
    return;
  }

  try {
    const session = getActiveSession();

    // Always notify browser clients - they decide how to speak
    notifyTTSClients(text);
    debugLog(`[Speak] Sent text to browser for TTS: "${text}"`);

    // Note: The browser will decide whether to use system voice or browser voice

    // Store assistant's response in conversation history
    session.queue.addAssistantMessage(text);

    // Mark all delivered utterances as responded
    const deliveredUtterances = session.queue.utterances.filter(u => u.status === 'delivered');
    deliveredUtterances.forEach(u => {
      u.status = 'responded';
      debugLog(`[Queue] marked as responded: "${u.text}"	[id: ${u.id}]`);

      // Sync status in messages array
      const message = session.queue.messages.find(m => m.id === u.id && m.role === 'user');
      if (message) {
        message.status = 'responded';
      }
    });

    session.lastSpeakTimestamp = new Date();

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

// UI Routing
app.get('/', (_req: Request, res: Response) => {
  // Default to messenger UI (now index.html, can be overridden with --legacy-ui flag)
  const useLegacyUI = process.env.MCP_VOICE_HOOKS_LEGACY_UI === 'true';
  const htmlFile = useLegacyUI ? 'legacy.html' : 'index.html';
  debugLog(`[HTTP] Serving ${htmlFile} for root route`);
  res.sendFile(path.join(__dirname, '..', 'public', htmlFile));
});

app.get('/legacy', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'legacy.html'));
});

app.get('/messenger', (_req: Request, res: Response) => {
  // Messenger is now the default index.html
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start HTTP server with EADDRINUSE handling for multi-session support
// Create server and attach error handler BEFORE listen to ensure proper event ordering
let eaddrinuseDetected = false;
const httpServer = http.createServer(app);

// Handle EADDRINUSE: another instance already owns the HTTP server.
// This process will run as MCP shim only, proxying speak calls to the existing server.
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    eaddrinuseDetected = true;
    const log = IS_MCP_MANAGED ? console.error : console.log;
    log(`[HTTP] Port ${HTTP_PORT} already in use — another instance owns the HTTP server`);
    log(`[HTTP] Running as MCP shim only, proxying to http://localhost:${HTTP_PORT}`);
  } else {
    // Re-throw unexpected errors
    throw err;
  }
});

httpServer.listen(HTTP_PORT, async () => {
  if (eaddrinuseDetected) return; // defensive guard

  // Log startup info with git hash and timestamp to file for debugging
  const { execSync } = await import('child_process');
  let gitHash = 'unknown';
  try { gitHash = execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname, encoding: 'utf-8' }).trim(); } catch {}
  const startupLine = `[${new Date().toISOString()}] mcp-voice-hooks started: git=${gitHash} port=${HTTP_PORT} mode=${IS_MCP_MANAGED ? 'mcp' : 'standalone'} features=[subagent-detection]`;
  try { const fs = await import('fs'); fs.appendFileSync('/tmp/mcp-voice-hooks.log', startupLine + '\n'); } catch {}

  if (!IS_MCP_MANAGED) {
    console.log(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
    console.log(`[Mode] Running in ${IS_MCP_MANAGED ? 'MCP-managed' : 'standalone'} mode`);
  } else {
    // In MCP mode, write to stderr to avoid interfering with protocol
    console.error(`[HTTP] Server listening on http://localhost:${HTTP_PORT}`);
    console.error(`[Mode] Running in MCP-managed mode`);
  }

  // Auto-open browser if no frontend connects within 3 seconds
  // Skip for secondary instances that detected EADDRINUSE
  const autoOpenBrowser = process.env.MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER !== 'false'; // Default to true
  if (IS_MCP_MANAGED && autoOpenBrowser) {
    setTimeout(async () => {
      if (ttsClients.size === 0) {
        debugLog('[Browser] No frontend connected, opening browser...');
        try {
          const open = (await import('open')).default;
          // Open default UI (messenger is now at root)
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
    // Only expose the speak tool - voice input is auto-delivered via hooks
    return {
      tools: [
        {
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
        }
      ]
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
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