import { TestServer } from '../test-utils/test-server.js';

/**
 * Tests for the post-tool hook behavior.
 *
 * The post-tool hook fires after every non-voice-hooks tool execution.
 * Its responsibilities:
 * 1. Auto-dequeue pending voice utterances and deliver them to Claude
 * 2. Track lastToolUseTimestamp for "must speak after tool use" enforcement
 * 3. Approve immediately when no pending utterances exist
 * 4. For inactive (non-selected) sessions, just track tool use without routing voice
 *
 * Note: These tests run against TestServer which mirrors but simplifies production
 * unified-server.ts behavior. Key difference: TestServer's active-session post-tool
 * path doesn't set lastToolUseTimestamp (production does via handleHookRequest).
 * The inactive-session path does set it in both.
 */
describe('POST /api/hooks/post-tool', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('basic behavior (no pending utterances)', () => {
    it('should approve when no utterances exist', async () => {
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.decision).toBe('approve');
    });

    it('should approve when voice is inactive and no utterances exist', async () => {
      // Voice is off by default
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('should approve when voice is active but no utterances exist', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('post-tool voice input delivery', () => {
    it('should block and deliver pending utterances after tool use', async () => {
      // Enable voice
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session via first hook call
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // User speaks while Claude is using a tool
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Actually, do it differently' })
      });

      // Post-tool hook fires after tool completes
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('Actually, do it differently');
    });

    it('should deliver multiple pending utterances at once', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Multiple utterances arrive while tool executes
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Wait' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'I changed my mind' })
      });

      // Post-tool hook fires
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('Wait');
      expect(data.reason).toContain('I changed my mind');

      // Verify ordering: first utterance appears before second in the response
      const waitIdx = data.reason.indexOf('Wait');
      const changedIdx = data.reason.indexOf('I changed my mind');
      expect(waitIdx).toBeGreaterThanOrEqual(0);
      expect(changedIdx).toBeGreaterThanOrEqual(0);
      expect(waitIdx).toBeLessThan(changedIdx);
    });

    it('should mark delivered utterances as delivered (not pending)', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Add utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      // Verify pending before hook
      let statusRes = await fetch(`${server.url}/api/utterances/status`);
      let statusData = await statusRes.json() as any;
      expect(statusData.pending).toBe(1);
      expect(statusData.delivered).toBe(0);

      // Post-tool hook auto-dequeues
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Verify delivered after hook
      statusRes = await fetch(`${server.url}/api/utterances/status`);
      statusData = await statusRes.json() as any;
      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(1);
    });

    // Note: TestServer post-tool only checks for pending utterances (not delivered).
    // Production handleHookRequest would block when delivered utterances exist and voice
    // is active, requiring speak first. This test validates the TestServer behavior.
    it('should approve on subsequent hook call after utterances already delivered', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Add and deliver utterance via post-tool hook
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Next post-tool hook should approve (no new pending utterances)
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('voice input delivery without voice active', () => {
    it('should still deliver pending utterances even when voice is off (typed messages)', async () => {
      // Voice is off by default - typed messages can still be submitted via browser

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Typed message submitted through browser
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'typed message from browser' })
      });

      // Post-tool hook should still deliver it
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('typed message from browser');
    });
  });

  // Tool use timestamp tracking is tested in the 'inactive session behavior' section
  // to avoid duplication. The inactive-session path is the one that explicitly sets
  // lastToolUseTimestamp in the TestServer (matching production behavior).

  describe('interaction with stop hook', () => {
    // Note: TestServer stop hook does NOT implement the production "must speak after tool use"
    // rule (lastToolUseTimestamp vs lastSpeakTimestamp). It only checks for pending/delivered
    // utterances. The production handleHookRequest blocks stop when voice is active and
    // lastToolUseTimestamp > lastSpeakTimestamp. Testing that rule requires the production
    // server or updating TestServer to match.

    it('should allow stop after speaking following tool use', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session via post-tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Whitelist speak text via pre-speak hook
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'test-session',
          tool_input: { text: 'I completed the task' }
        })
      });

      // Speak after tool use
      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'I completed the task' })
      });

      // Stop should now be allowed (no pending/delivered utterances)
      const stopRes = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const stopData = await stopRes.json() as any;
      expect(stopData.decision).toBe('approve');
    });
  });

  describe('full conversation flow through hooks', () => {
    it('should support: tool use -> voice input arrives -> post-tool delivers -> speak -> approve', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // 1. First post-tool registers session (simulates initial tool use)
      const firstRes = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      expect((await firstRes.json() as any).decision).toBe('approve');

      // 2. User speaks while Claude uses another tool
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Can you also fix the tests?' })
      });

      // 3. Post-tool hook fires after tool - delivers the utterance
      const deliveryRes = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      const deliveryData = await deliveryRes.json() as any;
      expect(deliveryData.decision).toBe('block');
      expect(deliveryData.reason).toContain('Can you also fix the tests?');

      // 4. Verify utterance is now delivered
      const statusRes = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusRes.json() as any;
      expect(statusData.pending).toBe(0);
      expect(statusData.delivered).toBe(1);

      // 5. Claude speaks response (whitelist + speak)
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'test-session',
          tool_input: { text: 'Sure, I will fix the tests too.' }
        })
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Sure, I will fix the tests too.' })
      });

      // 6. Verify utterance is now responded
      const finalStatusRes = await fetch(`${server.url}/api/utterances/status`);
      const finalStatusData = await finalStatusRes.json() as any;
      expect(finalStatusData.delivered).toBe(0);
      expect(finalStatusData.responded).toBe(1);

      // 7. Next post-tool hook should approve (clean state)
      const nextRes = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      expect((await nextRes.json() as any).decision).toBe('approve');
    });

    it('should support multiple conversation turns through post-tool hooks', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Turn 1: User speaks -> post-tool delivers -> speak responds
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First question' })
      });

      let res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      let data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('First question');

      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'test-session',
          tool_input: { text: 'First answer' }
        })
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'First answer' })
      });

      // Turn 2: User speaks again -> post-tool delivers -> speak responds
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Follow-up question' })
      });

      res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('Follow-up question');

      // Verify conversation has correct state
      const statusRes = await fetch(`${server.url}/api/utterances/status`);
      const statusData = await statusRes.json() as any;
      expect(statusData.responded).toBe(1); // First turn responded
      expect(statusData.delivered).toBe(1); // Second turn delivered
      expect(statusData.pending).toBe(0);
    });
  });

  describe('pre-speak hook blocks when utterances are pending', () => {
    it('should block speak when there are pending utterances (must dequeue first)', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // User speaks
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Wait' })
      });

      // Pre-speak should block because there are pending utterances
      const res = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'test-session',
          tool_input: { text: 'some response' }
        })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('pending');
    });

    it('should allow speak after post-tool hook delivers utterances', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // User speaks
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Please help' })
      });

      // Post-tool delivers the utterance
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Now pre-speak should allow (no pending, only delivered)
      const res = await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'test-session',
          tool_input: { text: 'Here is my help' }
        })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('stop hook blocks when unresponded utterances exist', () => {
    it('should block stop when delivered utterances have not been responded to', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // User speaks, post-tool delivers
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hey' })
      });

      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Stop should be blocked - there are unresponded (delivered) utterances
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('block');
      expect(data.reason).toContain('unresponded');
    });

    it('should allow stop after delivered utterances are responded to via speak', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session, add utterance, deliver via post-tool
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Question' })
      });

      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Speak to respond
      await fetch(`${server.url}/api/hooks/pre-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'test-session',
          tool_input: { text: 'Answer' }
        })
      });

      await fetch(`${server.url}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Answer' })
      });

      // Stop should be allowed now
      const res = await fetch(`${server.url}/api/hooks/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });
  });

  describe('inactive session behavior', () => {
    it('should approve immediately for inactive sessions', async () => {
      // Register first session as active
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'active-session' })
      });

      // Add an utterance to the active session
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' })
      });

      // Second (inactive) session should approve regardless of active session's utterances
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'inactive-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('should still track lastToolUseTimestamp for inactive sessions', async () => {
      // Register active session first
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'active-session' })
      });

      // Register inactive session
      const beforeTime = new Date();
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'bg-session' })
      });
      const afterTime = new Date();

      // Check bg-session has tool use timestamp within the expected range
      const bgKey = JSON.stringify(['bg-session', 'main']);
      const bgSession = server.sessions.get(bgKey);
      expect(bgSession).toBeDefined();
      expect(bgSession!.lastToolUseTimestamp).toBeInstanceOf(Date);
      expect(bgSession!.lastToolUseTimestamp!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(bgSession!.lastToolUseTimestamp!.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('edge cases', () => {
    it('should handle rapid successive post-tool calls', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Add utterance
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Interrupt' })
      });

      // First post-tool delivers the utterance
      const res1 = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      const data1 = await res1.json() as any;
      expect(data1.decision).toBe('block');

      // Second post-tool immediately after has nothing to deliver
      const res2 = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      const data2 = await res2.json() as any;
      expect(data2.decision).toBe('approve');
    });

    it('should handle post-tool after queue clear', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session and add utterance
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Will be cleared' })
      });

      // Clear queue
      await fetch(`${server.url}/api/utterances`, { method: 'DELETE' });

      // Post-tool should approve (nothing pending after clear)
      const res = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      const data = await res.json() as any;
      expect(data.decision).toBe('approve');
    });

    it('should handle utterance arriving between post-tool calls in a tool chain', async () => {
      await fetch(`${server.url}/api/voice-active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true })
      });

      // Register session
      await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });

      // Tool 1 completes - no utterances
      const res1 = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      expect((await res1.json() as any).decision).toBe('approve');

      // User speaks between tool 1 and tool 2
      await fetch(`${server.url}/api/potential-utterances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Actually stop' })
      });

      // Tool 2 completes - utterance gets delivered
      const res2 = await fetch(`${server.url}/api/hooks/post-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'test-session' })
      });
      const data2 = await res2.json() as any;
      expect(data2.decision).toBe('block');
      expect(data2.reason).toContain('Actually stop');
    });
  });
});
