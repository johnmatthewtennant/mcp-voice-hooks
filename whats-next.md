<original_task>
Fix an issue where voice messages get stuck on "pending" status when a second Claude Code instance is started. The root cause was that multiple Claude Code instances would each try to start their own HTTP server on port 5111, causing conflicts. The solution evolved into implementing multi-instance support so users can route voice messages to specific Claude Code instances.
</original_task>

<work_completed>
## Server-Side Changes (src/unified-server.ts)

### 1. Port Conflict Detection (lines ~25-60)
- Added `isHttpServerOwner` flag to track if this instance owns the HTTP server
- Added `isPortAvailable()` function using `net.createServer()` to check port availability
- Added `isExistingServerHealthy()` function to verify existing server responds to health check
- Modified `startHttpServer()` to skip starting if port is in use by healthy voice-hooks server
- Added `import net from 'net';` to imports

### 2. Instance Tracking Infrastructure (lines ~77-95)
- Added `ConnectedInstance` interface with fields: id, name, cwd, connectedAt, lastSeen, lastAssistantMessage
- Added `connectedInstances` Map to track all connected instances
- Added `targetInstanceId` variable to track which instance receives voice input

### 3. Utterance Targeting (lines ~100-140)
- Added `targetInstanceId?: string` field to `Utterance` interface
- Updated `queue.add()` method signature to accept `targetInstanceId` parameter
- Messages are now tagged with the currently targeted instance when queued

### 4. Instance Management API Endpoints (lines ~725-810)
- `POST /api/instances/register` - Register a new instance with id, name, cwd
- `GET /api/instances` - List all connected instances with their target status
- `POST /api/instances/target` - Set which instance should receive voice input
- `POST /api/instances/:id/heartbeat` - Update instance lastSeen timestamp
- Target changes broadcast via SSE to all browser clients

### 5. Instance-Filtered Dequeue (lines ~290-320, ~320-370)
- Updated `dequeueUtterancesCore(forInstanceId?: string)` to filter by instance
- Updated `waitForUtteranceCore(forInstanceId?: string)` to filter by instance
- Filter logic: only dequeue if no targetInstanceId on utterance OR matches forInstanceId

### 6. Hook Handler Updates (lines ~485-600)
- Updated `handleHookRequest()` signature to accept `instanceId` parameter
- Hook endpoints now extract `instanceId` from request body
- Pass instanceId to dequeue and wait functions

### 7. MCP Server Instance Registration (lines ~1020-1050)
- Generate unique instanceId using `randomUUID()` on startup
- Set `process.env.MCP_VOICE_HOOKS_INSTANCE_ID` for hooks to use
- Register with HTTP server after 1 second delay (to ensure server is ready)
- Pass instanceId when calling speak API

### 8. Speak Endpoint Updates (lines ~815-830)
- Accept `instanceId` in request body
- Track `lastAssistantMessage` per instance (truncated to 100 chars for display)

## Hook Configuration Changes (plugin/hooks/hooks.json)
- All hooks now pass `instanceId` via JSON body using env var interpolation
- Format: `curl -s -X POST -H 'Content-Type: application/json' -d '{"instanceId":"'"${MCP_VOICE_HOOKS_INSTANCE_ID}"'"}' ...`

## Browser UI Changes

### HTML (public/index.html)
- Added instance selector section after header (lines ~680-695)
- Added CSS styles for instance selector, instance buttons, targeted state (~65 lines)

### JavaScript (public/app.js)
- Added instance-related state variables: `instances`, `targetInstanceId`
- Added `loadInstances()` method to fetch instances from API
- Added `renderInstances()` method to build instance button UI
- Added `targetInstance(instanceId)` method to change target via API
- Updated `loadData()` to also load instances
- Updated SSE handler to process `targetChanged` events
- Instance selector only shows when 2+ instances connected

## Other Fixes
- Fixed TypeScript error: `req.params.id` cast to string (line ~615)
</work_completed>

<work_remaining>
## Testing Required
1. Start Claude Code in thoughtDrop project (uses local version via .claude.json config)
2. Start second Claude Code instance in another project
3. Verify browser UI shows both instances with folder names
4. Verify clicking instance targets it (highlighted in blue)
5. Speak and verify message goes to targeted instance only
6. Verify last assistant message shows in instance selector after Claude speaks

## Potential Improvements (Not Required)
1. Instance cleanup - remove stale instances that haven't sent heartbeat in X minutes
2. Auto-select most recently active instance
3. Show instance connection time or last activity
4. Handle case where targeted instance disconnects

## If Issues Arise
1. Check that hooks are receiving instanceId by examining hook output
2. Verify env var MCP_VOICE_HOOKS_INSTANCE_ID is set in MCP process
3. Check server logs for instance registration messages
4. Verify filter logic in dequeueUtterancesCore is working correctly
</work_remaining>

<attempted_approaches>
## Initial Diagnosis
- Identified that each Claude Code instance spawns its own voice-hooks MCP subprocess
- Each subprocess tried to start HTTP server on port 5111
- Second instance's server would fail with EADDRINUSE (not handled)
- Hooks from both instances would hit first server
- First instance's hooks would grab all messages

## Solution Evolution
1. **First approach**: Detect port in use, skip starting HTTP server, reuse existing
   - This fixed the crash but created new problem: no way to route messages to specific instance

2. **Final approach**: Full multi-instance support
   - Each instance registers with unique ID
   - Browser UI shows instance selector when 2+ connected
   - Messages tagged with target instance
   - Hooks filter by their instance ID
</attempted_approaches>

<critical_context>
## Key Design Decisions
1. **Instance ID via environment variable**: Hooks are static JSON files, so we use env var interpolation (`${MCP_VOICE_HOOKS_INSTANCE_ID}`) to pass instance ID dynamically

2. **Instance name = folder name**: Uses `process.cwd().split('/').pop()` to get human-readable name

3. **Last assistant message for identification**: Shows truncated (100 char) last Claude message to help user identify which conversation is which

4. **Filter logic**: Utterance delivered if: no targetInstanceId on utterance OR targetInstanceId matches requesting instance. This allows messages queued before targeting to be delivered to anyone.

5. **Auto-target first instance**: When first instance registers, it's automatically targeted

## Environment Setup
- User's .claude.json for `/home/jason/thoughtDrop` updated to use local version:
  ```json
  "voice-hooks": {
    "type": "stdio",
    "command": "node",
    "args": ["/home/jason/apps/mcp-voice-hooks/dist/unified-server.js", "--mcp-managed"]
  }
  ```

## File Locations
- Server: `src/unified-server.ts` (1155 lines after changes)
- Hooks: `plugin/hooks/hooks.json`
- Browser HTML: `public/index.html`
- Browser JS: `public/app.js`
- Build output: `dist/unified-server.js`

## Build Command
- `npm run build` uses tsup, outputs to `dist/`
</critical_context>

<current_state>
## Status: Feature Complete, Ready for Testing

### Finalized
- All TypeScript changes compiled successfully
- Build passes with no errors
- hooks.json updated with instanceId passing
- Browser UI updated with instance selector
- User's .claude.json configured for local testing

### Git Status (uncommitted)
- `M package-lock.json` (from npm install)
- `M src/unified-server.ts` (main feature implementation)
- Modified: `plugin/hooks/hooks.json`
- Modified: `public/index.html`
- Modified: `public/app.js`
- New: `whats-next.md`

### Ready to Test
User needs to:
1. Restart Claude Code instances to pick up changes
2. Test with 2 instances to verify instance selector appears
3. Test voice message routing to specific instance

### No Blockers
Implementation is complete. No known issues blocking testing.
</current_state>
