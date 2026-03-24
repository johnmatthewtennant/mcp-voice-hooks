# Plan: Replace MCP with CLI/curl for Voice Hooks — Revised v2

## Motivation

Currently voice hooks runs as an MCP server, which means:
- Server lifecycle is tied to Claude's lifecycle — restarting the server means restarting Claude
- Claude can't restart the voice server independently
- Server configuration changes require restarting the entire Claude session

## Key Insight

Voice INPUT already flows through hooks, not MCP. The server receives speech from the browser and delivers it via PreToolUse/PostToolUse hooks. MCP is only used for the speak tool (output). The MCP speak tool is already just a thin proxy to `POST /api/speak` on the HTTP server.

## Revised Architecture: Standalone HTTP Server + MCP Shim

1. **Decouple the HTTP server** from Claude's lifecycle — run it independently
2. **Keep a thin MCP shim** that only proxies `speak` calls to the HTTP server
3. **The shim never binds an HTTP port** — it's purely an MCP-to-HTTP proxy

This preserves all existing hook matchers, session routing, and permissions while achieving the core lifecycle decoupling goal.

### Architecture Before vs After

**Before (current):**
```
Claude → MCP stdio → unified-server.ts (starts HTTP server + MCP in same process)
                      ↑ lifecycle tied to Claude
```

**After:**
```
Terminal/launchd → unified-server.ts (HTTP server, runs independently)
Claude → MCP stdio → mcp-shim.ts (proxies speak to HTTP server via fetch)
                     ↑ if shim crashes or restarts, HTTP server keeps running
                     ↑ if HTTP server restarts, shim auto-reconnects on next call
```

The shim never starts an HTTP server, never handles WebSockets, never manages utterances. It only translates MCP speak calls to HTTP. The standalone server never does MCP stdio.

## Step-by-Step Implementation

### Phase 1: Create MCP shim entry point

**New file:** `src/mcp-shim.ts` (~50 lines)

A minimal MCP server that:
- Exposes the `speak` tool (proxies to `http://localhost:${PORT}/api/speak`)
- Does NOT start an HTTP server or bind any port
- Does NOT import Express, ws, or any heavy dependencies
- Connects via stdio transport
- Provides `instructions` field (moved from unified-server.ts lines 2063)
- Returns clear error message when HTTP server is unreachable

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = process.env.MCP_VOICE_HOOKS_PORT || 5111;

const server = new Server({ name: 'voice-hooks', version: '1.0.0' }, {
  capabilities: { tools: {} },
  instructions: 'When voice input and output are active: (1) Delegate tasks...',
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'speak', description: 'Speak text using text-to-speech...', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The text to speak' } }, required: ['text'] } }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== 'speak') throw new Error(`Unknown tool: ${name}`);
  const text = args?.text as string;
  if (!text?.trim()) return { content: [{ type: 'text', text: 'Error: Text is required' }], isError: true };

  try {
    const response = await fetch(`http://localhost:${PORT}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    if (response.ok) return { content: [{ type: 'text', text: '' }] };
    return { content: [{ type: 'text', text: `Error: ${data.error || 'Unknown error'}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: 'Voice hooks server is not running. Start it with: npx mcp-voice-hooks start' }], isError: true };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
```

### Phase 2: Add `mcp-shim.ts` to build config

**File:** `tsup.config.ts`

Update the entry list to include the new shim:

```typescript
export default defineConfig({
  entry: ['src/unified-server.ts', 'src/hook-merger.ts', 'src/mcp-shim.ts'],
  format: ['esm'],
  target: 'esnext',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: {
    compilerOptions: {
      allowImportingTsExtensions: true
    }
  },
  external: ['@modelcontextprotocol/sdk']
});
```

**Verification:** After build, `dist/mcp-shim.js` must exist. Add a test or build check.

### Phase 3: Update CLI commands in `bin/cli.js`

**File:** `bin/cli.js`

Add new subcommands:

```javascript
} else if (command === 'start') {
  // Start the HTTP server in standalone mode (no MCP)
  console.log('🎤 Starting voice hooks server...');

  // Auto-install/update hooks on startup
  await ensureHooksInstalled();

  const serverArgs = [];
  if (args.includes('--debug') || args.includes('-d')) serverArgs.push('--debug');
  // NO --mcp-managed flag

  const child = spawn('node', [serverPath, ...serverArgs], { stdio: 'inherit', cwd: rootDir });

  // Signal handling...
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code));

} else if (command === 'shim') {
  // Run the lightweight MCP shim (stdio proxy to HTTP server)
  const shimPath = path.join(__dirname, '..', 'dist', 'mcp-shim.js');
  const child = spawn('node', [shimPath], { stdio: 'inherit', cwd: rootDir });
  child.on('exit', (code) => process.exit(code));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

} else if (command === 'status') {
  const port = process.env.MCP_VOICE_HOOKS_PORT || 5111;
  try {
    const response = await fetch(`http://localhost:${port}/api/health`);
    const data = await response.json();
    console.log(`Voice hooks server: ${data.status}`);
    console.log(`Voice active: ${data.voiceActive ? 'yes' : 'no'}`);
    console.log(`Speech recognition: ${data.speechRecognitionAvailable ? 'available' : 'unavailable'}`);
    console.log(`Speech rate: ${data.speechRate} wpm`);
    console.log(`Port: ${data.port}`);
    console.log(`Uptime: ${Math.floor(data.uptime)}s`);
  } catch {
    console.error('Voice hooks server is not running');
    console.error(`Expected at http://localhost:${port}`);
    process.exit(1);
  }
}
```

**Default command (no subcommand) change:** The existing default behavior starts the MCP-managed server. Change it to start the standalone HTTP server instead (equivalent to `start`). This is the main UX change — `npx mcp-voice-hooks` now starts the standalone server.

**Update install output:** Remove the line "To add the server to Claude Code, run: `claude mcp add ...`" since the plugin handles this via `.mcp.json`.

### Phase 4: Update plugin `.mcp.json`

**File:** `plugin/.mcp.json`

```json
{
  "mcpServers": {
    "voice-hooks": {
      "type": "stdio",
      "command": "npx",
      "args": ["mcp-voice-hooks", "shim"]
    }
  }
}
```

Changed from `["mcp-voice-hooks", "--skip-hooks"]` to `["mcp-voice-hooks", "shim"]`.

**Also update `dev-marketplace/` plugin `.mcp.json` identically** to keep dev and prod plugins consistent.

### Phase 5: Remove MCP from unified-server.ts

**File:** `src/unified-server.ts`

1. **Remove the entire MCP server setup block** (lines 2049-2163) — this code is now in `mcp-shim.ts`
2. **Remove MCP imports** (lines 17-19): `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, `CallToolRequestSchema`
3. **Remove `--mcp-managed` flag** and `IS_MCP_MANAGED` constant (line 222-223)
4. **Remove all `IS_MCP_MANAGED` conditionals** throughout the file — the server always behaves as standalone:
   - Logging always goes to stdout (remove stderr workarounds)
   - Startup log format simplified
5. **Remove EADDRINUSE shim fallback** (lines 1917-1929): If port is in use, **fail fast** with a clear error message: "Port 5111 already in use. Is another instance running?"
6. **Browser auto-open**: Keep the existing behavior — auto-open is controlled by `MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER` env var. In standalone mode, auto-open after 3 seconds if no frontend connects (same as current MCP mode). Users running via launchd can set the env var to `false` to disable.

### Phase 6: Add health check endpoint

**File:** `src/unified-server.ts`

Add a `GET /api/health` endpoint using the actual server state variables:

```typescript
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    voiceActive: voicePreferences.voiceActive,          // source: voicePreferences object (line 228)
    speechRecognitionAvailable: SPEECH_RECOGNIZER_AVAILABLE,  // source: constant (line 225)
    speechRate: voicePreferences.speechRate,             // source: voicePreferences object
    selectedVoice: voicePreferences.selectedVoice,       // source: voicePreferences object
    port: HTTP_PORT,
    uptime: process.uptime(),
  });
});
```

Note: `voicePreferences.voiceActive` is the single source of truth for whether voice is enabled. It's set by `POST /api/voice-active` when the browser frontend connects/disconnects. `SPEECH_RECOGNIZER_AVAILABLE` is a constant set at startup.

This is used by:
- CLI `status` command
- MCP shim connectivity check (optional, for better error messages)
- Future monitoring

### Phase 7: Hooks — no changes needed

**File:** `plugin/hooks/hooks.json`

**No changes required.** All hooks remain identical:

1. **PreToolUse hook for speak** — matcher `_voice-hooks__speak$` still works because the MCP shim exposes the same tool name
2. **PostToolUse hook** — matcher `^(?!.*_voice-hooks__)` still correctly excludes voice-hooks MCP tools
3. **Stop hook** — unchanged

The hook config references the HTTP server's endpoints via curl, which is the standalone server. The MCP tool names are defined by the shim, which uses the same names as before. No hook matchers break.

### Phase 8: Update tests

**Specific test changes:**

1. **Remove MCP-managed mode tests** (if any exist that test `IS_MCP_MANAGED` behavior)
2. **Keep all HTTP API tests** (unchanged — they test the standalone server)
3. **Keep all hook tests** (unchanged — hooks still curl to HTTP server)
4. **Add MCP shim tests:**
   - Mock HTTP server, verify speak proxy works
   - Test error when HTTP server is unreachable (returns helpful error message)
   - Test non-JSON response handling
   - Test empty text validation
5. **Add `GET /api/health` test:**
   - Verify response shape
   - Verify it reflects current voice state
6. **Update settings-migration tests:**
   - Verify installer still merges hooks correctly
   - Verify `.mcp.json` shim command
7. **Add build verification:**
   - Test that `dist/mcp-shim.js` exists after build
   - Test that `npx mcp-voice-hooks shim` starts without error (and exits cleanly when stdin closes)

### Phase 9: Clean up package.json

**File:** `package.json`

- Keep `@modelcontextprotocol/sdk` dependency (still used by `mcp-shim.ts`)
- The dependency is only imported by the shim, not the main server
- Consider making it a `peerDependency` or `optionalDependency` if we want the standalone server to install faster (future optimization, not required now)

### Phase 10: Update documentation

**README.md changes:**
- Add "Starting the server" section: `npx mcp-voice-hooks` or `npx mcp-voice-hooks start`
- Explain that the server runs independently of Claude
- Update manual installation: `claude mcp add voice-hooks npx mcp-voice-hooks shim`
- Keep plugin installation as-is (plugin marketplace handles `.mcp.json` automatically)
- Note: plugin marketplace ships `.mcp.json` as part of the plugin package, so the updated shim command is picked up automatically

**CONTRIBUTING.md changes:**
- Update dev workflow: `npx mcp-voice-hooks start` for dev (not just `claude`)
- Mention `npm run build` now also builds `mcp-shim.js`

## Migration Path for Existing Users

### Plugin users (recommended path)
1. Update plugin (auto-updates from marketplace on Claude restart)
2. Start server in a separate terminal: `npx mcp-voice-hooks` (or `npx mcp-voice-hooks start`)
3. Restart Claude Code to pick up updated plugin (shim-based MCP)
4. Everything else works as before — same hooks, same UI, same voice experience

### Manual installation users
1. Remove old MCP server: `claude mcp remove voice-hooks`
2. Add shim: `claude mcp add voice-hooks npx mcp-voice-hooks shim`
3. Start server: `npx mcp-voice-hooks start`
4. Restart Claude Code

### What if the server isn't running?
The MCP shim still starts (Claude manages its lifecycle via stdio). When Claude calls `speak`, the shim tries to reach the HTTP server and returns a clear error: "Voice hooks server is not running. Start it with: npx mcp-voice-hooks start"

## Risks & Considerations

1. **Server must be running separately**: Users need to start the server before using voice. Clear error messages guide them. Future: launchd plist for auto-start.
2. **Two processes instead of one**: Slightly more complex setup, but the processes are independent and resilient. The shim is <50 lines and nearly zero overhead.
3. **MCP shim still depends on `@modelcontextprotocol/sdk`**: Dependency stays in package.json but is only used by the shim.
4. **Standalone server fails fast on port conflict**: No more silent fallback. If port 5111 is in use, the server exits with a clear error.
5. **Browser auto-open in standalone mode**: Kept as configurable — auto-opens after 3s by default, disable with `MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER=false`. This matches existing MCP-managed behavior, appropriate for interactive use. Users running via launchd should set the env var to disable it.

## What This Does NOT Change

- Hook configuration (same matchers, same curl commands)
- MCP tool names and behavior (shim exposes identical `speak` tool)
- Browser UI, WebSocket connections, speech recognition
- Session management / subagent routing
- Utterance queue management
- TTS pipeline
- PreToolUse/PostToolUse/Stop hook behavior
- Bash permissions (no new permissions needed — still uses MCP)

## Codebase Context

- **Project:** `/Users/jtennant/Development/mcp-voice-hooks`
- **Main server:** `src/unified-server.ts` (~8800 lines)
- **CLI entry:** `bin/cli.js` (~240 lines)
- **Build config:** `tsup.config.ts` (needs `mcp-shim.ts` added to entry)
- **Hook config:** `plugin/hooks/hooks.json` (unchanged)
- **MCP config:** `plugin/.mcp.json` (update command to `shim`)
- **Dev plugin MCP config:** `dev-marketplace/.../.mcp.json` (update to match)
- **Tests:** `src/__tests__/` (86 tests across 10+ files)
- **The MCP speak tool** (lines 2068-2151) → extracted to `src/mcp-shim.ts`
- **The HTTP server** handles all TTS, utterance management, WebSocket streaming
