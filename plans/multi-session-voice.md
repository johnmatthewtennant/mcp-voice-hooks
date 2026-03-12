# Multi-Session Voice Interface

## Current State

**Sub-agent blocking is implemented (Phase 1 complete).** Hooks check for `agent_id` in stdin JSON and block sub-agents from speaking or receiving voice input. Verified: 10/10 sub-agent speak calls blocked in testing.

**Tmux teammates are NOT handled yet.** They run as separate Claude Code processes with their own MCP servers. They have different `session_id` values but no `agent_id`, so they look like main agents. Their speak calls go through and they receive voice input meant for the user's primary agent.

**Key identity model:** Every hook call includes `session_id` (always) and `agent_id` (sub-agents only). The composite key `(session_id, agent_id)` uniquely identifies every agent:

| Scenario | session_id | agent_id | Currently handled? |
|----------|-----------|----------|-------------------|
| Main agent | abc123 | (absent) | Yes (active) |
| Sub-agent | abc123 | def456 | Yes (blocked) |
| Tmux teammate | xyz789 | (absent) | **No** |
| Teammate's sub-agent | xyz789 | ghi012 | **No** |

## Architecture

```
┌─────────────┐     ┌─────────────┐
│ Main Agent  │     │ Teammate    │
│ MCP (stdio) │     │ MCP (stdio) │
└──────┬──────┘     └──────┬──────┘
       │                   │
       ▼                   ▼
┌──────────────────────────────────┐
│   Shared HTTP Server (:5111)    │
│   • Hook endpoints              │
│   • Speak endpoint              │
│   • SSE for browser             │
│   • Session state management    │
└──────────────────────────────────┘
       ▲
       │
┌──────┴──────┐
│  Browser UI │
└─────────────┘
```

Each Claude Code process needs its own stdio MCP endpoint. But all share one HTTP server for hooks and browser. On startup, try to bind — if `EADDRINUSE`, fall back to MCP shim only.

## Plan

### Phase 2: Single HTTP server instance
- On startup, try to bind port — if `EADDRINUSE`, fall back to MCP shim only (connect to existing HTTP server)
- If bind succeeds → start HTTP server + MCP shim together
- Prevents duplicate HTTP servers from teammates
- No probe needed — just handle the bind error

### Phase 3: Pre-speak text whitelist + hook migration
The MCP speak call arrives without session/agent identity (shared stdio). The pre-speak hook (which has identity) bridges this gap by whitelisting the exact text:

1. **Pre-speak hook** → sends `session_id + agent_id + tool_input.text` to server
2. **Server**: if composite key is active → increment whitelist count for that text (multiset), return approve. If inactive → store text in conversation history, return block.
3. **MCP speak call** with text → if text in whitelist with count > 0, decrement count and play TTS. If count == 0 or not in whitelist, reject. Handles duplicate identical texts correctly.

Text matching ensures the correct agent's speak goes through even with concurrent calls from multiple agents. Whitelist entries have 5s TTL to prevent stale entries.

**Hook migration:** Remove ALL shell-level `agent_id` grep shortcuts — from pre-speak, post-tool, AND stop hooks. All three hooks pass full JSON to server. Server makes all routing decisions based on composite key. This keeps routing logic in one place.

### Phase 4: Per-session state

```typescript
interface SessionState {
  sessionId: string;
  agentId: string | null;
  agentType: string | null;
  conversationHistory: Message[];
  speakWhitelist: Map<string, { count: number; expiry: Date }>; // text → count + expiry (multiset with 5s TTL)
  queue: UtteranceQueue;
  lastToolUseTimestamp: Date | null;
  lastSpeakTimestamp: Date | null;
}

const sessions = new Map<string, SessionState>();
let activeCompositeKey: string | null = null;
```

Composite key encoding: `JSON.stringify([sessionId, agentId || "main"])`.

**Endpoint migration:**

| Endpoint | Migration |
|----------|-----------|
| `POST /api/potential-utterances` | Route to active session's queue |
| `GET /api/utterances` | Read from active session's queue |
| `GET /api/conversation` | Active session's history |
| `POST /api/speak` | Check text whitelist, play TTS |
| `POST /api/hooks/*` | Route by composite key from POST body |
| `GET /api/tts-events` | Scope SSE to active session |

Backward compatible: missing `session_id` falls back to default session.

**Session lifecycle:**

| Event | Behavior |
|-------|----------|
| Create | First hook call with new key auto-creates session |
| Switch | Browser UI changes active key |
| TTL | 30 min inactivity → cleanup |
| Unread reset | When user switches to session in UI |

### Phase 5: Browser session selector
- Collapsible right sidebar (hide/show)
- Sessions grouped by `session_id`:
  - Main agent = parent
  - Sub-agents indented under parent, labeled by `agent_type`
  - Teammates = separate top-level entries
- Click to switch active session
- Unread badges on inactive sessions
- SSE scoped to active session

## Required Tests
- Parent vs sub-agent (same session_id)
- Teammate (different session_id)
- Concurrent speaks from active session
- Active session switch during in-flight speak
- Missing session_id payloads (backward compat)
- Whitelist TTL expiry (stale entries cleaned up)
- Duplicate identical text authorization (multiset count)

## Open Questions
- Agent-registered friendly names? (e.g., "researcher" instead of agent_id)
- "Hear all" mode for inactive sessions?
- Auto-switch when voice input arrives? (probably not)
