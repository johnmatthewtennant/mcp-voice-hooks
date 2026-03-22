#!/usr/bin/env node

import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFile, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { debugLog } from './debug.js';
import { SpeechRecognizer } from './speech-recognition.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const WAIT_TIMEOUT_SECONDS = 300; // 5-minute safety net; primary exit is browser disconnect
const HTTP_PORT = process.env.MCP_VOICE_HOOKS_PORT ? parseInt(process.env.MCP_VOICE_HOOKS_PORT) : 5111;
const HTTPS_PORT = process.env.MCP_VOICE_HOOKS_HTTPS_PORT ? parseInt(process.env.MCP_VOICE_HOOKS_HTTPS_PORT) : HTTP_PORT + 1;

// Server-wide event emitter for cross-component signals
const serverEvents = new EventEmitter();

// TTS audio queue - serializes say -o renders to prevent CPU overload
interface TtsQueueItem {
  text: string;
  rate: number;
  sessionKey: string | null;
  resolve: (audioId: string) => void;
  reject: (err: Error) => void;
}
const ttsQueue: TtsQueueItem[] = [];
let ttsPlaying = false;
let ttsCurrentProcess: ChildProcess | null = null;
// Track pending TTS ack promises — resolved when browser confirms playback complete
const pendingTtsAcks = new Map<string, () => void>();
const TTS_ACK_TIMEOUT_MS = 30_000; // Give up waiting after 30s

function waitForTtsAck(audioId: string): Promise<void> {
  return new Promise((resolve) => {
    pendingTtsAcks.set(audioId, resolve);
    // Timeout fallback — don't block forever if ack never arrives
    setTimeout(() => {
      if (pendingTtsAcks.has(audioId)) {
        pendingTtsAcks.delete(audioId);
        debugLog(`[TTS] Ack timeout for audioId=${audioId}, proceeding`);
        resolve();
      }
    }, TTS_ACK_TIMEOUT_MS);
  });
}

async function processTtsQueue() {
  if (ttsPlaying || ttsQueue.length === 0) return;
  ttsPlaying = true;
  const item = ttsQueue.shift()!;
  try {
    const { audioId, filePath } = await renderTtsToFile(item.text, item.rate);
    // Check if a WS client is connected for this session — prefer WS delivery
    const targetKey = item.sessionKey || activeCompositeKey;
    const wsClient = findWsClientForSession(targetKey);
    if (wsClient && wsClient.ws.readyState === WebSocket.OPEN) {
      serverAudioState.setTtsActive(true);
      await streamTtsOverWs(wsClient, filePath, audioId, 'tts');
      // Wait for browser to confirm playback is complete (tts-ack)
      // before clearing ttsActive — streaming finishes faster than playback
      await waitForTtsAck(audioId);
      serverAudioState.setTtsActive(false);
    } else {
      debugLog(`[TTS] No WebSocket client found for session — skipping audio delivery (text already sent via SSE)`);
    }
    item.resolve(audioId);
  } catch (error) {
    serverAudioState.setTtsActive(false);
    item.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    ttsPlaying = false;
    processTtsQueue();
  }
}

function enqueueTts(text: string, rate: number, sessionKey: string | null = null): Promise<string> {
  return new Promise((resolve, reject) => {
    ttsQueue.push({ text, rate, sessionKey, resolve, reject });
    processTtsQueue();
  });
}

function clearTtsQueue() {
  // Kill any currently running say -o render process
  if (ttsCurrentProcess) {
    ttsCurrentProcess.kill();
    ttsCurrentProcess = null;
  }
  // Reject all pending items and clean up their rendered files
  while (ttsQueue.length > 0) {
    const item = ttsQueue.shift()!;
    item.reject(new Error('TTS queue cleared'));
  }
  ttsPlaying = false;
  // Notify browser to clear its audio playback queue
  notifyTTSClear();
  debugLog('[TTS Queue] Cleared');
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
const NO_TRANSCRIBE = process.argv.includes('--no-transcribe') || process.env.MCP_VOICE_HOOKS_NO_TRANSCRIBE === 'true';
const SPEECH_RECOGNIZER_AVAILABLE = !NO_TRANSCRIBE && SpeechRecognizer.binaryExists(path.join(__dirname, '..'));

// Voice preferences (controlled by browser)
let voicePreferences = {
  voiceActive: false,
  selectedVoice: 'browser' as string,  // 'system' or 'browser:N'
  speechRate: 200 as number,  // words per minute for say -o rendering
  feedbackSoundMode: 'continuous' as 'once' | 'continuous' | 'off'
};

// Render TTS to WAV file using say -o (uncompressed PCM for best quality)
function renderTtsToFile(text: string, rate: number): Promise<{ filePath: string; audioId: string }> {
  const audioId = randomUUID();
  const filePath = `/tmp/mcp-voice-hooks-tts-${audioId}.wav`;
  const clampedRate = Math.max(50, Math.min(500, Math.round(rate)));

  return new Promise((resolve, reject) => {
    ttsCurrentProcess = execFile('say', ['-r', String(clampedRate), '-o', filePath, '--file-format', 'WAVE', '--data-format', 'LEI16@22050', text], (error) => {
      ttsCurrentProcess = null;
      if (error) {
        // Clean up temp file on error
        fs.unlink(filePath, () => {});
        reject(error);
      } else {
        debugLog(`[TTS Render] Rendered to ${filePath} (rate: ${clampedRate})`);
        resolve({ filePath, audioId });
      }
    });
  });
}

// Pre-rendered sound effects — generated at startup, streamed on demand
interface SoundLibrary {
  chime: string | null;           // path to chime WAV
  listeningPulse: string | null;  // path to listening pulse WAV
  processingPulse: string | null; // path to processing pulse WAV
}

const sounds: SoundLibrary = {
  chime: null,
  listeningPulse: null,
  processingPulse: null,
};

let soundsDir: string | null = null;

// Convert a macOS system sound to WAV PCM16@22050Hz mono using afconvert (built-in, no dependencies)
function convertSystemSound(sourceName: string, destPath: string): Promise<void> {
  const source = `/System/Library/Sounds/${sourceName}.aiff`;
  return new Promise((resolve, reject) => {
    execFile('afconvert', [source, destPath, '-d', 'LEI16@22050', '-c', '1', '-f', 'WAVE'], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Scale PCM16 samples in a WAV file by a volume factor (0.0–1.0)
function scaleWavVolume(wavPath: string, volume: number): void {
  const buf = fs.readFileSync(wavPath);
  const dataOffset = findWavDataOffset(buf);
  for (let i = dataOffset; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    buf.writeInt16LE(Math.round(sample * volume), i);
  }
  fs.writeFileSync(wavPath, buf);
}

async function generateSounds(): Promise<void> {
  // Create per-process temp directory
  soundsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-voice-hooks-sounds-'));
  await fs.promises.chmod(soundsDir, 0o700);

  // Convert macOS system sounds to WAV (PCM16@22050Hz mono, matching TTS pipeline)
  // Scale volume to ~40% so feedback sounds are subtle and don't overpower TTS
  const SFX_VOLUME = 0.4;

  const chimePath = path.join(soundsDir, 'chime.wav');
  await convertSystemSound('Tink', chimePath);
  scaleWavVolume(chimePath, SFX_VOLUME);
  sounds.chime = chimePath;

  const listeningPath = path.join(soundsDir, 'listening-pulse.wav');
  await convertSystemSound('Purr', listeningPath);
  scaleWavVolume(listeningPath, SFX_VOLUME);
  sounds.listeningPulse = listeningPath;

  const processingPath = path.join(soundsDir, 'processing-pulse.wav');
  await convertSystemSound('Pop', processingPath);
  scaleWavVolume(processingPath, SFX_VOLUME);
  sounds.processingPulse = processingPath;

  debugLog(`[Sounds] Converted system sounds (Tink, Purr, Pop) to ${soundsDir}`);
}

// Cleanup sounds directory on shutdown
function cleanupSounds(): void {
  if (soundsDir) {
    fs.rmSync(soundsDir, { recursive: true, force: true });
    soundsDir = null;
  }
}
// Register cleanup on process exit
process.on('exit', cleanupSounds);
process.on('SIGINT', () => { cleanupSounds(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSounds(); process.exit(0); });

// Server-side audio state machine — mirrors browser VoiceStateMachine logic
// but plays sounds by streaming pre-rendered WAV files over WebSocket
class ServerAudioState {
  static _sfxCounter = 0; // monotonic counter for unique SFX audioIds
  state: 'inactive' | 'listening' | 'processing' | 'speaking' = 'inactive';
  private _isListening = false;
  private _waitStatusKnown = false;
  private _lastWaitStatus = false;
  private _ttsActive = false;
  private _hookActive = false;
  private _pulseTimer: ReturnType<typeof setInterval> | null = null;

  syncState(): void {
    let desired: typeof this.state;
    // Order matters: hookActive check must come before plain !_isListening check.
    // When hooks are firing but voice is off, show processing.
    if (this._hookActive && !this._isListening) {
      desired = 'processing';
    } else if (!this._isListening) {
      desired = 'inactive';
    } else if (this._ttsActive) {
      desired = 'speaking';
    } else if (!this._waitStatusKnown) {
      desired = 'inactive';
    } else if (this._lastWaitStatus) {
      desired = 'listening';
    } else {
      desired = 'processing';
    }
    if (desired !== this.state) {
      this._transition(desired);
    }
  }

  setHookActive(active: boolean): void {
    this._hookActive = active;
    this.syncState();
  }

  // Silently clear hookActive without triggering syncState/broadcast.
  // Used before broadcasting 'stopped' to avoid an intermediate 'inactive' broadcast.
  clearHookActiveSilent(): void {
    this._hookActive = false;
  }

  setListening(isListening: boolean): void {
    this._isListening = isListening;
    if (isListening) {
      this._lastWaitStatus = false;
      this._waitStatusKnown = false;
      this._ttsActive = false;
      this._hookActive = false; // Clear stale hook state on voice activation
    }
    this.syncState();
  }

  setWaitStatus(isWaiting: boolean): void {
    this._waitStatusKnown = true;
    this._lastWaitStatus = isWaiting;
    this.syncState();
  }

  setTtsActive(active: boolean): void {
    this._ttsActive = active;
    this.syncState();
  }

  // Callback for broadcasting state changes to SSE clients.
  // Set after ttsClients is initialised (see broadcastVoiceState helper).
  onStateChange: ((state: string) => void) | null = null;

  private _transition(newState: typeof this.state): void {
    const oldState = this.state;
    this.state = newState;
    this._stopPulseTimer();

    debugLog(`[ServerAudio] ${oldState} -> ${newState}`);

    // Broadcast state to browser clients
    this.onStateChange?.(newState);

    switch (newState) {
      case 'inactive':
        break;

      case 'listening':
        this._startPulseTimer('listening');
        break;

      case 'processing':
        this._startPulseTimer('processing');
        break;

      case 'speaking':
        // No sounds during TTS
        break;
    }
  }

  private _startPulseTimer(type: 'listening' | 'processing'): void {
    const mode = voicePreferences.feedbackSoundMode;
    if (mode === 'off') return;

    const soundKey = type === 'listening' ? 'listeningPulse' : 'processingPulse';

    // Play first pulse immediately
    this._streamSound(soundKey);

    if (mode === 'continuous') {
      const interval = type === 'listening' ? 7000 : 5000;
      this._pulseTimer = setInterval(() => {
        if (this.state !== type) {
          this._stopPulseTimer();
          return;
        }
        this._streamSound(soundKey);
      }, interval);
    }
    // 'once' mode: first pulse already played, no interval needed
  }

  private _stopPulseTimer(): void {
    if (this._pulseTimer !== null) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = null;
    }
  }

  reapplyFeedbackMode(): void {
    // Only relevant if currently in a state that plays sounds
    if (this.state === 'listening' || this.state === 'processing') {
      this._stopPulseTimer();
      this._startPulseTimer(this.state);
    }
  }

  private _streamSound(soundKey: keyof SoundLibrary): void {
    const filePath = sounds[soundKey];
    if (!filePath) return;

    // Find a connected WS client to stream to
    const targetKey = activeCompositeKey;
    const wsClient = findWsClientForSession(targetKey);
    if (!wsClient || wsClient.ws.readyState !== WebSocket.OPEN) return;

    // Stream the pre-rendered WAV — reuse the existing TTS streaming function
    const audioId = `sfx-${soundKey}-${ServerAudioState._sfxCounter++}`;
    streamTtsOverWs(wsClient, filePath, audioId, 'sfx').catch(err => {
      debugLog(`[ServerAudio] Failed to stream ${soundKey}: ${err}`);
    });
  }

  destroy(): void {
    this._stopPulseTimer();
    this.state = 'inactive';
  }
}

const serverAudioState = new ServerAudioState();

// Centralized voice-active setter — updates both voicePreferences and ServerAudioState
function setVoiceActive(active: boolean): void {
  voicePreferences.voiceActive = active;
  serverAudioState.setListening(active);
  debugLog(`[VoiceActive] ${active ? 'activated' : 'deactivated'}`);
}

// Background voice enforcement: when enabled, inactive sessions get
// voiceActive=true in hook responses for inactive sessions,
// forcing them to call the speak tool (which stores text in conversation history).
let backgroundVoiceEnforcement = false;

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

function getActiveSession(): SessionState | null {
  if (activeCompositeKey) {
    const session = sessions.get(activeCompositeKey);
    if (session) return session;
  }
  // No active session set — only return default if no real sessions exist
  const hasRealSessions = Array.from(sessions.values()).some(s => s.sessionId !== 'default');
  if (!hasRealSessions) {
    const defaultKey = compositeKey('default');
    return getOrCreateSession(defaultKey);
  }
  return null;
}

// Resolve session from a browser request — uses explicit session key if provided, otherwise active/first
function getSessionFromRequest(req: Request): SessionState {
  const sessionKey = (req.query?.session as string) || (req.body?.session as string);
  if (sessionKey && sessions.has(sessionKey)) {
    return sessions.get(sessionKey)!;
  }
  return getActiveSessionOrFirst();
}

// Get active session or return a 404-like response for browser endpoints
function getActiveSessionOrFirst(): SessionState {
  const active = getActiveSession();
  if (active) return active;
  // If there are real sessions but none is active, return the first one
  const first = sessions.values().next().value;
  if (first) return first;
  // Truly empty — create default
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
const speakWhitelist = new Map<string, { count: number; expiry: number; sessionKey: string }>();

const WHITELIST_TTL_MS = 5000; // 5 second TTL for whitelist entries

function addToWhitelist(text: string, sessionKey: string): void {
  const existing = speakWhitelist.get(text);
  const expiry = Date.now() + WHITELIST_TTL_MS;
  if (existing) {
    existing.count++;
    existing.expiry = expiry;
    existing.sessionKey = sessionKey; // Update to latest session
  } else {
    speakWhitelist.set(text, { count: 1, expiry, sessionKey });
  }
  debugLog(`[Whitelist] Added: key=${sessionKey} text="${text.slice(0, 30)}..." count=${speakWhitelist.get(text)!.count}`);
}

function checkWhitelist(text: string): { matched: boolean; sessionKey?: string } {
  cleanupWhitelist();
  const entry = speakWhitelist.get(text);
  if (entry && entry.count > 0) {
    const sessionKey = entry.sessionKey;
    entry.count--;
    if (entry.count === 0) {
      speakWhitelist.delete(text);
    }
    debugLog(`[Speak] Whitelist match: text="${text.slice(0, 30)}..." sessionKey=${sessionKey} remaining=${entry.count}`);
    return { matched: true, sessionKey };
  }
  debugLog(`[Speak] Whitelist miss: text="${text.slice(0, 30)}..."`);
  return { matched: false };
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

  const session = getSessionFromRequest(req);
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
  const session = getSessionFromRequest(req);
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
  const session = getSessionFromRequest(req);
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
  const session = getActiveSessionOrFirst();
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
  const s = session || getActiveSessionOrFirst();
  // Always dequeue pending utterances regardless of voiceActive
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
  const s = session || getActiveSessionOrFirst();

  // Check if voice input is active
  if (!voicePreferences.voiceActive) {
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

  // Poll for utterances
  while (Date.now() - startTime < maxWaitMs) {
    // Check if voice input is still active
    if (!voicePreferences.voiceActive) {
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

    // Wait 100ms before checking again, but wake immediately on client disconnect
    await new Promise<void>(resolve => {
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

  // Timeout reached - no utterances found
  notifyWaitStatus(false); // Notify wait has ended
  return {
    success: true,
    utterances: [],
    message: `No utterances found after waiting ${Math.round((Date.now() - startTime) / 1000)} seconds.`,
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
  const session = getActiveSessionOrFirst();
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
  const voiceActive = voicePreferences.voiceActive;
  const session = getActiveSessionOrFirst();

  if (!action || !['tool-use', 'stop'].includes(action)) {
    res.status(400).json({ error: 'Invalid action. Must be "tool-use" or "stop"' });
    return;
  }

  // Only check for pending utterances if voice input is active
  if (voicePreferences.voiceActive) {
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
  if (voiceActive) {
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
  if (action === 'stop' && voicePreferences.voiceActive) {
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
  const s = session || getActiveSessionOrFirst();
  const voiceActive = voicePreferences.voiceActive;

  // 1. Check for pending utterances and auto-dequeue
  // Always check for pending utterances regardless of voiceActive
  // This allows typed messages to be dequeued even when mic is off
  const pendingUtterances = s.queue.utterances.filter(u => u.status === 'pending');
  if (pendingUtterances.length > 0) {
    // Always dequeue (dequeueUtterancesCore no longer requires voiceActive)
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
  if (voiceActive) {
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
    if (voiceActive && s.lastToolUseTimestamp &&
      (!s.lastSpeakTimestamp || s.lastSpeakTimestamp < s.lastToolUseTimestamp)) {
      return {
        decision: 'block',
        reason: 'Assistant must speak after using tools. Please use the speak tool to respond before proceeding.'
      };
    }

    // Auto-wait for utterances (only if voice is active)
    if (voiceActive) {
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

    // Check if there's a default session with data that should be migrated
    const parsed = JSON.parse(key) as [string, string];
    const newSessionId = parsed[0];
    if (newSessionId !== 'default') {
      const defaultKey = compositeKey('default');
      const defaultSession = sessions.get(defaultKey);
      if (defaultSession && (defaultSession.queue.utterances.length > 0 || defaultSession.queue.messages.length > 0)) {
        const newSession = getOrCreateSession(key, newSessionId, null, null);
        for (const utterance of defaultSession.queue.utterances) {
          newSession.queue.utterances.push(utterance);
        }
        for (const message of defaultSession.queue.messages) {
          newSession.queue.messages.push(message);
        }
        debugLog(`[Session] Migrated ${defaultSession.queue.utterances.length} utterance(s) and ${defaultSession.queue.messages.length} message(s) from default → ${key}`);
        defaultSession.queue.utterances = [];
        defaultSession.queue.messages = [];
      }
    }
  } else {
    const currentActive = sessions.get(activeCompositeKey);
    const parsed = JSON.parse(key) as [string, string];
    const newSessionId = parsed[0];

    if (currentActive && currentActive.sessionId === 'default' && newSessionId !== 'default') {
      // If the current active is a default session and this is a real session, upgrade.
      // Migrate messages from the default session to the new session.
      const newSession = getOrCreateSession(key, newSessionId, null, null);
      if (currentActive.queue.utterances.length > 0 || currentActive.queue.messages.length > 0) {
        for (const utterance of currentActive.queue.utterances) {
          newSession.queue.utterances.push(utterance);
        }
        for (const message of currentActive.queue.messages) {
          newSession.queue.messages.push(message);
        }
        currentActive.queue.utterances = [];
        currentActive.queue.messages = [];
        debugLog(`[Session] Migrated ${newSession.queue.utterances.length} utterance(s) and ${newSession.queue.messages.length} message(s) from default → ${key}`);
      }
      activeCompositeKey = key;
      debugLog(`[Session] Active upgraded from default → ${key}`);
    } else if (currentActive && currentActive.sessionId !== newSessionId && newSessionId !== 'default') {
      // Different session_id — only switch if it's NOT a subagent of the current session
      const incomingSession = sessions.get(key);
      const isSubagent = incomingSession?.agentId && incomingSession.agentId !== 'main';
      if (isSubagent) {
        // Subagent sessions should NOT steal focus from the lead session
        debugLog(`[Session] Subagent hook ignored for active switch: ${key} (active stays ${activeCompositeKey})`);
      } else {
        // Different non-subagent session — never steal active. The first session
        // that registers owns the active slot for the server's lifetime.
        // Use the /api/sessions/active endpoint to switch manually if needed.
        debugLog(`[Session] New session ${key} ignored — active session already set (active stays ${activeCompositeKey})`);
      }
    }
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

  // Inactive session (subagent): enforce "must speak after tool use" only when background enforcement is explicitly enabled
  if (!isActiveKey(key)) {
    const enforceSpeak = backgroundVoiceEnforcement;
    if (enforceSpeak && session.lastToolUseTimestamp &&
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

  // Signal that Claude is actively working while stop hook evaluates
  serverAudioState.setHookActive(true);

  const result = await handleHookRequest('stop', session);

  // Broadcast "stopped" state when the stop hook truly approves
  // (no utterances delivered back — Claude's turn is ending)
  if (result.decision === 'approve') {
    // Clear hookActive silently to avoid intermediate 'inactive' broadcast,
    // then broadcast 'stopped' as the final state.
    serverAudioState.clearHookActiveSilent();
    broadcastVoiceState('stopped');
  }

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

  // Inactive session: store in that session's conversation history, approve without TTS
  if (speakText) {
    session.queue.addAssistantMessage(speakText);
    session.lastSpeakTimestamp = new Date();
    debugLog(`[Speak] Stored for inactive session: key=${key} text="${speakText.slice(0, 30)}..."`);
  }
  res.json({
    decision: 'approve',
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

  // Signal that Claude is actively working (shows 'processing' in browser)
  serverAudioState.setHookActive(true);

  const result = handleHookRequest('post-tool', session);
  res.json(result);
});

// API to clear all utterances
// Delete specific utterance by ID
app.delete('/api/utterances/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const session = getActiveSessionOrFirst();
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
  const session = getActiveSessionOrFirst();
  const clearedCount = session.queue.utterances.length;
  session.queue.clear();
  clearTtsQueue();

  res.json({
    success: true,
    message: `Cleared ${clearedCount} utterances`,
    clearedCount
  });
});

// Clear TTS queue and kill any running say process
app.delete('/api/tts-queue', (_req: Request, res: Response) => {
  const queueLength = ttsQueue.length;
  const wasPlaying = ttsPlaying;
  clearTtsQueue();
  debugLog(`[TTS Queue] DELETE /api/tts-queue - cleared ${queueLength} queued, wasPlaying=${wasPlaying}`);
  res.json({
    success: true,
    message: `Cleared TTS queue`,
    clearedCount: queueLength,
    stoppedPlaying: wasPlaying
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

  // Send current voice state so browser starts with correct UI.
  // Clients watching a different session get 'inactive'.
  const initialState = (sessionKey === null || sessionKey === activeCompositeKey)
    ? serverAudioState.state
    : 'inactive';
  res.write(`data: ${JSON.stringify({
    type: 'voice-state',
    state: initialState,
    sessionKey: activeCompositeKey
  })}\n\n`);

  // Add client to map
  ttsClients.set(res, sessionKey);
  debugLog(`[SSE] Client connected: session=${sessionKey || 'active'}`);

  // Remove client on disconnect
  res.on('close', () => {
    const disconnectedSessionKey = ttsClients.get(res);
    ttsClients.delete(res);

    // If no clients remain (SSE or WS), disable voice features
    if (ttsClients.size === 0 && wsAudioClients.size === 0) {
      debugLog(`[SSE] Client disconnected: session=${disconnectedSessionKey || 'active'} (last client, disabling voice)`);
      if (voicePreferences.voiceActive) {
        debugLog(`[SSE] Voice features disabled - voiceActive: ${voicePreferences.voiceActive} -> false`);
        setVoiceActive(false);
      }
      serverEvents.emit('allClientsDisconnected');
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

// Helper function to notify TTS clients to clear their audio playback queue
function notifyTTSClear() {
  const message = JSON.stringify({ type: 'tts-clear' });
  // Send to SSE clients
  ttsClients.forEach((_viewingKey, client) => {
    client.write(`data: ${message}\n\n`);
  });
  // Send to WS clients
  for (const client of wsAudioClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

// Helper function to notify all SSE clients that a new Claude session started
// so the browser can re-sync its voice state with the server
function notifySessionReset() {
  const message = JSON.stringify({ type: 'session-reset' });
  ttsClients.forEach((_viewingKey, client) => {
    client.write(`data: ${message}\n\n`);
  });
  debugLog(`[SSE] Sent session-reset to ${ttsClients.size} client(s)`);
}

// Helper function to notify clients viewing the active session about wait status
function notifyWaitStatus(isWaiting: boolean) {
  const message = JSON.stringify({ type: 'waitStatus', isWaiting, sessionKey: activeCompositeKey });
  ttsClients.forEach((viewingKey, client) => {
    if (viewingKey === null || viewingKey === activeCompositeKey) {
      client.write(`data: ${message}\n\n`);
    }
  });
  // Drive server-side audio state
  serverAudioState.setWaitStatus(isWaiting);
}

// Broadcast voice state to SSE clients viewing the active session
function broadcastVoiceState(state: string): void {
  const message = JSON.stringify({
    type: 'voice-state',
    state,
    sessionKey: activeCompositeKey
  });
  ttsClients.forEach((viewingKey, client) => {
    if (viewingKey === null || viewingKey === activeCompositeKey) {
      client.write(`data: ${message}\n\n`);
    }
  });
}

// Wire up the ServerAudioState callback now that ttsClients exists
serverAudioState.onStateChange = broadcastVoiceState;


// ── WebSocket audio endpoint ──────────────────────────────────────────
// Tracks connected WebSocket clients for bidirectional audio streaming.
// Phase 1: receives binary audio frames and control messages; no speech
// recognition yet.

interface WsAudioClient {
  ws: WebSocket;
  sessionKey: string | null;
  isCapturing: boolean;       // true between audio-start and audio-stop
  frameCount: number;         // binary frames received
  byteCount: number;          // total bytes of audio data received
  pingTimer: ReturnType<typeof setInterval> | null;
  ttsActive: boolean;         // true between tts-start and tts-end
  currentAudioId: string | null; // audioId of current TTS stream
  recognizer: SpeechRecognizer | null; // speech recognition process (Phase 2)
  streamMutex: Promise<void>;  // serializes outbound audio streams
}

const wsAudioClients = new Set<WsAudioClient>();
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const sessionKey = url.searchParams.get('session') || null;

  // Only allow one WebSocket audio client at a time.
  // Close any existing connections before accepting the new one.
  for (const existing of wsAudioClients) {
    debugLog(`[WS] Closing existing audio client (new connection replacing it)`);
    if (existing.pingTimer) clearInterval(existing.pingTimer);
    if (existing.recognizer) {
      existing.recognizer.kill();
      existing.recognizer = null;
    }
    existing.ws.close(1000, 'Replaced by new connection');
    wsAudioClients.delete(existing);
  }

  const client: WsAudioClient = {
    ws,
    sessionKey,
    isCapturing: false,
    frameCount: 0,
    byteCount: 0,
    pingTimer: null,
    ttsActive: false,
    currentAudioId: null,
    recognizer: null,
    streamMutex: Promise.resolve(),
  };

  wsAudioClients.add(client);
  debugLog(`[WS] Audio client connected: session=${sessionKey || 'active'} (${wsAudioClients.size} total)`);

  // Heartbeat: send ping every 30s to keep mobile connections alive
  client.pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30_000);

  ws.on('pong', () => {
    debugLog('[WS] Received pong');
  });

  ws.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (isBinary) {
      // Binary frame = raw PCM audio data
      const buf = data as Buffer;
      client.frameCount++;
      client.byteCount += buf.length;

      if (client.frameCount % 50 === 1) {
        // Log every ~1 second (50 frames * 20ms = 1s)
        debugLog(`[WS] Audio: frame=${client.frameCount} bytes=${client.byteCount} (this=${buf.length})`);
      }
      // Pipe audio to speech recognizer if available
      if (client.recognizer) {
        client.recognizer.feedAudio(buf);
      }
    } else {
      // Text frame = JSON control message
      try {
        const msg = JSON.parse(data.toString());
        handleWsControlMessage(client, msg);
      } catch (err) {
        debugLog(`[WS] Invalid JSON from client: ${err}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    }
  });

  ws.on('close', () => {
    if (client.pingTimer) clearInterval(client.pingTimer);
    // Stop speech recognizer on disconnect
    if (client.recognizer) {
      client.recognizer.kill();
      client.recognizer = null;
    }
    wsAudioClients.delete(client);
    debugLog(`[WS] Audio client disconnected: session=${sessionKey || 'active'} frames=${client.frameCount} bytes=${client.byteCount} (${wsAudioClients.size} remaining)`);

    // If no clients remain (SSE or WS), disable voice features
    if (ttsClients.size === 0 && wsAudioClients.size === 0) {
      debugLog(`[WS] Last client disconnected, disabling voice features`);
      if (voicePreferences.voiceActive) {
        setVoiceActive(false);
      }
      serverEvents.emit('allClientsDisconnected');
    }
  });

  ws.on('error', (err) => {
    debugLog(`[WS] Client error: ${err.message}`);
  });
});

function handleWsControlMessage(client: WsAudioClient, msg: { type: string; [key: string]: unknown }) {
  switch (msg.type) {
    case 'audio-start':
      client.isCapturing = true;
      client.frameCount = 0;
      client.byteCount = 0;
      debugLog(`[WS] audio-start: sampleRate=${msg.sampleRate} channels=${msg.channels} encoding=${msg.encoding}`);
      // Start speech recognizer if available
      if (SPEECH_RECOGNIZER_AVAILABLE && !client.recognizer) {
        startRecognizerForClient(client);
      }
      break;

    case 'audio-stop':
      client.isCapturing = false;
      debugLog(`[WS] audio-stop: total frames=${client.frameCount} bytes=${client.byteCount}`);
      // Stop speech recognizer gracefully (close stdin to flush remaining results)
      if (client.recognizer) {
        client.recognizer.stop();
        client.recognizer = null;
      }
      break;

    case 'tts-ack': {
      debugLog(`[WS] Received tts-ack for audioId=${msg.audioId}`);
      const resolver = pendingTtsAcks.get(msg.audioId as string);
      if (resolver) {
        resolver();
        pendingTtsAcks.delete(msg.audioId as string);
      }
      break;
    }

    case 'ping':
      client.ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'select-session':
      (client as any).selectedSessionKey = msg.sessionKey;
      debugLog(`[WS] Client selected session: ${msg.sessionKey}`);
      break;

    default:
      debugLog(`[WS] Unknown message type: ${msg.type}`);
      break;
  }
}

// Start a SpeechRecognizer for a WebSocket client and wire up events
function startRecognizerForClient(client: WsAudioClient): void {
  const repoRoot = path.join(__dirname, '..');
  const recognizer = new SpeechRecognizer(repoRoot);

  recognizer.on('transcript', (result: { type: string; text: string }) => {
    if (client.ws.readyState !== WebSocket.OPEN) return;

    if (result.type === 'interim') {
      client.ws.send(JSON.stringify({
        type: 'transcript-interim',
        text: result.text,
      }));
    } else if (result.type === 'final' && result.text.trim()) {
      const utteranceId = randomUUID();
      // Create utterance in the selected session (from WS client), falling back to active
      const selectedKey = (client as any).selectedSessionKey;
      const session = selectedKey && sessions.has(selectedKey) ? sessions.get(selectedKey)! : getActiveSessionOrFirst();
      session.queue.add(result.text.trim());

      client.ws.send(JSON.stringify({
        type: 'transcript-final',
        text: result.text.trim(),
        utteranceId,
      }));

      debugLog(`[SpeechRecognizer] Final transcript → utterance created: "${result.text.trim()}"`);
    }
  });

  recognizer.on('error', (err: Error) => {
    debugLog(`[SpeechRecognizer] Error: ${err.message}`);
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'error', message: `Speech recognition error: ${err.message}` }));
    }
  });

  recognizer.on('exit', (_code: number | null, _signal: string | null) => {
    // If the client is still capturing and recognizer crashed, it will auto-restart
    // via the SpeechRecognizer class. We just need to re-assign when it restarts.
  });

  client.recognizer = recognizer;
  recognizer.start();

  debugLog('[SpeechRecognizer] Started for WS client');
}

// Find a connected WebSocket client for a given session key
function findWsClientForSession(targetKey: string | null): WsAudioClient | null {
  for (const client of wsAudioClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (client.sessionKey === null || client.sessionKey === targetKey) {
        return client;
      }
    }
  }
  return null;
}

// Stream rendered TTS WAV file as PCM chunks over WebSocket
const TTS_WS_CHUNK_SIZE = 4096; // bytes per binary frame
// Find the 'data' chunk offset in a WAV file by parsing RIFF chunks.
// macOS `say` writes JUNK and FLLR padding chunks, so the data chunk
// starts at byte ~4096 instead of the standard 44.
function findWavDataOffset(buf: Buffer): number {
  let offset = 12; // skip RIFF header (4 'RIFF' + 4 size + 4 'WAVE')
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkId === 'data') return offset;
    offset += chunkSize;
  }
  return 44; // fallback
}

// Per-client output mutex prevents interleaved binary frames when TTS and SFX
// streams fire close together. Uses acquire/release pattern — the body runs from
// both fulfillment and rejection paths of the prior chain entry.
async function streamTtsOverWs(client: WsAudioClient, filePath: string, audioId: string, kind: 'tts' | 'sfx' = 'tts'): Promise<void> {
  let streamError: Error | null = null;
  let releaseResolve: () => void;
  const released = new Promise<void>(r => { releaseResolve = r; });

  const runBody = async () => {
    try {
      await _streamTtsOverWsInner(client, filePath, audioId, kind);
    } catch (e) {
      streamError = e instanceof Error ? e : new Error(String(e));
    } finally {
      releaseResolve!();
    }
  };

  // Chain: run body regardless of prior outcome
  client.streamMutex = client.streamMutex.then(runBody, runBody);

  await released;
  if (streamError) throw streamError;
}

async function _streamTtsOverWsInner(client: WsAudioClient, filePath: string, audioId: string, kind: 'tts' | 'sfx'): Promise<void> {
  const { ws } = client;

  // Send tts-start with kind field
  ws.send(JSON.stringify({
    type: 'tts-start',
    audioId,
    sampleRate: 22050,
    channels: 1,
    kind,  // 'tts' or 'sfx' — browser uses this to decide echo suppression
  }));

  // Track per-client WS state only for TTS (not SFX)
  if (kind === 'tts') {
    client.ttsActive = true;
    client.currentAudioId = audioId;
  }

  // Read WAV file, find actual data chunk, send PCM data in chunks
  const fileData = await fs.promises.readFile(filePath);
  const dataOffset = findWavDataOffset(fileData);
  const pcmData = fileData.subarray(dataOffset);

  for (let offset = 0; offset < pcmData.length; offset += TTS_WS_CHUNK_SIZE) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const chunk = pcmData.subarray(offset, Math.min(offset + TTS_WS_CHUNK_SIZE, pcmData.length));
    ws.send(chunk);
  }

  // Send tts-end with kind field
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'tts-end',
      audioId,
      kind,
    }));
  }

  if (kind === 'tts') {
    client.ttsActive = false;
    client.currentAudioId = null;
  }

  debugLog(`[WS TTS] Streamed ${pcmData.length} bytes for audioId=${audioId} kind=${kind}`);
}

// Attach WebSocket upgrade handler to an HTTP(S) server
function attachWsUpgrade(server: http.Server | https.Server) {
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    if (url.pathname === '/ws/audio') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
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

// API for voice active state
app.post('/api/voice-active', (req: Request, res: Response) => {
  const { active } = req.body;

  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active must be a boolean' });
    return;
  }

  setVoiceActive(active);

  res.json({
    success: true,
    voiceActive: voicePreferences.voiceActive
  });
});

// API to check if server-side speech recognition is available
app.get('/api/speech-recognition-available', (_req: Request, res: Response) => {
  res.json({ available: SPEECH_RECOGNIZER_AVAILABLE });
});

// API for background voice enforcement
app.post('/api/background-voice-enforcement', (req: Request, res: Response) => {
  const { enabled } = req.body;
  backgroundVoiceEnforcement = !!enabled;
  debugLog(`[Background Voice Enforcement] ${backgroundVoiceEnforcement ? 'Enabled' : 'Disabled'}`);
  res.json({ success: true, enabled: backgroundVoiceEnforcement });
});

app.get('/api/background-voice-enforcement', (_req: Request, res: Response) => {
  res.json({ enabled: backgroundVoiceEnforcement });
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
  if (!voicePreferences.voiceActive) {
    debugLog(`[Speak] Voice responses disabled, returning error`);
    res.status(400).json({
      error: 'Voice responses are disabled',
      message: 'Cannot speak when voice responses are disabled'
    });
    return;
  }

  // Check whitelist: only speak via TTS if text was approved by pre-speak hook
  // Skip whitelist check if no multi-session is active (single session backward compat)
  let whitelistSessionKey: string | undefined;
  if (activeCompositeKey !== null) {
    const whitelistResult = checkWhitelist(text);
    if (!whitelistResult.matched) {
      // Not whitelisted = inactive session. The pre-speak hook already stored the text
      // in conversation history. Return success so the agent isn't confused.
      debugLog(`[Speak] Non-whitelisted text (inactive session), returning success without TTS: "${text.slice(0, 30)}..."`);
      res.json({
        success: true,
        message: 'Text spoken successfully',
        respondedCount: 0
      });
      return;
    }
    whitelistSessionKey = whitelistResult.sessionKey;
  }

  try {
    // Use the session from the whitelist entry (the session that pre-speak approved),
    // falling back to the active session for single-session backward compat
    const session = whitelistSessionKey
      ? (sessions.get(whitelistSessionKey) || getActiveSessionOrFirst())
      : getActiveSessionOrFirst();

    // Always send text via SSE for conversation display + browser TTS
    notifyTTSClients(text);
    debugLog(`[Speak] Sent text to browser: "${text}"`);

    // Render TTS audio via macOS say command and stream over WebSocket
    // This is async/non-blocking — the speak endpoint returns immediately
    const sessionKey = whitelistSessionKey || activeCompositeKey;
    enqueueTts(text, voicePreferences.speechRate, sessionKey).catch(err => {
      debugLog(`[Speak] Failed to render system voice audio: ${err}`);
    });

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

// Test voice — TTS only, no side effects (no utterance marking, no conversation history)
app.post('/api/test-voice', async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }
  try {
    notifyTTSClients(text);
    await enqueueTts(text, voicePreferences.speechRate);
    res.json({ success: true });
  } catch (error) {
    debugLog(`[TestVoice] Failed: ${error}`);
    res.status(500).json({ error: 'Failed to test voice' });
  }
});

// Set selected voice preference (browser syncs this on voice dropdown change)
app.post('/api/selected-voice', (req: Request, res: Response) => {
  const { selectedVoice, speechRate, feedbackSoundMode } = req.body;

  if (!selectedVoice || typeof selectedVoice !== 'string') {
    res.status(400).json({ error: 'selectedVoice is required' });
    return;
  }

  voicePreferences.selectedVoice = selectedVoice;
  if (typeof speechRate === 'number' && speechRate > 0) {
    voicePreferences.speechRate = Math.max(50, Math.min(500, Math.round(speechRate)));
  }
  const VALID_FEEDBACK_MODES = new Set(['once', 'continuous', 'off']);
  if (typeof feedbackSoundMode === 'string' && VALID_FEEDBACK_MODES.has(feedbackSoundMode)) {
    voicePreferences.feedbackSoundMode = feedbackSoundMode as 'once' | 'continuous' | 'off';
    serverAudioState.reapplyFeedbackMode();
  }
  debugLog(`[Voice] Selected voice: ${selectedVoice}, rate: ${voicePreferences.speechRate}, feedbackSoundMode: ${voicePreferences.feedbackSoundMode}`);
  res.json({ success: true, selectedVoice, speechRate: voicePreferences.speechRate, feedbackSoundMode: voicePreferences.feedbackSoundMode });
});

// UI Routing
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/messenger', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start HTTP server with EADDRINUSE handling for multi-session support
// Create server and attach error handler BEFORE listen to ensure proper event ordering
let eaddrinuseDetected = false;
const httpServer = http.createServer(app);

// Attach WebSocket upgrade handler to HTTP server
attachWsUpgrade(httpServer);

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

  // Pre-render sound effects (chime, pulses) for server-side audio
  try {
    await generateSounds();
    fs.appendFileSync('/tmp/mcp-voice-hooks.log', `  [Sounds] Generated: chime=${sounds.chime} listening=${sounds.listeningPulse} processing=${sounds.processingPulse}\n`);
  } catch (e) {
    fs.appendFileSync('/tmp/mcp-voice-hooks.log', `  [Sounds] FAILED: ${e}\n`);
  }

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
      if (ttsClients.size === 0 && wsAudioClients.size === 0) {
        debugLog('[Browser] No frontend connected, opening browser...');
        try {
          const open = (await import('open')).default;
          // Open default UI (messenger is now at root)
          await open(`http://localhost:${HTTP_PORT}`);
        } catch (error) {
          debugLog('[Browser] Failed to open browser:', error);
        }
      } else {
        debugLog(`[Browser] Frontend already connected (${ttsClients.size} SSE + ${wsAudioClients.size} WS client(s))`)
      }
    }, 3000);
  }

  // Start HTTPS server in same process, sharing state with HTTP server
  startHttpsServer();
});

// HTTPS server setup — only called from HTTP listen callback to ensure
// it runs in the same process that owns the HTTP port and shared state.
function startHttpsServer() {
  const certsDir = path.join(__dirname, '..', 'certs');
  const certPath = path.join(certsDir, 'cert.pem');
  const keyPath = path.join(certsDir, 'key.pem');

  function generateSelfSignedCerts(): boolean {
    const log = IS_MCP_MANAGED ? console.error : console.log;
    try {
      fs.mkdirSync(certsDir, { recursive: true });
      const hostname = require('os').hostname();
      const { execSync } = require('child_process');
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes ` +
        `-keyout "${keyPath}" -out "${certPath}" ` +
        `-days 365 -subj "/CN=${hostname}" ` +
        `-addext "subjectAltName=DNS:${hostname},DNS:${hostname}.local,DNS:localhost,IP:127.0.0.1"`,
        { stdio: 'pipe' }
      );
      log(`[HTTPS] Auto-generated self-signed certificate (CN=${hostname})`);
      return true;
    } catch (error) {
      log(`[HTTPS] Failed to generate certificate: ${error}`);
      return false;
    }
  }

  let certsAvailable = fs.existsSync(certPath) && fs.existsSync(keyPath);
  if (!certsAvailable) {
    certsAvailable = generateSelfSignedCerts();
  }

  if (certsAvailable) {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    const httpsServer = https.createServer(httpsOptions, app);

    // Attach WebSocket upgrade handler to HTTPS server
    attachWsUpgrade(httpsServer);

    httpsServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const log = IS_MCP_MANAGED ? console.error : console.log;
        log(`[HTTPS] Port ${HTTPS_PORT} already in use — skipping HTTPS server`);
      } else {
        throw err;
      }
    });

    httpsServer.listen(HTTPS_PORT, () => {
      const log = IS_MCP_MANAGED ? console.error : console.log;
      log(`[HTTPS] Server listening on https://localhost:${HTTPS_PORT}`);
    });
  }
}

// Helper function to get voice response reminder
function getVoiceResponseReminder(): string {
  const voiceActive = voicePreferences.voiceActive;
  return voiceActive
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
      instructions: 'When voice input and output are active: (1) Delegate tasks to teammates when available (team_name: new_or_existing_team_name). Resume idle teammates with SendMessage. If a teammate has shut down, use the Agent tool with the resume parameter to restart it. (2) If the teammate functionality is disabled, use background agents instead (run_in_background: true). (3) Keep your own turns short to stay responsive to voice input.',
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