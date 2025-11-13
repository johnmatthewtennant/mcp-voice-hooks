# MCP Voice Hooks - Roadmap

## Vision

Create an MCP server that enables real-time voice interaction with Claude Code and other MCP clients. The system will:

1. **Continuously listen** for voice input (or typed input during POC)
2. **Detect complete utterances** using LLM-based analysis
3. **Queue utterances** for consumption by MCP clients
4. **Use hooks** to force clients to check for new utterances before and after tool execution
5. **Enable voice feedback** with text-to-speech responses

## Architecture

### Browser UI

- Text Input
- Speech API integration
- Audio monitoring
- Queue monitoring

### MCP Server

- Text utterance classification
- Utterance Queue
- WebSocket Server
- TTS via `say` command

### Claude Code

- Hook Integration
- Tool Execution

## Project Phases & Roadmap

### Next tasks

- [ ] Remove red "Listening..." indicator box from messenger UI (mic button already shows listening state)
- [x] Phase 1-4 of test improvements completed:
  - [x] Removed low-value mocked tests (mcp-speak-response.test.ts, 242 lines)
  - [x] Created TestServer helper for real HTTP integration tests (370 lines)
  - [x] Added 13 new HTTP integration tests
  - [x] Refactored 5 test files to use real server:
    - speak-endpoint.test.ts (8 tests)
    - utterance-states.test.ts (7 tests)
    - voice-input-state.test.ts (8 tests)
    - validate-action.test.ts (13 tests)
    - http-server-integration.test.ts (13 new tests)
  - [x] Mocked TTS calls for fast, reliable tests (3.4s test suite)
  - [x] Removed 750+ lines of duplicated mock infrastructure
  - All 86 tests passing with TDD green-red-green methodology
  - conversation-flow.test.ts skipped (tests obsolete pre-wait hooks)
- [x] make sure voice input and voice responses are disabled when the browser is closed
- [x] ~~make the disable pre-tool hook configuration more nuanced. It should only control if we deqeueue before tools. We always want to enforce speaking if there are unresponded utterances.~~ (Pre-tool hook removed)
- [ ] add a note to the pre-speak hook that the voice response was not delivered because the assistant needs to read the new utterances first
- [x] find the mcp-proxy logic and fix it or remove it from the readme
- [x] clean up unused code (index.ts, http-server.ts, utterance-queue.ts, types.ts)
- [x] convert DEBUG environment variable to --debug CLI argument for better developer experience
- [ ] consider using suppressOutput for the hooks. Maybe just the stop hook and the pre-speak hook <https://docs.anthropic.com/en/docs/claude-code/hooks#common-json-fields>
- [x] add pre-tool hook to automatically approve Speak tool. (so user doesn't have to manually approve & add to allowlist)
- [x] add a development plugin marketplace and a development mcp.json separate from the main marketplace and plugin
- [x] Create CONTRIBUTING.md with instructions for local plugin development workflow
- [x] Remove wait_for_utterance tool and associated hooks
  - [x] Remove wait_for_utterance MCP tool
  - [x] Remove pre-wait hook configuration
  - [x] Remove MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT environment variable
  - [x] Simplify code by removing manual mode - always use auto-delivery
  - [x] Update documentation to reflect simplified architecture
- [x] add plugin installation instructions to the readme
- [ ] Countdown timer on the frontend when Claude is waiting
- [ ] Configurable timeout on the frontend
  - [ ] need to determine the max timeout allowed by default by claude code, If we want to allow longer timeouts, the user will need to adjust the timeout in the claude settings.
  - [ ] maybe we can read that timeout from the claude code settings to determine the max timeout allowed by the server and in the UI
  - [ ] we could even adjust the timeout in claude code settings using the UI but the user would need to restart claude code to apply the new timeout

### OpenAI Integration (Enhanced Mobile Support)

- [ ] Add OpenAI API key configuration option
  - [ ] Add API key input field in browser interface
  - [ ] Store API key securely on server
  - [ ] Add environment variable support for API key
- [ ] Implement OpenAI speech-to-text (Whisper) integration
  - [ ] Add browser/OpenAI toggle for dictation input method
  - [ ] Create audio recording functionality for OpenAI API calls
  - [ ] Implement fallback to browser Web Speech API when OpenAI unavailable
  - [ ] Handle audio chunking and streaming for real-time experience
- [ ] Add OpenAI text-to-speech voices to TTS dropdown
  - [ ] Integrate OpenAI TTS API voices (alloy, echo, fable, onyx, nova, shimmer)
  - [ ] Add OpenAI voices as new section in voice dropdown alongside Browser/System voices
  - [ ] Implement OpenAI TTS playback in browser
  - [ ] Handle OpenAI TTS rate limiting and errors gracefully

### UI/UX Improvements

- [x] Revamp message queue UI as messenger-style conversation (Phases 1-3 complete)
  - [x] Backend: Added /api/conversation endpoint with full message history
  - [x] Backend: Store Claude's responses as assistant messages
  - [x] Frontend: Created messenger.html with chat bubble interface
  - [x] Display user messages as blue chat bubbles on the right side
  - [x] Display Claude responses as gray chat bubbles on the left side
  - [x] Show timestamps and message status (pending, delivered, responded)
  - [x] Mobile-responsive design with breakpoints at 768px and 480px
  - [x] Backwards compatible: --legacy-ui flag to use old interface
- [x] Add typing capability with voice dictation (completed in Phase 2)
  - [x] Added textarea at bottom with Enter-to-send (Shift+Enter for newline)
  - [x] Microphone button integrated inside text input (WhatsApp-style)
  - [x] Real-time speech transcription appears directly in text input field
  - [x] Auto-send on pause when Web Speech API detects complete utterance
  - [x] Supports both manual typing and voice dictation seamlessly
  - [x] Trigger word mode: accumulates in textarea until trigger word spoken
- [x] Simplify voice settings interface
  - [x] Voice responses toggle in main interface
  - [x] Collapsible settings section for advanced options
  - [x] Clean, focused conversation interface
- [ ] UI toggle to enable/disable notification sound when claude is waiting for utterances
- [x] Remove the text input field from the frontend.
- [x] Make the in-progress text box permanent so the layout doesn't jump around as the user starts and stops speaking
- [x] remove the limit() parameter from the dequeue_utterances MCP tool. It should just dequeue all utterances.
- [x] Change the "No utterances yet. Type something above to get started!" to "No speech input yet. Click Start Listening to get started!". Then change it to "No speech input yet. Say something to get started!" when the user clicks start listening.
- [x] rework the UI so that start listening is at the very top of the page and the page can work in a tiny window
- [x] automatically open the localhost url in the browser when the server starts (if it's not already open)
- [x] wait_for_utterance should check if voice input is still active on every loop and return immediately if it's not.
- [ ] handle multiple instances running on same machine for different Claude Code projects (dynamic port allocation or per-project configuration)
- [x] temporarily remove requirement for Claude to speak before stopping
- [x] re-enable requirement for Claude to speak before stopping when 1.0.45 version of claude code is released with the stop hook fix
- [x] eliminate timeout check in stop hook. Only check if voice input is active.
- [x] eliminate time-to-wait argument from wait_for_utterance tool. Default to 60 seconds.
- [x] ~~make the formatting consistent between the pre-tool auto-dequeue and the stop hook auto-wait. Both should have the speak reminder at the end if voice responses are enabled.~~ (Pre-tool hook removed)
- [ ] add configurable timeout for wait_for_utterance tool on frontend
- [x] investigate if post-tool hook can send info to assistant and dequeue in there
- [x] add hint to post-tool hook that assistant should speak if there are unresponded utterances
- [x] add note to dequeue_utterances response that spoken response is required (if voice responses are enabled)
- [x] eliminate dequeue_utterances tool. Just dequeue in the hooks. Return the utterances and the note about spoken response.
- [x] remove the bash scripts for the hooks. They could be defined inline in the claude settings.
  - [x] consider using a custom subdomain
- [x] experiment with waiting for utterance automatically in stop hook. How is the user experience? Can the user see that the assistant is waiting for them to speak? We could show something in the frontend.
- [x] add a front-end indicator when Claude is waiting for utterances
- [x] make the auto-wait and auto dequeue behavior configurable? Alternatively, eliminate the tools and just use the hooks.
  - [x] add a config option to hide the tools and enable auto-wait and auto-dequeue
- [ ] ~~Make the "must speak" stop hook text more consistent with the pre-tool-auto-dequeue and auto-wait text about voice input being active~~ (Pre-tool hook removed)
- [ ] Investigate if we can show and hide MCP tools live without restarting claude code (e.g. hide SPEAK if voice responses are disabled)
- [x] MVP
  - [x] add a warning when adjusting rate for google voices that the google voices don't work well with speech rate
  - [x] link to readme for info on system voice settings
  - [x] hide, label, or separate low quality voices
  - [x] choose a good default voice
  - [x] if i leave the browser open and restart the server, then it thinks voice input is off but it's actually on in the frontend. The same thing can happen with voice responses on/off
  - [x] If all utterances are pending, add help text to the browser that they need to send a typed message to Claude to start the conversation
- [x] Known issue: Microsoft Edge speech recognition not working - shows "language-not-supported" error
  - Safari and Chrome work fine for speech recognition
- [x] Reject speak requests when voice responses is disabled
  - [x] Server should return an error when voice responses is off
- [x] add a voice-input-is-active state tracker on the server and only block tool calls etc if "start listening" is active in the browser
- [x] reject dequeue and wait for utterance if voice input is not active
  - [x] server should return an error when voice input is not active
- [x] Replace "Use Browser TTS" checkbox with voice selection dropdown
  - [x] First option: "Mac System Voice" (uses macOS `say` command)
  - [x] Remaining options: Browser voices from speechSynthesis.getVoices()
  - [x] Show dropdown only when voice responses is enabled
  - [x] Group options into three sections (e.g., System TTS, Browser TTS using local voices, Browser TTS using cloud voices)
  - [x] remove volume slider
  - [x] group local voices into low and high quality
- [x] Refactor voice system architecture for cleaner separation
  - [x] Create /api/speak-system endpoint that always uses Mac say command
  - [x] Update browser to handle voice selection entirely
    - [x] Call /api/speak-system when "Mac System Voice" is selected
    - [x] Use local speechSynthesis when browser voice is selected
  - [x] Remove browserTTSEnabled state sharing between server and browser
  - [x] Browser becomes solely responsible for voice selection logic
- [x] Add text input field next to rate slider
  - [x] Allow users to type exact rate values
  - [x] Sync with slider position
  - [x] Validate input (extended to 0.5 to 5.0 range)
  - [x] Apply same to volume slider for consistency
- [ ] clean up completed tasks in roadmap.md
- [x] experiment with having the server remind the assistant to use voice responses instead of having a post tool hook
- [ ] Set up automated publishing workflow (GitHub Actions)
- [x] Clean up speak endpoint response to reduce window clutter
  - [x] Remove or simplify the "Spoke: [text]" output
  - [x] Remove or simplify the "Marked X utterance(s) as responded" message
  - [x] Make the response more concise while maintaining necessary functionality
- [x] ensure hooks and settings are updated on every server startup
- [x] bump version to 1.0.7
- [x] bump version to 1.0.8
- [x] refactor: replace post-tool hook with inline voice response reminders
- [x] refactor: implement unified hook handler for cleaner control flow
  - [x] Consolidate all hook logic into single handleHookRequest function
  - [x] Each hook endpoint now calls unified handler with action type
- [x] fix: reset lastTimeoutTimestamp when clearing utterance queue
  - [x] Prevents stop hook from incorrectly allowing stops after queue clear
  - [x] Added comprehensive tests for queue clearing behavior
- [x] fix: resolve TypeScript warnings for unused parameters
- [x] Improve speaking flow ✅ **COMPLETED**
  - [x] Add new speak_and_then_wait_for_utterance tool
  - [x] Make both speak and speak_and_then_wait_for_utterance fail if there are pending utterances
    - [x] Create a separate pre-speak hook that runs before speak and speak_and_then_wait_for_utterance tools. It should only block for pending utterances, otherwise approve.
    - [x] Hook matches only speak and speak_and_then_wait_for_utterance tools
    - [x] Only validates that no pending utterances exist (first step of validation)
    - [x] Forces dequeue_utterances to be called before any speaking/waiting.
    - [x] This ensures clean conversation flow: dequeue → speak → wait
    - [x] if voice responses are enabled, require speak_and_then_wait_for_utterance in the stop hook, otherwise require wait_for_utterance
- [x] add a CLI argument --speak to the server to enable voice responses
  - [x] remove the MCP_VOICE_RESPONSES_ENABLED environment variable and switch all references to it to --speak
  - [x] update the readme to reflect the new CLI argument
- [x] Investigate hiding the speak mcp tools when voice responses are disabled
- [x] ~~Investigate consolidating the pre-tool hook, pre-speak hook, and pre-wait hook into a single hook that runs before all tools and checks which tool is being used and switches logic based on that~~ (Pre-tool hook removed)
- [x] Improve conversation flow by tracking tool usage ✅ **COMPLETED**
  - [x] Remove speak_and_then_wait_for_utterance tool (use separate speak and wait_for_utterance instead)
  - [x] Track timestamp of last approved tool use
  - [x] Enforce speaking after tool use before wait_for_utterance or stop:
    - [x] Check for pending utterances (must dequeue first)
    - [x] Check for unresponded utterances when voice enabled (must speak first)
    - [x] Check if spoken since last tool use (must speak first)
    - [x] Check if timeout occurred (if no, must wait_for_utterance; if yes, can stop)
  - [x] Create pre-wait hook that enforces speaking after tool use
    - [x] Hook matches only wait_for_utterance tool
    - [x] Validates no pending utterances
    - [x] Validates no unresponded utterances (when voice enabled)
    - [x] Validates that speak was called after last tool use
  - [x] Update stop hook logic to check if spoken since last tool use
  - [x] Add comprehensive tests for conversation flow tracking
- [ ] Remove mocking from test as much as possible. Claude went off the rails and made way too many mocks. Tons of duplicate logic exists.

### Voice Response Tracking & Conversation Flow Enforcement

#### Step 1: Create speak/say endpoint (can be tested independently) ✅ **COMPLETED**

- [x] Create new speak/say endpoint for text-to-speech
  - [x] `/api/speak` endpoint
  - [x] Takes `text` parameter to speak
  - [x] Executes text-to-speech using macOS `say` command
  - [x] Marks all "delivered" utterances as "responded"
  - [x] Returns success/error status
- [x] Add MCP tool 'speak' that calls the endpoint
- [x] Test endpoint independently - works correctly!

#### Step 2: Implement conversation flow enforcement ✅ **COMPLETED**

- [x] Add third utterance state: "responded" (in addition to "pending" and "delivered")
- [x] Create unified action validation endpoint: `/api/validate-action`
  - [x] Combines and extends functionality from `/api/should-wait` and `/api/has-pending-utterances`
  - [x] Takes an `action` parameter (e.g., "tool-use", "stop")
  - [x] Returns either:
    - `{ allowed: true }` - Action can proceed
    - `{ allowed: false, requiredAction: "dequeue_utterances" }` - Has pending utterances
    - `{ allowed: false, requiredAction: "speak" }` - Has delivered but unresponded utterances (when VOICE_RESPONSES_ENABLED=true)
    - `{ allowed: false, requiredAction: "wait_for_utterance" }` - For stop action only, when all responded but no timeout yet
  - [x] Logic by action type:
    - **tool-use**:
      - Block if pending utterances exist → require dequeue_utterances
      - Block if delivered but unresponded utterances exist (when voice enabled) → require speak
      - Allow if all utterances are responded
    - **stop**:
      - Block if pending utterances exist → require dequeue_utterances
      - Block if delivered but unresponded utterances exist (when voice enabled) → require speak
      - Block if all responded but no timeout since last utterance → require wait_for_utterance
      - Allow only after timeout with no new utterances
- [x] Update hooks to use unified endpoint:
  - [x] Pre-tool hook calls with action="tool-use"
  - [x] Stop hook calls with action="stop"
  - [x] Both hooks check response and provide appropriate feedback
- [x] This ensures proper conversational flow:
  1. User speaks (utterance created as "pending")
  2. Assistant receives utterances (marked as "delivered")
  3. Assistant must speak response via speak endpoint (marks utterances as "responded")
  4. Only then can assistant proceed with tool use or stopping
- [x] Created comprehensive unit tests for validate-action endpoint
- [x] Created unit tests for utterance state transitions
- [x] All tests passing (58 total)
- [x] create dedicated endpoints for each hook
  - [x] ~~pre-tool hook~~ (removed)
  - [x] stop hook
- [x] have the server respond in the exact format that can be passed directly to claude. e.g. echo "{\"decision\": \"block\", \"reason\": \"$reason\"}"

### Text-Based POC ✅ **COMPLETED**

#### Core MCP Server

- [x] Research Claude Code hooks integration
- [x] Set up TypeScript MCP server project structure
- [x] Implement utterance queue with basic MCP tools for LLM:
  - [x] `dequeue_utterances()` - dequeues all pending utterances
  - [x] immediately returns none if there are no recent utterances (doesn't block or wait for an utterance)
- [x] API for browser client to send potential utterances to MCP server
  - [x] HTTP API: `POST /api/potential-utterances`, `GET /api/utterances`
  - [x] MCP tool: `dequeue_utterances()`
- [x] Always categorize text input as a complete utterance for Phase 1
- [x] Add utterance to queue with timestamp
- [x] Unit test send_text_input, get_recent_utterances

#### Browser Client

- [x] Create simple HTML/JS client with text input
- [x] Implement HTTP communication with MCP server
- [x] Add real-time utterance submission
- [x] Show utterances from server in a reverse chronological list with the status (pending, delivered)
- [x] Auto-refresh utterance list every 2 seconds
- [x] Status dashboard showing total/pending/delivered counts

#### Preliminary Hook Integration

- [x] Test MCP server with Claude Code client
- [x] Verify `get_recent_utterances` tool works in Claude Code
- [x] Basic MCP integration working - utterances visible to Claude Code
- [x] Configure PostToolUse hooks to check for utterances automatically

### Wait for utterance ✅ **COMPLETED**

- [x] Add a `wait_for_utterance` tool to the MCP server: `wait_for_utterance(seconds_to_wait?: number)`
  - [x] wait_for_utterance should block until an utterance is able to be dequeued or the timeout is reached (default 10 seconds). It should return immediately if there has been no utterance since the last time it timed out (we'll need to keep track of the last time it timed out)
- [x] Configure the Stop hook to require `wait_for_utterance` to be called
- [x] Add `should_wait` endpoint to intelligently decide when to block Stop hook
  - [x] `/api/should-wait` returns `{ shouldWait: boolean }` based on utterances since last timeout
  - [x] Stop hook calls this endpoint to decide whether to block or approve
- [x] Stop hook now provides clear feedback messages when blocking or approving

### Pre-Tool Use Hooks ✅ **COMPLETED**

- [x] Create API endpoint to check for pending utterances
  - [x] `/api/has-pending-utterances` returns `{ hasPending: boolean, pendingCount: number }`
- [x] ~~Implement pre-tool use hook script~~ (removed)
  - [x] ~~Checks for pending utterances before allowing tool execution~~
  - [x] ~~Blocks tool execution if utterances are pending~~
  - [x] Forces Claude to use `dequeue_utterances` tool first
- [x] Hook provides clear feedback about pending utterance count

### Front-End Utterance Segmentation ✅ **COMPLETED**

- [x] Implement Web Speech API continuous listening in browser client
  - [x] Add "Start Listening" button to enable continuous speech recognition
  - [x] Configure `recognition.continuous = true` for uninterrupted listening
  - [x] Enable `recognition.interimResults = true` for real-time feedback
- [x] Implement automatic utterance segmentation based on speech pauses
  - [x] Monitor `onresult` event for `isFinal` results
  - [x] Send completed utterances to server when user pauses
  - [x] Continue listening for next utterance without interruption
- [x] Update UI to show listening status and interim transcription
  - [x] Visual indicator for active listening (e.g., microphone icon)
  - [x] Display interim text as user speaks
  - [x] Clear interim text after sending final utterance
- [x] Handle edge cases
  - [x] Microphone permissions
  - [x] Recognition errors
  - [x] Browser compatibility checks
- [x] Tested utterance segmentation behavior successfully
- [x] Made HTTP server port configurable via MCP_VOICE_HOOKS_PORT environment variable (default: 5111)
- [x] Updated hook scripts to use configurable port
- [x] Auto-install/update hooks on MCP server startup
- [x] Remove confirmation dialog from clear all button
- [x] Clarify development docs: TypeScript needs building, browser files don't

### Utterance classification

- [ ] Add server-side LLM integration for utterance completion detection (POC should use claude cli or sdk <https://docs.anthropic.com/en/docs/claude-code/sdk> to categorize utterances as complete or not)
- [ ] unit test the utterance classification
- [ ] Design: Consider segmenting potential utterances into a complete utterance, which would be the first and the first word up to the last word in the complete utterance, and then our remaining words that are incomplete. Then the client would just pop the complete utterance out of the end. Continue appending things on to the end of the incomplete.

### Speech Recognition

- [x] Integrate Web Speech API in browser client
- [x] Add microphone input selection and monitoring
- [x] Implement continuous speech recognition (using Web Speech API's built-in pause detection with `isFinal` results instead of the originally planned approach)
- [x] Add a button to start/stop listening

### Text-to-Speech

- [ ] Implement TTS using Mac's `say` command on the server
- [ ] Expose a `speak_text` MCP tool to speak text
- [ ] Update the `wait_for_utterance` tool to include a `text_to_speak_before_listening` parameter

### Tool Description Improvements

- [ ] Improve MCP tool descriptions for better standalone usage (without hooks)
  - [ ] Add clear, detailed descriptions for `dequeue_utterances`
  - [ ] Add comprehensive description for `wait_for_utterance`
  - [ ] Include usage examples in tool descriptions
  - [ ] Explain the voice interaction workflow in descriptions
- [ ] Test server usability without hooks installed
- [ ] Document standalone usage patterns

### Audio Feedback ✅ **COMPLETED**

- [x] Add sound notification when `wait_for_utterance` starts listening
  - [x] Implement simple sound playbook (ding/beep)
  - [x] Use system sounds or generate simple tone
  - [x] Make sound optional via configuration
  - [x] Play sound before starting to wait for utterances

### UI Enhancements

- [x] Add a "Clear All" button to the UI

### NPX Integration

- [x] Create CLI entry point (`bin/cli.js`) for npx support
- [x] Implement `npx mcp-voice-hooks` main command
  - [x] Default behavior: Start the MCP server
  - [x] Handle server startup and configuration
- [x] Implement `npx mcp-voice-hooks install-hooks` subcommand
  - [x] Auto-install/update hook files to user directory (`~/.mcp-voice-hooks/hooks/`)
  - [x] Automatically configure project-specific Claude Code settings (`./.claude/settings.local.json`)
  - [x] Handle first-time setup and updates seamlessly
- [x] Create comprehensive documentation for npx installation
- [ ] Test npx integration across different environments
- [x] use a custom localhost url instead of localhost:3000

### NPM Publishing

- [x] Version 1.0.2 - Port configuration feature

- [x] Prepare package for npm publication
  - [x] Update package.json with proper metadata (description, keywords, repository, author)
  - [x] Add `"bin"` field to package.json pointing to CLI entry point
  - [x] Ensure all necessary files are included in the published package
  - [x] Add `.npmignore` if needed to exclude development files
- [x] Create npm account and configure authentication
- [x] Test package locally with `npm pack` and run it with `npx file...`
  - [ ] set up pre commit hooks to make sure this can run locally
- [x] Publish to npm registry with `npm publish`
- [x] Test npx execution from npm: `npx mcp-voice-hooks`
- [x] test claude mcp add voice-hooks npx mcp-voice-hooks
- [x] document system voice settings
- [ ] Set up automated publishing workflow (GitHub Actions)

### Development Quality ✅ **COMPLETED**

- [x] Add pre-commit hooks to run tests automatically
  - [x] Install and configure husky pre-commit framework
  - [x] Set up hooks to run unit tests before commits
  - [x] Configure hooks to run knip and ts-prune for unused code detection
  - [x] Add hooks for TypeScript type checking
  - [x] Ensure tests pass before allowing commits
  - [x] Require roadmap.md updates in every commit

**Automatic Hook Configuration** (added to `.claude/settings.local.json`):

   ```json
   {
     "hooks": {
       "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "sh ~/.mcp-voice-hooks/hooks/stop-hook.sh"}]}],
       // PreToolUse hook removed
     }
   }
   ```

- [x] make sure we don't clobber the user's claude settings
  - [x] Implement intelligent hook merging that preserves existing hooks
  - [x] Only updates voice-hooks related hooks
  - [x] Avoids unnecessary writes when hooks are only reordered
- [x] add a readme to `~/.mcp-voice-hooks` with instructions for how to uninstall (`rm -rf ~/.mcp-voice-hooks`, and remove the hooks from the claude settings)
- [x] clean up anything in `~/.mcp-voice-hooks` before installing
- [x] add a script to uninstall
  - [x] `rm -rf ~/.mcp-voice-hooks`
  - [x] and remove the hooks from the claude settings

## Technical Decisions

### Language Choice: TypeScript

- **Pros**: Easy browser integration, Node.js ecosystem, MCP SDK support
- **Cons**: Less robust audio processing than Python
- **Decision**: Start with TypeScript for simplicity, can migrate later if needed

### Audio Processing: Browser-based

- **Pros**: Built-in Web Speech API, no OS-level audio handling
- **Cons**: Privacy concerns, internet dependency
- **Decision**: Use browser for POC, evaluate alternatives later

### Architecture: Local Server + Browser Client

- **Pros**: Leverages browser capabilities, clean separation of concerns
- **Cons**: Additional complexity vs. pure CLI approach
- **Decision**: Hybrid approach provides best user experience

### Communication Protocol: HTTP (POC) → WebSockets (Later)

- **HTTP for POC**:
  - **Pros**: Simple REST API, easier debugging, faster initial implementation
  - **Cons**: Polling overhead, higher latency, no real-time push notifications
  - **API**: `POST /api/potential-utterances`, `GET /api/utterances`, `GET /api/utterances/status`
- **WebSockets for Production**:
  - **Pros**: Real-time bidirectional communication, low latency, efficient for voice interaction
  - **Cons**: Connection management complexity, harder to debug
  - **Events**: `utterance`, `utterance_queued`, `utterance_delivered`
- **Decision**: Start with HTTP for rapid POC development, migrate to WebSockets when real-time features become critical

## **Architecture Achieved**

```text
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Browser UI    │    │ Unified Server  │    │  Claude Code    │
│                 │    │                 │    │                 │
│ • Text Input    │◄──►│ • HTTP Server   │    │ • MCP Proxy     │
│ • Voice Input   │    │ • Shared Queue  │◄──►│ • Tool Calls    │
│ • Status View   │    │ • Hook APIs     │    │ • Pre-Tool Hook │
│ • Auto Refresh  │    │ • Dequeue API   │    │ • Stop Hook     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

**Key Innovations:**

- MCP proxy architecture enabling shared state between browser and Claude Code
- Web Speech API integration for automatic utterance segmentation
- Hook system that ensures voice input is processed before actions
