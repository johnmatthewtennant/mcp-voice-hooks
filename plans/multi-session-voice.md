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

Every hook call includes `session_id` and optionally `agent_id` in the stdin JSON. These form a **composite key**: `session_id + agent_id`.

- `session_id` distinguishes separate Claude Code processes (main vs tmux teammate)
- `agent_id` distinguishes agents within the same process (main vs sub-agent)
- Each unique `(session_id, agent_id)` combo gets its own conversation thread

The server tracks which combo is "active" — only that one gets voice input and TTS.

| Scenario | session_id | agent_id | Behavior |
|----------|-----------|----------|----------|
| Main agent | abc123 | (absent) | Active by default |
| Sub-agent | abc123 | def456 | Blocked (same session, different agent) |
| Tmux teammate | xyz789 | (absent) | Blocked (different session) |
| Teammate's sub-agent | xyz789 | ghi012 | Blocked (different session + agent) |

### Hook Changes (implemented)

Hooks read stdin and pass the full JSON (including agent_id) to the server:
- **PostToolUse & Stop**: if agent_id present, return instant approve (skip voice routing)
- **PreToolUse (speak)**: ALWAYS pass through to server — even for sub-agents

### Pre-Speak Key-Based Approval (new)

The pre-speak hook receives `session_id` and `agent_id`. The MCP speak call arrives separately without identity (shared stdio connection). We bridge this gap using the composite key as a gate:

1. **Pre-speak hook fires** → sends full JSON to server (session_id + agent_id)
2. **Server receives pre-speak request**:
   - Computes composite key: `(session_id, agent_id || "main")`
   - If composite key matches the **active** key: set approval flag, return approve
   - If composite key is **inactive**: store text in conversation history, DON'T set flag, return approve (hook allows, but MCP call will be rejected)
3. **MCP speak call arrives** (no session/agent identity):
   - If approval flag is set → play TTS, clear flag
   - If no flag → reject (came from non-active session/agent)

No text matching needed — the composite key is the gate. Multiple concurrent speak calls from the active session all get approved because they all have the same key. Non-active sessions never set the flag.

This solves both the sub-agent problem (same session, different agent_id) and the tmux teammate problem (different session_id, no agent_id).

### Per-Session State

Replace all global state with a session map:

```typescript
// Composite key: `${sessionId}:${agentId || "main"}`
interface SessionState {
  sessionId: string;          // From hook input session_id
  agentId: string | null;     // From hook input agent_id (null = main agent)
  agentType: string | null;   // From hook input agent_type
  conversationHistory: Message[];
  speakApproved: boolean;      // Flag set by pre-speak hook for active key
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

### Phase 1: Sub-agent blocking via agent_id (DONE)
- Hooks read stdin and check for agent_id
- Sub-agent post-tool/stop hooks return instant approve
- Sub-agent pre-speak hooks block speak tool
- Verified: 10/10 sub-agent speak calls blocked, 5/5 teammate speaks blocked (later fix needed)

### Phase 2: Server startup detection + single instance
- On startup, check if port is already in use (probe HTTP endpoint)
- If server already running → skip starting a new one, connect MCP to existing server
- Prevents teammates from spawning duplicate servers
- Not a problem yet but is a landmine — teammates currently start separate servers on same port

### Phase 3: Pre-speak key-based approval
- Pre-speak hook always passes session_id + agent_id to server
- Server registers active composite key (first session or user-selected)
- Only active key's pre-speak sets approval flag
- MCP speak calls only go through when approval flag is set
- Handles sub-agents (same session_id, different agent_id) AND teammates (different session_id)

### Phase 4: Per-session conversation history
- Create session map keyed by composite key
- Store speak text in each key's conversation history
- Route utterances only to active key's queue
- Non-active sessions get instant approve on all hooks

### Phase 5: Browser session selector
- Add session list to UI
- Session switching changes active composite key
- Loads that session's conversation history
- SSE scoped to active session
- Unread message indicators

## Open Questions

- Should agents be able to register a friendly name for their session? (e.g., "main", "researcher", "tester")
- Should inactive sessions still be able to speak via TTS if the user enables a "hear all" mode?
- How long do sessions persist after the MCP connection closes? Should there be a TTL?
- Should the browser auto-switch to a session when it receives voice input? (probably not — user controls routing)
- ~~The `session_id` is shared across parent + sub-agents. Should we use `session_id + agent_id` as the compound key?~~ **YES — composite key is the design.**

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
