# Multi-Session Voice Interface

## Problem

When multiple agents (parent + sub-agents, or multiple Claude Code instances) share the same MCP voice hooks server:

1. **Voice input goes to wrong agent**: Hook dequeues utterances and marks them "delivered" — whichever agent's hook fires first consumes the utterance. Sub-agents get voice input meant for the parent.
2. **Speak output overlaps**: All agents call speak, all play TTS simultaneously.
3. **No conversation history per agent**: Single global conversation — messages from different agents are interleaved.

## Key Discovery: Hook Input JSON Has Agent Identity

The hook input JSON (received via stdin) already includes agent identification fields when running inside a subagent:

```json
{
  "session_id": "abc123",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "agent_id": "def456",        // Only present in subagents
  "agent_type": "Explore"      // Only present in subagents
}
```

- **Main agent**: `agent_id` and `agent_type` are ABSENT from the JSON
- **Sub-agents**: `agent_id` (unique) and `agent_type` (e.g., "Explore", "general-purpose") are PRESENT
- **`session_id`**: Present for all agents — shared across parent and sub-agents within the same Claude Code session

This is the differentiator. No PIDs, env vars, or custom agent definitions needed.

Source: https://code.claude.com/docs/en/hooks#common-input-fields

## Design

### Core Principle

Session isolation on both the **speak tool** (MCP) and the **hooks** (HTTP). The browser UI lets the user select which session is "active" — only that session gets voice input and TTS.

### Session Identification

Hooks read the stdin JSON and pass `session_id`, `agent_id`, and `agent_type` to the server. The server uses these to route:

- **No `agent_id`** → main agent → full voice routing (dequeue, speak, wait)
- **Has `agent_id`** → sub-agent → server decides based on active session:
  - If this agent's session is active in the UI → route voice
  - Otherwise → instant approve, no dequeue

### Hook Changes

Current hooks are fire-and-forget curl commands that don't read stdin. They need to be updated to:

1. Read the JSON from stdin
2. Pass it to the server as the POST body (it already contains session_id, agent_id, agent_type)

```bash
# Current (broken for multi-agent):
curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/post-tool" || echo '{}'

# Updated (passes agent identity):
INPUT=$(cat)
curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/post-tool" \
  -H "Content-Type: application/json" \
  -d "$INPUT" || echo '{}'
```

The server now knows exactly who is calling and can route accordingly.

### Per-Session State

Replace all global state with a session map:

```typescript
interface SessionState {
  sessionId: string;          // From hook input session_id
  agentId: string | null;     // null for main agent
  agentType: string | null;
  queue: UtteranceQueue;
  voicePreferences: VoicePreferences;
  conversationHistory: Message[];
  lastToolUseTimestamp: Date | null;
  lastSpeakTimestamp: Date | null;
}

const sessions = new Map<string, SessionState>();
let activeSessionId: string | null = null;
```

### Speak Tool (MCP)

When an agent calls `speak`:
1. Server identifies the session from the MCP connection
2. Stores message in that session's conversation history
3. If this session is **active** in the browser → play TTS, send SSE event
4. If this session is **not active** → buffer the message silently (no TTS)
5. When user switches to this session in the UI, they see all buffered messages

### Hook Routing (HTTP)

Server behavior on hook request:
1. Parse `session_id`, `agent_id`, `agent_type` from POST body
2. Look up or create session state
3. If main agent (no `agent_id`) AND session is active → normal voice routing
4. If sub-agent (has `agent_id`) → check if user wants voice for this agent:
   - If active in UI → route voice
   - Otherwise → instant `{"decision": "approve"}` — no dequeue
5. **Never dequeue utterances for non-active sessions** — this is critical

### Voice Input Routing

- Browser sends voice input to `/api/potential-utterances`
- Server adds utterance to the **active session's** queue only
- Only the active session's hooks will find pending utterances
- Non-active sessions always get instant approve

### Browser UI Changes

Add a session selector:
- Dropdown or tab bar showing all connected sessions
- Each session labeled by: agent_type (e.g., "main", "Explore", "researcher")
- Active session highlighted
- Switching sessions:
  - Loads that session's conversation history
  - Routes future voice input to that session
  - TTS only plays for the newly active session
- Badge/indicator showing unread messages from inactive sessions

### SSE Scoping

Current: broadcast to all `ttsClients`
New: each SSE connection is tagged with the session it's viewing

```typescript
const ttsClients = new Map<Response, string>(); // client → sessionId they're viewing

function notifySessionClients(sessionId: string, event: any) {
  ttsClients.forEach((viewingSession, client) => {
    if (viewingSession === sessionId) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });
}
```

## Implementation Phases

### Phase 1: Session-aware hooks (server + hooks)
- Update hook commands to read stdin and pass full JSON to server
- Server parses session_id, agent_id, agent_type from POST body
- If agent_id present → instant approve (simple sub-agent blocking)
- If agent_id absent → existing behavior (backward compatible)
- No UI changes needed

### Phase 2: Per-session state
- Create session map with per-session utterance queues
- Route utterances by session_id
- Speak tool uses MCP connection to identify session
- Multiple main agents (different Claude Code instances) get separate queues

### Phase 3: Browser session selector
- Add session list to UI
- Session switching loads correct conversation history
- SSE scoped to active session
- Unread message indicators

### Phase 4: Multi-instance support (optional, later)
- Second Claude Code instance detects existing server on port
- Connects as new session instead of starting own server
- Requires port discovery / lock file mechanism

## Open Questions

- Should agents be able to register a friendly name for their session? (e.g., "main", "researcher", "tester")
- Should inactive sessions still be able to speak via TTS if the user enables a "hear all" mode?
- How long do sessions persist after the MCP connection closes? Should there be a TTL?
- Should the browser auto-switch to a session when it receives voice input? (probably not — user controls routing)
- The `session_id` is shared across parent + sub-agents. Should we use `session_id + agent_id` as the compound key?

## Research Notes

### Approaches considered and rejected:
- **PID-based**: Sub-agents share same PPID (71075) as parent — all run in same Claude process
- **Environment variables**: No `env` field in agent frontmatter; env vars inherited by sub-agents
- **Custom agent definitions**: Global hooks from settings still fire even with agent-specific frontmatter hooks
- **CLAUDE_SESSION_ID env var**: Not exposed yet (multiple open GitHub issues: #25642, #13733, #17188, #29318)
- **disallowedTools on sub-agents**: Blocks speak tool but global hooks still dequeue utterances

### Key GitHub issues:
- [#7881](https://github.com/anthropics/claude-code/issues/7881): SubagentStop hook cannot identify which subagent finished (same session_id)
- [#25642](https://github.com/anthropics/claude-code/issues/25642): Expose session ID as $CLAUDE_SESSION_ID
- [#18654](https://github.com/anthropics/claude-code/issues/18654): User-configurable session variables for hooks
- [#5812](https://github.com/anthropics/claude-code/issues/5812): Allow hooks to bridge context between sub-agents and parent

## Context

Plan generated during Claude Code session `efbdc174-a7ac-46b0-b0f5-62d464e8f317` on 2026-03-11.
