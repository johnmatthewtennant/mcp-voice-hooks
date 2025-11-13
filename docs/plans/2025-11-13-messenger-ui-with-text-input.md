# Messenger-Style UI with Text Input Implementation Plan

## Overview

Transform the current list-based utterance display into a modern messenger-style conversation interface, similar to WhatsApp or iMessage. Add text input capability with integrated voice dictation button, allowing users to type messages manually or use voice input seamlessly within the same interface.

## Current State Analysis

**Existing UI (`public/index.html` + `public/app.js`):**
- Simple reverse-chronological list of utterances with status badges
- "Start Listening" button at top of page
- Real-time interim speech transcription displayed above button
- Auto-refresh every 2 seconds via polling `/api/utterances?limit=20`
- Two send modes: automatic (send on pause) and wait-for-trigger-word (queue until trigger)
- Utterances display: text, timestamp, and status (PENDING/DELIVERED/RESPONDED)

**Backend (`src/unified-server.ts`):**
- `UtteranceQueue` stores user messages with 3 states: pending → delivered → responded
- `/api/speak` endpoint receives Claude's response text but doesn't store it
- `/api/potential-utterances` creates new user utterances
- SSE connection (`/api/tts-events`) for real-time updates

**Key Discoveries:**
- Claude's spoken responses are tracked via utterance status changes but text is not stored
- Web Speech API provides automatic pause detection for voice input
- Trigger word mode queues messages in browser memory (`app.js:27`)
- Current layout uses flex column with fixed-height utterance section

## Desired End State

**User Experience:**
- Messenger-style conversation interface with user messages on right (blue bubbles), Claude responses on left (gray bubbles)
- Text input field at bottom with integrated microphone button inside the input (right side)
- When dictating, interim speech appears in the text input field in real-time
- Enter key sends typed messages; microphone button toggles voice dictation
- Trigger word mode preserved: toggle between auto-send and queue-until-trigger
- Timestamps and status indicators shown subtly within chat bubbles
- Messages auto-scroll to bottom, showing most recent conversation

**Verification:**
1. Open browser to `http://localhost:5111`
2. Type "hello" in text input and press Enter → Message appears as right-side blue bubble with "PENDING" status
3. Click microphone button and speak "test message" → Text appears in input field as you speak, sends on pause
4. Claude responds via speak tool → Response appears as left-side gray bubble
5. Toggle to trigger word mode, say multiple messages, then say trigger word → All messages send at once
6. Refresh page → Conversation history persists with all messages and statuses

## What We're NOT Doing

- WebSocket implementation (keeping HTTP polling + SSE)
- Message editing or deletion after sending
- Read receipts or typing indicators
- Multi-user conversations or user authentication
- Local storage persistence (server remains source of truth)
- Rich text formatting or emoji picker
- File/image attachments
- Voice message recording (separate from live dictation)
- Removing old UI (kept as backup with --legacy-ui flag)

## Implementation Approach

**Four-Phase Strategy with TDD:**

1. **Backend Enhancement (TDD)**: Extend data model to store Claude's response messages, add new API endpoint, write tests first for each change
2. **New Messenger UI (Parallel Development)**: Build completely new frontend files (`messenger.html`, `messenger.js`) alongside existing UI
3. **CLI Flag & Routing**: Add `--legacy-ui` flag to serve old UI, default to new messenger UI
4. **Text Input Integration (TDD)**: Add text input with voice dictation, test each feature with green-red-green cycles

**Key Technical Decisions:**

- **Backwards Compatible**: Keep `index.html` and `app.js` untouched, create new `messenger.html` and `messenger.js`
- **CLI Flag**: Add `--legacy-ui` flag to `bin/cli.js`, route `/` based on flag
- **TDD Discipline**: Write failing test first (RED), implement feature (GREEN), verify test catches bugs (RED), fix (GREEN)
- **Store Messages**: Add `ConversationMessage` objects with `role: 'user' | 'assistant'`
- **Trigger Word Simplification**: Accumulate all speech in text input field until trigger word is said, then send as single message (no separate queue preview UI)
- **CSS Flexbox**: Chat bubble layout (user: `flex-end`, Claude: `flex-start`)
- **Microphone Button**: Toggles `isListening` state inside text input

## TDD Strategy

**Every change follows strict Red-Green-Refactor:**

1. **RED**: Write a failing test that describes the desired behavior
2. **GREEN**: Implement minimal code to make the test pass
3. **RED (verification)**: Intentionally break the implementation to verify test catches it
4. **GREEN**: Fix the break to confirm test works correctly
5. **REFACTOR**: Clean up code while keeping tests green

**Example for Phase 1 (Backend)**:
- Test: POST to `/api/speak` should create assistant message in `/api/conversation`
- RED: Test fails (endpoint doesn't store messages yet)
- GREEN: Add `queue.addAssistantMessage(text)` to make test pass
- RED: Comment out the line → test fails (verification)
- GREEN: Uncomment → test passes
- REFACTOR: Extract message storage logic if needed

## Phase 1: Backend - Message Storage Enhancement (TDD)

### Overview
Extend the backend to store both user utterances and Claude's responses as distinct conversation messages, enabling full conversation history display. Use strict TDD: write tests first, implement to pass, verify tests catch bugs.

### Changes Required:

#### 1. Data Model Extension
**File**: `src/unified-server.ts`

**Changes**:
1. Add new `ConversationMessage` interface (around line 42, after `Utterance` interface):

```typescript
interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
  status?: 'pending' | 'delivered' | 'responded'; // Only for user messages
}
```

2. Add `messages` array to store full conversation in `UtteranceQueue` class (around line 49):

```typescript
class UtteranceQueue {
  utterances: Utterance[] = [];
  messages: ConversationMessage[] = []; // NEW: Full conversation history

  add(text: string, timestamp?: Date): Utterance {
    const utterance: Utterance = {
      id: randomUUID(),
      text: text.trim(),
      timestamp: timestamp || new Date(),
      status: 'pending'
    };
    this.utterances.push(utterance);

    // NEW: Also add to messages array
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

  // NEW: Method to add assistant messages
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

  // NEW: Method to get recent conversation
  getRecentMessages(limit: number = 50): ConversationMessage[] {
    return this.messages
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()) // Oldest first for conversation
      .slice(-limit); // Get last N messages
  }

  markDelivered(id: string): void {
    const utterance = this.utterances.find(u => u.id === id);
    if (utterance) {
      utterance.status = 'delivered';
      debugLog(`[Queue] delivered: "${utterance.text}"	[id: ${id}]`);

      // NEW: Update status in messages array too
      const message = this.messages.find(m => m.id === id && m.role === 'user');
      if (message) {
        message.status = 'delivered';
      }
    }
  }

  clear(): void {
    const count = this.utterances.length;
    this.utterances = [];
    this.messages = []; // NEW: Clear conversation history too
    debugLog(`[Queue] Cleared ${count} utterances and ${this.messages.length} messages`);
  }
}
```

3. Update `markDelivered` and status updates in speak endpoint to sync with messages array.

#### 2. New API Endpoint for Conversation
**File**: `src/unified-server.ts`

**Add new endpoint** (after `/api/utterances/status`, around line 153):

```typescript
// GET /api/conversation - Returns full conversation history
app.get('/api/conversation', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const messages = queue.getRecentMessages(limit);

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
```

#### 3. Update Speak Endpoint to Store Assistant Messages
**File**: `src/unified-server.ts`

**Modify** `/api/speak` endpoint (around line 590-636):

```typescript
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

    // NEW: Store assistant's response in conversation history
    queue.addAssistantMessage(text);

    // Mark all delivered utterances as responded
    const deliveredUtterances = queue.utterances.filter(u => u.status === 'delivered');
    deliveredUtterances.forEach(u => {
      u.status = 'responded';
      debugLog(`[Queue] marked as responded: "${u.text}"	[id: ${u.id}]`);

      // NEW: Update status in messages array
      const message = queue.messages.find(m => m.id === u.id && m.role === 'user');
      if (message) {
        message.status = 'responded';
      }
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
```

### TDD Test Plan:

#### Test 1: GET /api/conversation returns empty array initially
- **RED**: Write test expecting GET `/api/conversation` returns `{ messages: [] }`
- **GREEN**: Add endpoint that returns `queue.getRecentMessages(limit)`
- **RED (verify)**: Make endpoint return `null` → test fails ✓
- **GREEN**: Fix to return proper array → test passes ✓

#### Test 2: User message appears in conversation
- **RED**: POST to `/api/potential-utterances` then GET `/api/conversation` should include user message
- **GREEN**: Modify `queue.add()` to also push to `messages` array
- **RED (verify)**: Comment out the messages push → test fails ✓
- **GREEN**: Uncomment → test passes ✓

#### Test 3: Assistant message stored when speak is called
- **RED**: POST to `/api/speak` then GET `/api/conversation` should include assistant message
- **GREEN**: Add `queue.addAssistantMessage(text)` in speak endpoint
- **RED (verify)**: Comment out the call → test fails ✓
- **GREEN**: Uncomment → test passes ✓

#### Test 4: Status updates sync between arrays
- **RED**: Dequeue user message, both `/api/utterances` and `/api/conversation` should show status='delivered'
- **GREEN**: Update `markDelivered()` to sync status in messages array
- **RED (verify)**: Remove sync code → test fails ✓
- **GREEN**: Re-add sync → test passes ✓

#### Test 5: Conversation ordering
- **RED**: Add 3 messages with different timestamps, verify `/api/conversation` returns oldest-first
- **GREEN**: Implement sort in `getRecentMessages()`
- **RED (verify)**: Reverse the sort → test fails ✓
- **GREEN**: Fix sort → test passes ✓

### Success Criteria:

#### Automated Verification:
- [ ] All TDD tests pass: `npm test -- conversation-api.test.ts`
- [ ] Build works: `npm run build`
- [ ] All existing tests still pass: `npm test`
- [ ] TypeScript compilation succeeds with no errors

#### Manual Verification:
- [ ] Start server: `npx mcp-voice-hooks`
- [ ] POST to `/api/potential-utterances` with text → Response includes user message
- [ ] GET `/api/conversation` → Returns array with role='user' message
- [ ] POST to `/api/speak` with text → Response succeeds
- [ ] GET `/api/conversation` → Returns array with both user and assistant messages
- [ ] Verify message ordering: oldest first (conversation order)
- [ ] Verify status updates sync between `utterances` and `messages` arrays
- [ ] Old UI still works at `http://localhost:5111/` (no regression)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the backend correctly stores and returns conversation history before proceeding to the UI phase.

---

## Phase 2: New Messenger UI (Parallel Development)

### Overview
Build completely new frontend files (`messenger.html`, `messenger.js`, `messenger.css`) that implement the messenger-style conversation interface. Keep existing UI intact as backup.

### Changes Required:

#### 1. Create New HTML File
**File**: `public/messenger.html` (NEW FILE)

**Create** new messenger interface (based on `index.html` but with conversation UI):

```html
<!-- Conversation Section -->
<div class="conversation-section">
    <div class="conversation-header">
        <h3>Conversation</h3>
        <div class="conversation-actions">
            <button id="refreshBtn" class="icon-button" title="Refresh">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
            </button>
            <button id="clearAllBtn" class="icon-button danger" title="Clear All">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                </svg>
            </button>
        </div>
    </div>

    <!-- Conversation Messages -->
    <div id="conversationContainer" class="conversation-container">
        <div id="conversationMessages" class="conversation-messages">
            <div class="empty-state">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="#999">
                    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
                </svg>
                <p id="emptyStateMessage">No messages yet. Type or speak to start the conversation!</p>
            </div>
        </div>
    </div>
</div>
```

#### 2. Create New CSS (or embed in messenger.html)
**File**: `public/messenger.html` (embedded `<style>` tag)

**Add messenger-specific styles**:

```css
/* Conversation Section */
.conversation-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    overflow: hidden;
    min-height: 400px;
}

.conversation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid #E0E0E0;
    background: #F8F9FA;
}

.conversation-header h3 {
    margin: 0;
    font-size: 18px;
    color: #333;
}

.conversation-actions {
    display: flex;
    gap: 8px;
}

.icon-button {
    background: white;
    border: 1px solid #DDD;
    border-radius: 6px;
    padding: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.icon-button:hover {
    background: #F0F0F0;
    border-color: #BBB;
}

.icon-button.danger:hover {
    background: #FFEBEE;
    border-color: #EF5350;
}

.icon-button svg {
    fill: #666;
}

.icon-button.danger:hover svg {
    fill: #EF5350;
}

/* Conversation Container */
.conversation-container {
    flex: 1;
    overflow-y: auto;
    background: #F5F5F5;
    position: relative;
}

.conversation-messages {
    display: flex;
    flex-direction: column;
    padding: 20px;
    gap: 12px;
    min-height: 100%;
}

/* Empty State */
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #999;
    text-align: center;
    padding: 40px 20px;
}

.empty-state p {
    margin-top: 16px;
    font-size: 16px;
}

/* Message Bubbles */
.message-bubble {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 18px;
    word-wrap: break-word;
    position: relative;
    animation: messageSlideIn 0.2s ease-out;
}

@keyframes messageSlideIn {
    from {
        opacity: 0;
        transform: translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* User Messages (Right Side, Blue) */
.message-bubble.user {
    align-self: flex-end;
    background: #007AFF;
    color: white;
    border-bottom-right-radius: 4px;
}

/* Assistant Messages (Left Side, Gray) */
.message-bubble.assistant {
    align-self: flex-start;
    background: #E5E5EA;
    color: #000;
    border-bottom-left-radius: 4px;
}

.message-text {
    font-size: 15px;
    line-height: 1.4;
    margin-bottom: 4px;
}

.message-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    font-size: 11px;
    opacity: 0.7;
}

.message-bubble.user .message-meta {
    color: rgba(255, 255, 255, 0.8);
}

.message-bubble.assistant .message-meta {
    color: rgba(0, 0, 0, 0.5);
}

.message-timestamp {
    white-space: nowrap;
}

.message-status {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    white-space: nowrap;
}

/* Status Colors for User Messages */
.message-bubble.user .message-status.pending {
    color: #FFE082;
}

.message-bubble.user .message-status.delivered {
    color: #B3E5FC;
}

.message-bubble.user .message-status.responded {
    color: #C8E6C9;
}

/* Scrollbar Styling */
.conversation-container::-webkit-scrollbar {
    width: 8px;
}

.conversation-container::-webkit-scrollbar-track {
    background: #F5F5F5;
}

.conversation-container::-webkit-scrollbar-thumb {
    background: #CCC;
    border-radius: 4px;
}

.conversation-container::-webkit-scrollbar-thumb:hover {
    background: #AAA;
}
```

#### 3. Create New JavaScript File
**File**: `public/messenger.js` (NEW FILE - copy from `app.js` and modify)

**Replace** `updateUtterancesList` method with new `updateConversation` method:

```javascript
async loadData() {
    try {
        // NEW: Load full conversation instead of just utterances
        const conversationResponse = await fetch(`${this.baseUrl}/api/conversation?limit=50`);
        if (conversationResponse.ok) {
            const data = await conversationResponse.json();
            this.updateConversation(data.messages);
        }

        // Still load status for potential future use
        const statusResponse = await fetch(`${this.baseUrl}/api/utterances/status`);
        if (statusResponse.ok) {
            const data = await statusResponse.json();
            // Can use this for showing counts in UI if desired
        }
    } catch (error) {
        console.error('Failed to load data:', error);
    }
}

updateConversation(messages) {
    const container = document.getElementById('conversationMessages');
    const emptyState = container.querySelector('.empty-state');

    if (messages.length === 0) {
        emptyState.style.display = 'flex';
        // Remove any existing message bubbles
        container.querySelectorAll('.message-bubble').forEach(el => el.remove());
        return;
    }

    emptyState.style.display = 'none';

    // Clear existing messages (except empty state)
    container.querySelectorAll('.message-bubble').forEach(el => el.remove());

    // Render all messages in chronological order (oldest first)
    messages.forEach(message => {
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${message.role}`;
        bubble.dataset.messageId = message.id;

        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.textContent = message.text;

        const messageMeta = document.createElement('div');
        messageMeta.className = 'message-meta';

        const timestamp = document.createElement('span');
        timestamp.className = 'message-timestamp';
        timestamp.textContent = this.formatTimestamp(message.timestamp);

        messageMeta.appendChild(timestamp);

        // Only show status for user messages
        if (message.role === 'user' && message.status) {
            const status = document.createElement('span');
            status.className = `message-status ${message.status}`;
            status.textContent = message.status.toUpperCase();
            messageMeta.appendChild(status);
        }

        bubble.appendChild(messageText);
        bubble.appendChild(messageMeta);
        container.appendChild(bubble);
    });

    // Auto-scroll to bottom
    this.scrollToBottom();
}

scrollToBottom() {
    const container = document.getElementById('conversationContainer');
    // Smooth scroll to bottom
    container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
    });
}
```

**Update** queued utterances display for trigger word mode (add new method around line 870):

```javascript
// No queue preview UI needed! Trigger word mode simply accumulates in the text input.
// The logic is much simpler - just append to messageInput.value with newlines.

### Success Criteria:

#### Automated Verification:
- [ ] Build works: `npm run build`
- [ ] No console errors when loading page
- [ ] No TypeScript/JavaScript syntax errors

#### Manual Verification:
- [ ] Open browser to `http://localhost:5111`
- [ ] Empty state shows when no messages exist
- [ ] POST test message via curl → Message appears as blue bubble on right
- [ ] POST speak via curl → Response appears as gray bubble on left
- [ ] User messages show status badges (PENDING/DELIVERED/RESPONDED)
- [ ] Assistant messages don't show status
- [ ] Timestamps display correctly on both message types
- [ ] Messages are ordered oldest-first (chronological conversation order)
- [ ] Container auto-scrolls to bottom when new messages arrive
- [ ] Refresh button re-fetches and displays latest conversation
- [ ] Clear All button removes all messages
- [ ] Toggle to trigger word mode
- [ ] Speak "first message", pause, speak "second message" → Both accumulate in text input with newlines
- [ ] Speak trigger word "send" → All accumulated text sends as single blue bubble

**Implementation Note**: After completing this phase, verify that the messenger UI displays correctly at `http://localhost:5111/messenger.html` before proceeding to CLI routing.

---

## Phase 3: CLI Flag & UI Routing

### Overview
Add `--legacy-ui` CLI flag to allow switching between old and new UIs. Default to new messenger UI, but allow users to access legacy UI if needed.

### Changes Required:

#### 1. Add CLI Flag Parsing
**File**: `bin/cli.js`

**Modify** argument parsing (around line 20-30):

```javascript
// Parse command line arguments
const args = process.argv.slice(2);

// Check for flags
const debugMode = args.includes('--debug') || args.includes('-d');
const useLegacyUI = args.includes('--legacy-ui'); // NEW
const skipHooks = args.includes('--skip-hooks');

// ... rest of CLI logic

// Pass flag to server via environment
if (useLegacyUI) {
    process.env.MCP_VOICE_HOOKS_LEGACY_UI = 'true';
}
```

#### 2. Update Server Routing
**File**: `src/unified-server.ts`

**Modify** root route (around line 666):

```typescript
app.get('/', (_req: Request, res: Response) => {
  const useLegacyUI = process.env.MCP_VOICE_HOOKS_LEGACY_UI === 'true';
  const htmlFile = useLegacyUI ? 'index.html' : 'messenger.html';

  debugLog(`[HTTP] Serving ${htmlFile} for root route`);
  res.sendFile(path.join(__dirname, '..', 'public', htmlFile));
});

// NEW: Explicit routes for both UIs
app.get('/legacy', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/messenger', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'messenger.html'));
});
```

#### 3. Update Help Text
**File**: `bin/cli.js`

**Update** help display (around line 55-75):

```javascript
function showHelp() {
  console.log(`
mcp-voice-hooks - Voice Mode for Claude Code

Usage:
  npx mcp-voice-hooks [options]
  npx mcp-voice-hooks install-hooks
  npx mcp-voice-hooks uninstall

Options:
  --debug, -d        Enable debug logging
  --speak            Enable voice responses (text-to-speech)
  --legacy-ui        Use legacy list-based UI instead of messenger interface
  --skip-hooks       Skip automatic hook installation
  --version, -v      Show version number
  --help, -h         Show this help message

Examples:
  npx mcp-voice-hooks                    # Start with new messenger UI
  npx mcp-voice-hooks --legacy-ui        # Start with legacy list UI
  npx mcp-voice-hooks --speak --debug    # Enable voice responses with debug logging
  npx mcp-voice-hooks install-hooks      # Install/update Claude Code hooks

UI Access:
  Default:  http://localhost:5111/           (messenger UI)
  Legacy:   http://localhost:5111/legacy     (always available)
  Messenger: http://localhost:5111/messenger (always available)
`);
}
```

### TDD Test Plan:

#### Test 1: Default route serves messenger.html
- **RED**: GET `/` without flag should serve messenger.html
- **GREEN**: Update routing logic
- **RED (verify)**: Make it serve index.html → test fails ✓
- **GREEN**: Fix to serve messenger.html → test passes ✓

#### Test 2: Legacy flag serves index.html
- **RED**: Start server with `--legacy-ui`, GET `/` should serve index.html
- **GREEN**: Add flag parsing and environment variable
- **RED (verify)**: Remove flag check → test fails ✓
- **GREEN**: Re-add check → test passes ✓

#### Test 3: Explicit /legacy route always works
- **RED**: GET `/legacy` should serve index.html regardless of flag
- **GREEN**: Add `/legacy` route
- **RED (verify)**: Make it serve messenger.html → test fails ✓
- **GREEN**: Fix to serve index.html → test passes ✓

#### Test 4: Explicit /messenger route always works
- **RED**: GET `/messenger` should serve messenger.html regardless of flag
- **GREEN**: Add `/messenger` route
- **RED (verify)**: Make it serve index.html → test fails ✓
- **GREEN**: Fix to serve messenger.html → test passes ✓

### Success Criteria:

#### Automated Verification:
- [ ] All TDD tests pass: `npm test -- ui-routing.test.ts`
- [ ] Build works: `npm run build`
- [ ] All existing tests still pass: `npm test`

#### Manual Verification:
- [ ] Start server normally: `npx mcp-voice-hooks`
- [ ] Visit `http://localhost:5111/` → Loads messenger UI ✓
- [ ] Visit `http://localhost:5111/legacy` → Loads old UI ✓
- [ ] Visit `http://localhost:5111/messenger` → Loads messenger UI ✓
- [ ] Restart with `--legacy-ui` flag: `npx mcp-voice-hooks --legacy-ui`
- [ ] Visit `http://localhost:5111/` → Loads old UI ✓
- [ ] Visit `http://localhost:5111/messenger` → Still loads messenger UI ✓
- [ ] Both UIs function correctly (can send utterances, see updates)
- [ ] Auto-browser-open opens correct UI based on flag

**Implementation Note**: After completing this phase, verify both UIs are accessible and function correctly before proceeding to text input integration.

---

## Phase 4: Text Input with Integrated Voice Dictation (TDD)

### Overview
Add a text input field at the bottom of the messenger conversation with an integrated microphone button inside the input (WhatsApp-style). Move interim speech transcription into the input field, allow typing and voice dictation seamlessly. Use TDD for each interactive feature.

### Changes Required:

#### 1. HTML Structure for Text Input
**File**: `public/messenger.html`

**Add** text input section (at bottom of conversation section):

```html
<!-- Text Input Section -->
<div class="text-input-section">
    <!-- Send Mode Controls -->
    <div class="send-mode-controls">
        <div class="send-mode-radio">
            <input type="radio" id="autoMode" name="sendMode" value="automatic" checked>
            <label for="autoMode">Auto-send on pause</label>
        </div>
        <div class="send-mode-radio">
            <input type="radio" id="triggerMode" name="sendMode" value="trigger">
            <label for="triggerMode">Wait for trigger word</label>
        </div>
        <div class="trigger-word-input" id="triggerWordInputContainer" style="display: none;">
            <input
                type="text"
                id="triggerWordInput"
                placeholder="Enter trigger word (e.g., 'send', 'go')"
                value="send"
            >
        </div>
    </div>

    <!-- Listening Indicator (shows when voice is active) -->
    <div id="listeningIndicator" class="listening-indicator">
        <span class="listening-dot"></span>
        <span>Listening...</span>
    </div>

    <!-- Text Input with Microphone Button -->
    <div class="input-container">
        <textarea
            id="messageInput"
            class="message-input"
            placeholder="Type a message or use voice..."
            rows="1"
        ></textarea>
        <button id="micBtn" class="mic-button" title="Voice dictation">
            <svg class="mic-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                <path d="M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1ZM19 12C19 15.53 16.39 18.44 13 18.93V22H11V18.93C7.61 18.44 5 15.53 5 12H7C7 14.76 9.24 17 12 17C14.76 17 17 14.76 17 12H19Z" />
            </svg>
        </button>
    </div>
</div>
```

#### 2. CSS Styling for Text Input
**File**: `public/index.html`

**Add new styles** (replace old `.voice-controls` styles, around line 220):

```css
/* Text Input Section */
.text-input-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: white;
    padding: 16px;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

/* Send Mode Controls */
.send-mode-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
}

.send-mode-radio {
    display: flex;
    align-items: center;
    gap: 6px;
}

.send-mode-radio input[type="radio"] {
    cursor: pointer;
}

.send-mode-radio label {
    font-size: 14px;
    color: #666;
    cursor: pointer;
}

.trigger-word-input {
    flex: 1;
    min-width: 200px;
}

.trigger-word-input input {
    width: 100%;
    padding: 6px 12px;
    border: 1px solid #DDD;
    border-radius: 6px;
    font-size: 14px;
}

/* Listening Indicator */
.listening-indicator {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #FFEBEE;
    border: 1px solid #EF5350;
    border-radius: 6px;
    color: #C62828;
    font-size: 14px;
    font-weight: 500;
}

.listening-indicator.active {
    display: flex;
}

.listening-dot {
    width: 12px;
    height: 12px;
    background: #EF5350;
    border-radius: 50%;
    animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
    }
    50% {
        opacity: 0.5;
        transform: scale(1.2);
    }
}

/* Input Container */
.input-container {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: #F8F9FA;
    border: 2px solid #E0E0E0;
    border-radius: 24px;
    padding: 8px 8px 8px 16px;
    transition: border-color 0.2s;
}

.input-container:focus-within {
    border-color: #007AFF;
}

/* Text Input */
.message-input {
    flex: 1;
    border: none;
    background: transparent;
    resize: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.4;
    padding: 6px 0;
    max-height: 120px;
    overflow-y: auto;
    outline: none;
}

.message-input::placeholder {
    color: #999;
}

/* Auto-grow textarea */
.message-input[data-interim="true"] {
    color: #666;
    font-style: italic;
}

/* Microphone Button */
.mic-button {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: none;
    background: #007AFF;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;
}

.mic-button:hover {
    background: #0051D5;
    transform: scale(1.05);
}

.mic-button:active {
    transform: scale(0.95);
}

.mic-button.listening {
    background: #EF5350;
    animation: micPulse 1.5s ease-in-out infinite;
}

@keyframes micPulse {
    0%, 100% {
        box-shadow: 0 0 0 0 rgba(239, 83, 80, 0.7);
    }
    50% {
        box-shadow: 0 0 0 8px rgba(239, 83, 80, 0);
    }
}

.mic-icon {
    width: 20px;
    height: 20px;
    fill: currentColor;
}

/* Scrollbar for textarea */
.message-input::-webkit-scrollbar {
    width: 6px;
}

.message-input::-webkit-scrollbar-track {
    background: transparent;
}

.message-input::-webkit-scrollbar-thumb {
    background: #CCC;
    border-radius: 3px;
}
```

#### 3. JavaScript Implementation
**File**: `public/messenger.js`

**Update constructor** to reference new text input elements:

```javascript
constructor() {
    this.baseUrl = window.location.origin;

    // NEW: Text input elements
    this.messageInput = document.getElementById('messageInput');
    this.micBtn = document.getElementById('micBtn');
    this.listeningIndicator = document.getElementById('listeningIndicator');

    // Remove old references
    // this.listenBtn = document.getElementById('listenBtn');
    // this.listenBtnText = document.getElementById('listenBtnText');
    // this.interimText = document.getElementById('interimText');

    // Conversation elements
    this.conversationMessages = document.getElementById('conversationMessages');
    this.conversationContainer = document.getElementById('conversationContainer');
    this.refreshBtn = document.getElementById('refreshBtn');
    this.clearAllBtn = document.getElementById('clearAllBtn');

    // Send mode elements
    this.sendModeRadios = document.querySelectorAll('input[name="sendMode"]');
    this.triggerWordInputContainer = document.getElementById('triggerWordInputContainer');
    this.triggerWordInput = document.getElementById('triggerWordInput');

    // State
    this.isListening = false;
    this.sendMode = 'automatic';
    this.triggerWord = 'send';
    this.utteranceQueue = [];
    this.isInterimText = false; // NEW: Track if input contains interim speech

    this.initializeEventListeners();
    this.initializeSpeechRecognition();
    this.initializeTTS();
    this.initializeSSE();
    this.loadData();

    // Auto-refresh every 2 seconds
    setInterval(() => this.loadData(), 2000);
}
```

**Add event listeners** for text input (in `initializeEventListeners`, around line 146):

```javascript
initializeEventListeners() {
    // Text input events
    this.messageInput.addEventListener('keydown', (e) => this.handleTextInputKeydown(e));
    this.messageInput.addEventListener('input', () => this.autoGrowTextarea());

    // Microphone button
    this.micBtn.addEventListener('click', () => this.toggleVoiceDictation());

    // Refresh and clear buttons
    this.refreshBtn.addEventListener('click', () => this.loadData());
    this.clearAllBtn.addEventListener('click', () => this.clearAllUtterances());

    // Send mode radio buttons
    this.sendModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            this.sendMode = e.target.value;
            this.triggerWordInputContainer.style.display =
                this.sendMode === 'trigger' ? 'block' : 'none';
            this.updateQueuePreview();
        });
    });

    // Trigger word input
    this.triggerWordInput.addEventListener('input', (e) => {
        this.triggerWord = e.target.value.trim().toLowerCase();
    });
}

handleTextInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Prevent new line
        this.sendTypedMessage();
    }
    // Shift+Enter allows new line
}

autoGrowTextarea() {
    const textarea = this.messageInput;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

async sendTypedMessage() {
    const text = this.messageInput.value.trim();
    if (!text) return;

    // Don't send if it's interim speech text
    if (this.isInterimText) return;

    this.debugLog('Sending typed message:', text);

    // Clear input
    this.messageInput.value = '';
    this.messageInput.style.height = 'auto';

    // Send to server
    await this.sendVoiceUtterance(text);
}

toggleVoiceDictation() {
    if (this.isListening) {
        this.stopVoiceDictation();
    } else {
        this.startVoiceDictation();
    }
}

async startVoiceDictation() {
    if (!this.recognition) {
        alert('Speech recognition not supported in this browser');
        return;
    }

    try {
        // Clear any existing text if it's interim
        if (this.isInterimText) {
            this.messageInput.value = '';
            this.isInterimText = false;
        }

        this.recognition.start();
        this.isListening = true;
        this.micBtn.classList.add('listening');
        this.listeningIndicator.classList.add('active');
        this.debugLog('Started voice dictation');

        // Notify server that voice input is active
        await this.updateVoiceInputState(true);
    } catch (e) {
        console.error('Failed to start recognition:', e);
        alert('Failed to start speech recognition. Please try again.');
    }
}

async stopVoiceDictation() {
    if (this.recognition) {
        this.isListening = false;
        this.recognition.stop();
        this.micBtn.classList.remove('listening');
        this.listeningIndicator.classList.remove('active');

        // Clear interim text if present
        if (this.isInterimText) {
            this.messageInput.value = '';
            this.isInterimText = false;
            this.messageInput.removeAttribute('data-interim');
        }

        this.debugLog('Stopped voice dictation');

        // Notify server that voice input is no longer active
        await this.updateVoiceInputState(false);
    }
}
```

**Update speech recognition** to use text input instead of interim text div (modify `initializeSpeechRecognition`, around line 65-141):

```javascript
initializeSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.error('Speech recognition not supported in this browser');
        this.micBtn.disabled = true;
        this.micBtn.title = 'Not Supported';
        return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;

            if (event.results[i].isFinal) {
                // User paused - handle based on send mode
                this.isInterimText = false;
                this.messageInput.removeAttribute('data-interim');

                const finalText = this.messageInput.value.trim();

                if (this.sendMode === 'automatic') {
                    // Send immediately and clear
                    this.sendVoiceUtterance(finalText);
                    this.messageInput.value = '';
                } else {
                    // Trigger word mode: Check if this utterance contains trigger word
                    if (this.containsTriggerWord(finalText)) {
                        // Remove trigger word and send accumulated text
                        const textToSend = this.removeTriggerWord(finalText);
                        this.sendVoiceUtterance(textToSend);
                        this.messageInput.value = '';
                    } else {
                        // No trigger word - append to existing text with newline
                        const currentText = this.messageInput.value;
                        this.messageInput.value = currentText ? currentText + '\n' + transcript : transcript;
                        this.autoGrowTextarea();
                    }
                }
            } else {
                // Still speaking - show interim results in input
                interimTranscript += transcript;
            }
        }

        if (interimTranscript) {
            this.messageInput.value = interimTranscript;
            this.isInterimText = true;
            this.messageInput.setAttribute('data-interim', 'true');
            this.autoGrowTextarea();
        }
    };

    this.recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error !== 'no-speech') {
            if (event.error === 'not-allowed') {
                alert('Microphone access denied. Please enable microphone permissions.');
            } else {
                alert(`Speech recognition error: ${event.error}`);
            }
            this.stopVoiceDictation();
        }
    };

    this.recognition.onend = () => {
        if (this.isListening) {
            // Restart recognition to continue listening
            try {
                this.recognition.start();
            } catch (e) {
                console.error('Failed to restart recognition:', e);
                this.stopVoiceDictation();
            }
        }
    };
}
```

### TDD Test Plan:

Since this is primarily frontend JavaScript, TDD will focus on manual verification cycles:

#### Feature 1: Enter key sends message
- **RED (manual)**: Type text, press Enter → Should send (not implemented yet, nothing happens)
- **GREEN**: Add keydown listener for Enter key
- **RED (verify)**: Change condition to check for 'Escape' key → Enter doesn't send ✓
- **GREEN**: Fix to check for 'Enter' → works ✓

#### Feature 2: Shift+Enter creates new line
- **RED (manual)**: Type text, press Shift+Enter → Should add newline (sends instead)
- **GREEN**: Add `!e.shiftKey` condition to Enter handler
- **RED (verify)**: Remove shiftKey check → Shift+Enter sends ✓
- **GREEN**: Re-add check → Shift+Enter creates newline ✓

#### Feature 3: Textarea auto-grows
- **RED (manual)**: Type long text → Textarea should grow (stays one line)
- **GREEN**: Add `autoGrowTextarea()` on input event
- **RED (verify)**: Comment out height calculation → doesn't grow ✓
- **GREEN**: Uncomment → grows correctly ✓

#### Feature 4: Microphone toggles voice dictation
- **RED (manual)**: Click mic → Should start listening (nothing happens)
- **GREEN**: Add click listener calling `toggleVoiceDictation()`
- **RED (verify)**: Make it call `stopVoiceDictation()` instead → doesn't start ✓
- **GREEN**: Fix to properly toggle → works ✓

#### Feature 5: Interim speech shows in input
- **RED (manual)**: Speak with mic active → Text should appear in input (shows nowhere)
- **GREEN**: Modify `recognition.onresult` to set `messageInput.value`
- **RED (verify)**: Set value to empty string → no text shows ✓
- **GREEN**: Set to transcript → text appears ✓

#### Feature 6: Auto-send on pause
- **RED (manual)**: Speak and pause → Should send (stays in input)
- **GREEN**: Check `isFinal` and call `sendVoiceUtterance()`
- **RED (verify)**: Remove the send call → message stays in input ✓
- **GREEN**: Re-add send → auto-sends on pause ✓

### Success Criteria:

#### Automated Verification:
- [ ] Build works: `npm run build`
- [ ] No console errors when loading `messenger.html`
- [ ] No JavaScript syntax errors in `messenger.js`
- [ ] All existing tests still pass: `npm test`

#### Manual Verification (Green-Red-Green for each):
- [ ] Open `http://localhost:5111/` (messenger UI)
- [ ] Type "hello" in text input → Message sends on Enter ✓
- [ ] Shift+Enter in text input → Creates new line (no send) ✓
- [ ] Long typed message → Textarea auto-grows up to max height ✓
- [ ] Click microphone button → Button turns red, listening indicator appears ✓
- [ ] Speak "test message" → Text appears in input field as you speak ✓
- [ ] Stop speaking (pause) → Message auto-sends, input clears ✓
- [ ] Microphone button turns red while listening, blue when not ✓
- [ ] Click microphone again while listening → Stops, clears interim text ✓
- [ ] Toggle to trigger word mode ✓
- [ ] Speak "first message", pause, speak "second message" → Both accumulate in text input ✓
- [ ] Say trigger word "send" → All accumulated text sends as one message ✓
- [ ] Mix typing and voice: type message, send, then use voice → Both work seamlessly ✓
- [ ] Auto-scroll works when messages fill container ✓
- [ ] Legacy UI still works at `http://localhost:5111/legacy` ✓

**Implementation Note**: Follow strict TDD - for each feature above, manually verify it fails first (RED), implement (GREEN), intentionally break to verify test catches it (RED), then fix (GREEN). After completing this phase, verify that text input and voice dictation work seamlessly together before considering the implementation complete.

---

## Testing Strategy

### Unit Tests
No new unit tests required - existing tests cover backend logic. Focus on integration and manual testing for UI changes.

### Integration Testing
1. **Backend Conversation API**:
   - Send user message → Verify appears in `/api/conversation` as role='user'
   - Call speak endpoint → Verify assistant message added to `/api/conversation`
   - Clear all → Verify `/api/conversation` returns empty array

2. **Message State Sync**:
   - Create user message → Verify status='pending'
   - Dequeue → Verify status changes to 'delivered' in both `/api/utterances` and `/api/conversation`
   - Speak → Verify status changes to 'responded'

3. **Trigger Word Flow**:
   - Enable trigger mode, speak 3 messages → Verify queued in browser
   - Say trigger word → Verify all 3 sent to server
   - Check `/api/conversation` → Verify all 3 appear as separate user messages

### Manual Testing Steps

#### Scenario 1: Basic Conversation Flow
1. Open `http://localhost:5111`
2. Type "What's the weather?" and press Enter
3. Verify: Blue bubble on right with "PENDING" status
4. Use Claude Code to respond via speak tool: "It's sunny"
5. Verify: Gray bubble on left with Claude's response
6. Verify: User message status updated to "RESPONDED"

#### Scenario 2: Voice Dictation
1. Click microphone button
2. Speak "Tell me a joke"
3. Verify: Text appears in input as you speak
4. Stop speaking (pause)
5. Verify: Message auto-sends, appears as blue bubble
6. Verify: Input clears, ready for next message

#### Scenario 3: Trigger Word Mode
1. Toggle to "Wait for trigger word" mode
2. Click microphone button
3. Speak "First message" and pause
4. Verify: "First message" appears in text input
5. Speak "Second message" and pause
6. Verify: Text input now shows "First message\nSecond message" (accumulated with newline)
7. Speak trigger word "send"
8. Verify: All accumulated text sends as single blue bubble
9. Verify: Text input clears

#### Scenario 4: Mixed Input
1. Type "I'm typing this" and press Enter
2. Click microphone, speak "Now I'm speaking"
3. Type another message "Back to typing"
4. Verify: All three messages appear in conversation as blue bubbles
5. Verify: All show correct timestamps

#### Scenario 5: Conversation Persistence
1. Send several messages (mix of typing and voice)
2. Get some Claude responses via speak tool
3. Refresh page (F5)
4. Verify: Full conversation history loads
5. Verify: Scroll position at bottom
6. Verify: Statuses preserved

#### Scenario 6: Auto-scroll
1. Send 30+ messages to fill container
2. Verify: Container scrolls automatically as new messages arrive
3. Scroll up manually to read old messages
4. Send new message
5. Verify: Container auto-scrolls back to bottom

## Performance Considerations

- **Polling Frequency**: Keep 2-second polling interval for conversation updates (acceptable for this use case)
- **Message Limit**: Default to 50 messages in `/api/conversation` to prevent excessive data transfer
- **Auto-grow Textarea**: CSS-based with max-height prevents layout issues
- **Animation Performance**: Use CSS transforms for smooth bubble animations
- **Memory Management**: Browser queue (trigger word mode) cleared after sending

## Migration Notes

- **No Breaking Changes**: Backend remains backwards compatible
- **New API Endpoint**: `/api/conversation` added but existing `/api/utterances` still works
- **Data Structure**: `UtteranceQueue` extended with `messages` array, doesn't break existing code
- **Parallel UIs**: Old UI (`index.html`) and new UI (`messenger.html`) coexist
- **Default Behavior**: New messenger UI served at `/` by default
- **Legacy Access**: Old UI always available at `/legacy` or via `--legacy-ui` flag
- **Easy Rollback**: If issues arise, use `--legacy-ui` flag to switch back

## Implementation Summary

**Phase 1 (TDD - Backend)**:
- Write 5 integration tests for conversation API
- Add `ConversationMessage` interface and `messages` array
- Implement `/api/conversation` endpoint
- Store assistant messages when speak tool is called
- All changes with green-red-green verification

**Phase 2 (Parallel Development)**:
- Create `public/messenger.html` (new file, don't touch `index.html`)
- Create `public/messenger.js` (copy and modify from `app.js`)
- Build conversation UI with chat bubbles
- Keep old UI completely intact

**Phase 3 (TDD - Routing)**:
- Write 4 tests for UI routing
- Add `--legacy-ui` CLI flag parsing
- Update server to route based on flag
- Add `/legacy` and `/messenger` explicit routes
- Update help text

**Phase 4 (TDD - Text Input)**:
- Add text input to `messenger.html`
- Implement Enter-to-send with manual TDD cycles
- Move voice dictation into input field
- Verify each feature with green-red-green

**Estimated Effort**: 6-8 hours total
- Phase 1: 2-3 hours (backend + tests)
- Phase 2: 2-3 hours (new UI files)
- Phase 3: 1 hour (routing + tests)
- Phase 4: 1-2 hours (text input + manual TDD)

## References

- Roadmap: `roadmap.md` - "Revamp message queue UI as messenger-style conversation"
- Current Implementation:
  - Frontend: `public/index.html`, `public/app.js`
  - Backend: `src/unified-server.ts`
- Web Speech API: Used for voice recognition with interim results
- Design inspiration: WhatsApp Web, iMessage conversation interfaces
