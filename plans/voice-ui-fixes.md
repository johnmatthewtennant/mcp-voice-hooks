# Voice UI Fixes Plan

## Context

The multi-session voice interface has 4 bugs that need fixing. The codebase uses a unified Express server (`src/unified-server.ts`) with a browser frontend (`public/app.js` + `public/index.html`). Tests use a `TestServer` helper in `src/test-utils/test-server.ts` that mirrors the server's behavior.

## Fix 1: Session switching in sidebar

### Problem
Clicking a session in the sidebar doesn't switch the active session.

### Root cause
In `renderSessionList()` (app.js line 242), session keys are embedded in HTML attributes:
```javascript
html += `<div class="${classes.join(' ')}" data-session-key="${this.escapeHtml(session.key)}" ...>`;
```

Session keys are JSON strings like `["session-A","main"]`. `escapeHtml` converts `"` to `&quot;`. When inserted into the innerHTML template string, the result is:
```html
<div data-session-key="[&quot;session-A&quot;,&quot;main&quot;]">
```

This is actually valid HTML -- `&quot;` inside an attribute delimited by `"` is correctly parsed by browsers. The `dataset.sessionKey` returns the decoded value `["session-A","main"]`. So the HTML encoding is NOT the bug.

The actual bug: the click handler on line 255-262 adds event listeners to `.session-item` elements. But `renderSessionList` is called every 3 seconds by `loadSessions()` (line 70), which replaces `innerHTML` on line 252. This destroys all DOM elements and their event listeners. The click handlers attached on lines 255-262 are immediately valid but get destroyed on the next `loadSessions()` call 3 seconds later. If the user clicks between renders, it works; if they click right after a re-render cycle started, the old handlers are gone and new ones haven't been attached yet. More importantly, the `renderSessionList` is called INSIDE `loadSessions` (line 198) which sets `this.activeSessionKey` (line 182) -- if a switch is in progress, the re-render could overwrite state.

### Fix
Delegate the click handler instead of attaching to individual items. Use event delegation on the parent `sessionList` element:

1. In `initializeSessionSidebar()`, add a single delegated click handler on `this.sessionList`:
```javascript
this.sessionList.addEventListener('click', (e) => {
    const item = e.target.closest('.session-item');
    if (!item) return;
    const key = item.dataset.sessionKey;
    if (key && key !== this.activeSessionKey) {
        this.switchActiveSession(key);
    }
});
```

2. Remove the per-element click handler attachment in `renderSessionList()` (lines 255-262).

Event delegation survives innerHTML replacement because the listener is on the parent, not the replaced children.

### Tests
- Server-side session switching is already tested in `session-state.test.ts`
- Frontend fix verified manually in browser

## Fix 2: Skip browser auto-open for secondary MCP instances

### Problem
When a second MCP instance starts and hits EADDRINUSE, it should not auto-open a browser window.

### Analysis
The auto-open code runs inside the `listen` callback (line 1057-1073). On EADDRINUSE, the `listen` callback should not fire. However, to make intent explicit and guard against any edge case:

### Fix
Register the error handler BEFORE calling listen, so we can set a flag before the listen callback could theoretically fire:

1. Create the server without starting it, attach error handler first:
```typescript
let eaddrinuseDetected = false;

const httpServer = http.createServer(app);

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    eaddrinuseDetected = true;
    // ... existing EADDRINUSE handling
  } else {
    throw err;
  }
});

httpServer.listen(HTTP_PORT, async () => {
  if (eaddrinuseDetected) return; // defensive guard
  // ... existing listen callback with auto-open logic
});
```

This restructures the server creation to attach the error handler before listen, eliminating any event ordering concern.

### Tests
No automated test -- this is a startup path not modeled by TestServer. Verified by code inspection and manual testing with two instances.

## Fix 3: Hide 'Main Session' when real sessions exist

### Problem
The default "Main Session" (`sessionId: 'default'`) appears alongside real sessions in the sidebar.

### Fix

**File: `src/unified-server.ts`** -- `/api/sessions` endpoint (line 886-900):
Add `messageCount: s.queue.messages.length` to the session data.

**File: `src/test-utils/test-server.ts`** -- `/api/sessions` route:
Mirror the `messageCount` addition.

**File: `public/app.js`** -- `renderSessionList()`:
Before building groups, filter sessions:
```javascript
const hasRealSessions = this.sessions.some(s => s.sessionId !== 'default');
const visibleSessions = hasRealSessions
    ? this.sessions.filter(s => {
        if (s.sessionId === 'default') {
            // Keep default session only if active or has content
            return s.isActive || s.messageCount > 0 || s.utteranceCount > 0;
        }
        return true;
    })
    : this.sessions;
```

Use `visibleSessions` instead of `this.sessions` when building `groups`. If the default session is kept alongside real sessions, label it "Unattached" instead of "Main Session":
```javascript
formatSessionLabel(sessionId) {
    if (sessionId === 'default') {
        const hasReal = this.sessions.some(s => s.sessionId !== 'default');
        return hasReal ? 'Unattached' : 'Main Session';
    }
    if (sessionId.length > 16) return sessionId.substring(0, 8) + '...';
    return sessionId;
}
```

### Tests
- Add test in `session-state.test.ts`: verify `/api/sessions` includes `messageCount` field

## Fix 4: Background agent voice enforcement for non-selected sessions

### Problem
Non-selected agents should still be forced to speak after tool use when voice responses are enabled, but their TTS output should be stored in history (not played aloud).

### Current behavior
- Post-tool: inactive sessions get instant `approve`, `lastToolUseTimestamp` NOT set
- Stop: inactive sessions get instant `approve`, no enforcement
- Pre-speak: inactive sessions blocked, text stored in history, `lastSpeakTimestamp` NOT set

### Fix

**File: `src/unified-server.ts`**

1. **Post-tool hook** (line 741-745): Set `lastToolUseTimestamp` for inactive sessions:
```typescript
if (!isActiveKey(key)) {
  session.lastToolUseTimestamp = new Date();
  debugLog(`[Hook] post-tool: key=${key} active=false (approve, tracking tool use)`);
  res.json({ decision: 'approve' });
  return;
}
```

2. **Pre-speak hook** (line 723-732): Update `lastSpeakTimestamp` for inactive sessions so the stop hook requirement is satisfied:
```typescript
if (speakText) {
  session.queue.addAssistantMessage(speakText);
  session.lastSpeakTimestamp = new Date();
  debugLog(`[Speak] Stored for inactive session: key=${key} text="${speakText.slice(0, 30)}..."`);
}
res.json({
  decision: 'block',
  reason: 'Voice output stored in session history. TTS is routed to the active session only.'
});
```
Note: the block reason is updated to clarify that output was stored, not lost.

3. **Stop hook** (line 694-698): Enforce "must speak after tool use" for inactive sessions:
```typescript
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
```
Note: the block reason is distinct from the active session message, clarifying that output goes to history not TTS.

**File: `src/test-utils/test-server.ts`**

Mirror all three changes in the test server's corresponding hook handlers.

### Tests

Add to `session-state.test.ts`:

1. **Inactive session stop blocks when unspoken after tool use:**
   - Register session-A as active via post-tool
   - Enable voice responses
   - Call post-tool for session-B (creates session, sets lastToolUseTimestamp)
   - Call stop for session-B
   - Expect: `{ decision: 'block' }` with reason about needing to speak

2. **Inactive session pre-speak satisfies speak requirement:**
   - Continue from above
   - Call pre-speak for session-B with `{ tool_input: { text: 'response' } }`
   - Expect: `{ decision: 'block' }` (TTS blocked, but lastSpeakTimestamp updated)
   - Call stop for session-B
   - Expect: `{ decision: 'approve' }`

3. **Inactive session stop approves with no prior tool use:**
   - Register session-A as active via post-tool
   - Enable voice responses
   - Call stop for brand-new session-C (creates via stop, no lastToolUseTimestamp)
   - Expect: `{ decision: 'approve' }`

## Implementation Order

1. Fix 3 (server + frontend, small)
2. Fix 2 (server restructuring, small)
3. Fix 1 (frontend event delegation fix)
4. Fix 4 (server + test server + new tests)

## Build and Test

After each fix:
```bash
cd /Users/jtennant/Development/mcp-voice-hooks
npm run build && npx jest --no-coverage
```

## References

- Server: `src/unified-server.ts`
- Frontend: `public/app.js`, `public/index.html`
- Test server: `src/test-utils/test-server.ts`
- Session tests: `src/__tests__/session-state.test.ts`
