import express from 'express';
import type { Express } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import cors from 'cors';
import { randomUUID} from 'crypto';
import path from 'path';

// Mock execAsync for testing - we don't want to actually run TTS
const execAsync = async (command: string): Promise<{ stdout: string; stderr: string }> => {
  // Simulate successful execution without actually running the command
  return { stdout: '', stderr: '' };
};

// Utterance types
interface Utterance {
  id: string;
  text: string;
  timestamp: Date;
  status: 'pending' | 'delivered' | 'responded';
}

// Conversation message type
interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
  status?: 'pending' | 'delivered' | 'responded'; // Only for user messages
}

// UtteranceQueue class for managing utterances in tests
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

    // Also add to messages array
    this.messages.push({
      id: utterance.id,
      role: 'user',
      text: utterance.text,
      timestamp: utterance.timestamp,
      status: utterance.status
    });

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

      // Sync status in messages array
      const message = this.messages.find(m => m.id === id && m.role === 'user');
      if (message) {
        message.status = 'delivered';
      }
    }
  }

  markResponded(id: string): void {
    const utterance = this.utterances.find(u => u.id === id);
    if (utterance) {
      utterance.status = 'responded';

      // Sync status in messages array
      const message = this.messages.find(m => m.id === id && m.role === 'user');
      if (message) {
        message.status = 'responded';
      }
    }
  }

  clear(): void {
    this.utterances = [];
    this.messages = []; // Clear conversation too
  }
}

// Voice preferences type
interface VoicePreferences {
  voiceResponsesEnabled: boolean;
  voiceInputActive: boolean;
}

// Per-session state (mirrors unified-server.ts)
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

// Composite key helper
function compositeKey(sessionId: string, agentId?: string | null): string {
  return JSON.stringify([sessionId, agentId || 'main']);
}

/**
 * TestServer provides a real HTTP server for integration testing.
 * It mimics the core functionality of unified-server.ts but with isolated state.
 */
export class TestServer {
  private app: Express;
  private server: http.Server | null = null;
  private voicePreferences: VoicePreferences;
  public port: number = 0;
  public url: string = '';

  // Multi-session state
  public sessions = new Map<string, SessionState>();
  public activeCompositeKey: string | null = null;
  public speakWhitelist = new Map<string, { count: number; expiry: number }>();
  private whitelistTTL = 5000;

  constructor() {
    this.app = express();
    this.voicePreferences = {
      voiceResponsesEnabled: false,
      voiceInputActive: false
    };

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
  }

  private parseCompositeKey(body: any): { key: string; sessionId: string; agentId: string | null; agentType: string | null } {
    const sessionId = body?.session_id || 'default';
    const agentId = body?.agent_id || null;
    const agentType = body?.agent_type || null;
    const key = compositeKey(sessionId, agentId);
    return { key, sessionId, agentId, agentType };
  }

  private getOrCreateSession(key: string, sessionId?: string, agentId?: string | null, agentType?: string | null): SessionState {
    let session = this.sessions.get(key);
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
      this.sessions.set(key, session);
    }
    session.lastActivity = new Date();
    return session;
  }

  private getActiveSession(): SessionState {
    if (this.activeCompositeKey) {
      const session = this.sessions.get(this.activeCompositeKey);
      if (session) return session;
    }
    // Fallback: create/get default session without setting activeCompositeKey
    // (only hook endpoints should set activeCompositeKey via registerIfFirst)
    const defaultKey = compositeKey('default');
    return this.getOrCreateSession(defaultKey);
  }

  private isActiveKey(key: string): boolean {
    return this.activeCompositeKey !== null && key === this.activeCompositeKey;
  }

  private registerIfFirst(key: string): void {
    if (this.activeCompositeKey === null) {
      this.activeCompositeKey = key;
    }
  }

  private addToWhitelist(text: string): void {
    const existing = this.speakWhitelist.get(text);
    const expiry = Date.now() + this.whitelistTTL;
    if (existing) {
      existing.count++;
      existing.expiry = expiry;
    } else {
      this.speakWhitelist.set(text, { count: 1, expiry });
    }
  }

  private checkWhitelist(text: string): boolean {
    this.cleanupWhitelist();
    const entry = this.speakWhitelist.get(text);
    if (entry && entry.count > 0) {
      entry.count--;
      if (entry.count === 0) {
        this.speakWhitelist.delete(text);
      }
      return true;
    }
    return false;
  }

  private cleanupWhitelist(): void {
    const now = Date.now();
    for (const [text, entry] of this.speakWhitelist) {
      if (entry.expiry < now) {
        this.speakWhitelist.delete(text);
      }
    }
  }

  private setupRoutes(): void {
    // POST /api/potential-utterances
    this.app.post('/api/potential-utterances', (req, res) => {
      const { text, timestamp } = req.body;

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Text is required' });
        return;
      }

      const session = this.getActiveSession();
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

    // GET /api/utterances
    this.app.get('/api/utterances', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 10;
      const session = this.getActiveSession();
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

    // GET /api/conversation
    this.app.get('/api/conversation', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      const session = this.getActiveSession();
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

    // GET /api/utterances/status
    this.app.get('/api/utterances/status', (_req, res) => {
      const session = this.getActiveSession();
      const total = session.queue.utterances.length;
      const pending = session.queue.utterances.filter(u => u.status === 'pending').length;
      const delivered = session.queue.utterances.filter(u => u.status === 'delivered').length;
      const responded = session.queue.utterances.filter(u => u.status === 'responded').length;

      res.json({
        total,
        pending,
        delivered,
        responded,
      });
    });

    // POST /api/wait-for-utterances (simplified for testing - doesn't actually wait)
    this.app.post('/api/wait-for-utterances', (_req, res) => {
      if (!this.voicePreferences.voiceInputActive) {
        res.status(400).json({
          success: false,
          error: 'Voice input is not active. Cannot wait for utterances when voice input is disabled.'
        });
        return;
      }

      const session = this.getActiveSession();
      // For testing, just check immediately without polling
      const pendingUtterances = session.queue.utterances
        .filter(u => u.status === 'pending')
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      if (pendingUtterances.length > 0) {
        pendingUtterances.forEach(u => {
          session.queue.markDelivered(u.id);
        });

        res.json({
          success: true,
          utterances: pendingUtterances.map(u => ({
            id: u.id,
            text: u.text,
            timestamp: u.timestamp,
            status: 'delivered'
          })),
          count: pendingUtterances.length,
          waitTime: 0
        });
      } else {
        // No utterances - return empty
        res.json({
          success: true,
          utterances: [],
          count: 0,
          message: 'Timeout waiting for utterances',
          waitTime: 0
        });
      }
    });

    // POST /api/dequeue-utterances
    this.app.post('/api/dequeue-utterances', (_req, res) => {
      if (!this.voicePreferences.voiceInputActive) {
        res.status(400).json({
          success: false,
          error: 'Voice input is not active. Cannot dequeue utterances when voice input is disabled.'
        });
        return;
      }

      const session = this.getActiveSession();
      const pendingUtterances = session.queue.utterances
        .filter(u => u.status === 'pending')
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      pendingUtterances.forEach(u => {
        session.queue.markDelivered(u.id);
      });

      res.json({
        success: true,
        utterances: pendingUtterances.map(u => ({
          text: u.text,
          timestamp: u.timestamp,
        })),
      });
    });

    // POST /api/speak
    this.app.post('/api/speak', async (req, res) => {
      const { text } = req.body;

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Text is required' });
        return;
      }

      if (!this.voicePreferences.voiceResponsesEnabled) {
        res.status(400).json({
          error: 'Voice responses are disabled',
          message: 'Cannot speak when voice responses are disabled'
        });
        return;
      }

      // Check whitelist if multi-session is active
      if (this.activeCompositeKey !== null && !this.checkWhitelist(text)) {
        res.status(403).json({
          error: 'Speak not authorized',
          message: 'This text was not approved by the pre-speak hook for the active session'
        });
        return;
      }

      try {
        const session = this.getActiveSession();

        // Use macOS say command for TTS (mocked in tests)
        await execAsync(`say "${text.replace(/"/g, '\\"')}"`);

        // Store assistant's response in conversation history
        session.queue.addAssistantMessage(text);

        // Mark all delivered utterances as responded
        const deliveredUtterances = session.queue.utterances.filter(u => u.status === 'delivered');
        deliveredUtterances.forEach(u => {
          session.queue.markResponded(u.id);
        });

        session.lastSpeakTimestamp = new Date();

        res.json({
          success: true,
          message: 'Text spoken successfully',
          respondedCount: deliveredUtterances.length
        });
      } catch (error) {
        res.status(500).json({
          error: `Failed to speak: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    });

    // POST /api/speak-system (always works, uses Mac say command)
    this.app.post('/api/speak-system', async (req, res) => {
      const { text, rate = 150 } = req.body;

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Text is required' });
        return;
      }

      try {
        await execAsync(`say -r ${rate} "${text.replace(/"/g, '\\"')}"`);

        res.json({
          success: true,
          message: 'Text spoken successfully via system voice'
        });
      } catch (error) {
        res.status(500).json({
          error: 'Failed to speak text via system voice',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // POST /api/voice-input
    this.app.post('/api/voice-input', (req, res) => {
      const { active } = req.body;

      if (typeof active !== 'boolean') {
        res.status(400).json({ error: 'active must be a boolean' });
        return;
      }

      this.voicePreferences.voiceInputActive = active;
      res.json({ success: true });
    });

    // POST /api/voice-responses
    this.app.post('/api/voice-responses', (req, res) => {
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }

      this.voicePreferences.voiceResponsesEnabled = enabled;
      res.json({ success: true });
    });

    // DELETE /api/utterances
    this.app.delete('/api/utterances', (_req, res) => {
      const session = this.getActiveSession();
      session.queue.clear();
      res.json({ success: true });
    });

    // POST /api/validate-action
    this.app.post('/api/validate-action', (req, res) => {
      const { action } = req.body;

      if (!action || !['tool-use', 'stop'].includes(action)) {
        res.status(400).json({ error: 'Invalid action. Must be "tool-use" or "stop"' });
        return;
      }

      const session = this.getActiveSession();

      // Check for pending utterances (only if voice input is active)
      if (this.voicePreferences.voiceInputActive) {
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
      if (this.voicePreferences.voiceResponsesEnabled) {
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
      if (action === 'stop' && this.voicePreferences.voiceInputActive) {
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

    // GET /api/sessions
    this.app.get('/api/sessions', (_req, res) => {
      const sessionList = Array.from(this.sessions.values()).map(s => ({
        key: s.key,
        sessionId: s.sessionId,
        agentId: s.agentId,
        agentType: s.agentType,
        isActive: s.key === this.activeCompositeKey,
        lastActivity: s.lastActivity,
        utteranceCount: s.queue.utterances.length,
        messageCount: s.queue.messages.length,
        pendingCount: s.queue.utterances.filter(u => u.status === 'pending').length,
      }));

      res.json({
        sessions: sessionList,
        activeKey: this.activeCompositeKey,
      });
    });

    // POST /api/active-session
    this.app.post('/api/active-session', (req, res) => {
      const { key } = req.body;

      if (!key || !this.sessions.has(key)) {
        res.status(400).json({ error: 'Invalid session key' });
        return;
      }

      this.activeCompositeKey = key;
      res.json({
        success: true,
        activeKey: this.activeCompositeKey,
      });
    });

    // HTML routes for UI
    this.app.get('/', (_req, res) => {
      // Messenger is now index.html
      const publicDir = path.join(process.cwd(), 'public');
      res.sendFile(path.join(publicDir, 'index.html'));
    });

    this.app.get('/legacy', (_req, res) => {
      const publicDir = path.join(process.cwd(), 'public');
      res.sendFile(path.join(publicDir, 'legacy.html'));
    });

    this.app.get('/messenger', (_req, res) => {
      // Messenger is now index.html
      const publicDir = path.join(process.cwd(), 'public');
      res.sendFile(path.join(publicDir, 'index.html'));
    });

    // Hook endpoints for testing
    this.app.post('/api/hooks/stop', (req, res) => {
      const { key, sessionId, agentId, agentType } = this.parseCompositeKey(req.body);
      this.registerIfFirst(key);
      const session = this.getOrCreateSession(key, sessionId, agentId, agentType);

      // Only route voice for active session
      if (!this.isActiveKey(key)) {
        res.json({ decision: 'approve' });
        return;
      }

      // Check for pending utterances
      const pendingUtterances = session.queue.utterances.filter(u => u.status === 'pending');
      if (pendingUtterances.length > 0) {
        res.json({
          decision: 'block',
          reason: `There are ${pendingUtterances.length} pending utterances. Please check for new voice input before stopping.`
        });
        return;
      }

      // Check for unresponded utterances (when voice responses enabled)
      if (this.voicePreferences.voiceResponsesEnabled) {
        const deliveredUtterances = session.queue.utterances.filter(u => u.status === 'delivered');
        if (deliveredUtterances.length > 0) {
          res.json({
            decision: 'block',
            reason: `There are ${deliveredUtterances.length} unresponded utterances. Please speak your response before stopping.`
          });
          return;
        }
      }

      res.json({ decision: 'approve' });
    });

    // Pre-speak hook
    this.app.post('/api/hooks/pre-speak', (req, res) => {
      const { key, sessionId, agentId, agentType } = this.parseCompositeKey(req.body);
      this.registerIfFirst(key);
      const session = this.getOrCreateSession(key, sessionId, agentId, agentType);
      const speakText = req.body?.tool_input?.text;

      // Active session: check for pending utterances, whitelist text
      if (this.isActiveKey(key)) {
        const pendingUtterances = session.queue.utterances.filter(u => u.status === 'pending');
        if (pendingUtterances.length > 0) {
          res.json({
            decision: 'block',
            reason: `There are ${pendingUtterances.length} pending utterances. Please dequeue them before speaking.`
          });
          return;
        }

        // Whitelist the text for the speak endpoint
        if (speakText) {
          this.addToWhitelist(speakText);
        }

        res.json({ decision: 'approve' });
        return;
      }

      // Inactive session: store in that session's conversation history, block
      if (speakText) {
        session.queue.addAssistantMessage(speakText);
      }
      res.json({
        decision: 'block',
        reason: 'Voice output is routed to the active session only. Your message has been stored in conversation history.'
      });
    });

    // Post-tool hook
    this.app.post('/api/hooks/post-tool', (req, res) => {
      const { key, sessionId, agentId, agentType } = this.parseCompositeKey(req.body);
      this.registerIfFirst(key);
      const session = this.getOrCreateSession(key, sessionId, agentId, agentType);

      // Only route voice for active session
      if (!this.isActiveKey(key)) {
        res.json({ decision: 'approve' });
        return;
      }

      // Check for pending utterances and dequeue
      const pendingUtterances = session.queue.utterances.filter(u => u.status === 'pending');
      if (pendingUtterances.length > 0) {
        // Dequeue them
        for (const u of pendingUtterances) {
          u.status = 'delivered';
        }
        const texts = pendingUtterances.map(u => u.text).join('\n');
        res.json({
          decision: 'block',
          reason: `Voice input received:\n${texts}\n\nPlease respond to the voice input.`
        });
        return;
      }

      res.json({ decision: 'approve' });
    });
  }

  /**
   * Start the server on a random available port
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(0, () => {
        const address = this.server!.address() as AddressInfo;
        this.port = address.port;
        this.url = `http://localhost:${this.port}`;
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Stop the server and clean up resources
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.server = null;
            resolve();
          }
        });
      });
    }
  }

  /**
   * Get the Express app instance for testing with supertest
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Get the active session's queue for direct state inspection in tests
   */
  getQueue(): UtteranceQueue {
    return this.getActiveSession().queue;
  }

  /**
   * Get voice preferences for state inspection
   */
  getVoicePreferences(): VoicePreferences {
    return this.voicePreferences;
  }

  /**
   * Reset all state (useful between tests)
   */
  reset(): void {
    this.sessions.clear();
    this.voicePreferences = {
      voiceResponsesEnabled: false,
      voiceInputActive: false
    };
    this.activeCompositeKey = null;
    this.speakWhitelist.clear();
  }
}
