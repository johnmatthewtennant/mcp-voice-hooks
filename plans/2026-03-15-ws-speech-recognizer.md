# WebSocket Speech Recognizer & TTS/UI Improvements Implementation Plan

## Overview

This branch (`feature/ws-speech-recognizer`) implements server-side speech recognition via a Swift binary that uses Apple's macOS 26 `SpeechTranscriber` API, along with several TTS reliability fixes, UI simplifications, and WebSocket hardening. The goal is to move speech recognition from the browser (Web Speech API) to the server for better accuracy and lower latency, while simplifying the client to be display-only for transcripts.

## Current State Analysis

The system previously relied on browser-side Web Speech API for speech recognition, with audio captured via WebSocket but only counted (not processed). TTS audio delivery had two paths: WebSocket binary streaming and SSE fallback with HTTP file serving. The UI had trigger word mode, browser voice selection, and a collapsible settings panel at the bottom.

### Key Discoveries:
- WebSocket audio capture was already in place (Phase 1) but audio frames were received and counted without processing (`src/unified-server.ts` previously had `// Phase 1: just receive and count`)
- macOS `say` command produces WAV files with JUNK/FLLR padding chunks, causing the data chunk to start at byte ~4096 instead of the standard 44-byte header offset, which resulted in click/pop audio artifacts
- Multiple browser tabs could each open a WebSocket audio connection, causing duplicate speech recognition and TTS delivery
- SSE audio fallback path (`notifyTTSAudio`, `renderedAudioFiles` map, `/api/tts-audio/:id` endpoint) was dead code once WebSocket TTS streaming was working
- Trigger word mode and browser voice selection added UI complexity no longer needed with server-side recognition

## Desired End State

1. **Server-side speech recognition**: Swift binary (`speech-recognizer`) spawned as child process, fed PCM audio via stdin, emits JSON transcript events via stdout. Server creates utterances directly from final transcripts (no browser round-trip).
2. **Reliable TTS audio**: WAV data chunk offset parsed correctly (no click/pop), overlapping TTS handled by queuing, single WebSocket client enforced.
3. **Simplified UI**: Single mic button toggles both voice input and output. Settings in top-right dropdown. No trigger word mode. No browser voice selection. Recognition mode toggle (server/browser).
4. **WebSocket-only audio**: SSE audio fallback removed. TTS audio delivered exclusively via WebSocket binary frames.

### Verification:
- `npm test` passes (86 tests including 17 new speech-recognition tests)
- Manual: speak into mic, see interim transcripts in UI, see final transcript appear as conversation message, hear TTS response without clicks/pops
- Manual: open second browser tab, first WebSocket connection closes cleanly
- Manual: server without Swift binary falls back to browser recognition gracefully

## What We're NOT Doing

- Custom vocabulary / contextual strings for SpeechTranscriber (researched in `plans/custom-dictionary-research.md`, deferred)
- OpenAI Whisper integration (roadmap item, separate effort)
- Multi-session WebSocket support (each session gets its own recognizer -- not yet)
- Echo cancellation improvements beyond the existing mute-during-TTS approach
- Changing the MCP tool interface or hook system
- Authentication/CSRF for new endpoints -- this is a localhost-only dev tool, consistent with all existing endpoints
- WS reconnection/replay for TTS -- audio is WS-only; when WS is disconnected, no TTS audio is delivered and no browser TTS fallback exists. The server still sends SSE `speak` events (used for conversation history display), but the client no longer acts on them for audio playback.
- CI/distribution pipeline for Swift binary -- dev-only tool, built locally

## Implementation Approach

The changes are organized into 6 logical areas, each independently testable. The branch implements all of them across 10 commits.

---

## Audio Wire Format Contract

The end-to-end audio pipeline uses a single format:
- **Encoding**: PCM 16-bit signed integer, little-endian
- **Sample rate**: 16,000 Hz
- **Channels**: 1 (mono)
- **Frame size**: 640 bytes per WebSocket frame (20ms of audio at 16kHz, 16-bit)

This format is set by the browser's `AudioWorklet` (captures at 16kHz mono PCM16), transmitted as WebSocket binary frames, and consumed directly by the Swift binary's `StdinAudioSource`. The Swift binary's `AVAudioConverter` handles any resampling needed for the `SpeechTranscriber` model's preferred format.

## Platform Requirements

- **Build**: macOS 15+ (Swift Package minimum deployment target for compilation)
- **Runtime**: macOS 26+ (required for `SpeechTranscriber` API, enforced by `@available(macOS 26.0, *)` guard in `main.swift` with explicit error message and `exit(1)` on older OS)
- **Non-macOS**: Swift binary won't exist; `SpeechRecognizer.binaryExists()` returns false, server falls back to browser recognition automatically

---

## Phase 1: Swift Speech Recognizer Binary

### Overview
Standalone Swift executable that reads PCM16 LE 16kHz mono audio from stdin, runs Apple's `SpeechTranscriber` (macOS 26+), and outputs JSON lines to stdout with interim and final transcript results.

### Changes Required:

#### 1. Swift Package
**File**: `swift/speech-recognizer/Package.swift` (new)
**Changes**: Swift Package Manager config targeting macOS 15+ (compilation target; runtime availability enforced by `@available` guard in main.swift) with single executable target.

#### 2. StdinAudioSource
**File**: `swift/speech-recognizer/Sources/SpeechRecognizer/StdinAudioSource.swift` (new)
**Changes**: Reads raw PCM16 LE audio from stdin in 4096-byte chunks on a background `DispatchQueue`. Produces `AsyncStream<TimestampedBuffer>` with timestamps computed from cumulative sample count. Handles byte alignment (leftover bytes from odd-length reads).

#### 3. Main Entry Point
**File**: `swift/speech-recognizer/Sources/SpeechRecognizer/main.swift` (new)
**Changes**: Creates `SpeechTranscriber` with `.volatileResults` for interim output. Gets best available audio format, creates `SpeechAnalyzer`, converts stdin audio to analyzer input format via `AVAudioConverter`. Runs three concurrent tasks: stdin reader, analyzer, and results processor. Outputs `{"type":"interim","text":"..."}` and `{"type":"final","text":"..."}` JSON lines to stdout. Thread-safe stdout writes via `NSLock`.

#### 4. .gitignore
**File**: `.gitignore`
**Changes**: Add `.build/` for Swift build artifacts.

### Success Criteria:
- [ ] `cd swift/speech-recognizer && swift build -c release` compiles successfully
- [ ] Binary at `swift/speech-recognizer/.build/release/speech-recognizer` exists
- [ ] Piping PCM audio to stdin produces JSON transcript lines on stdout

---

## Phase 2: Node.js SpeechRecognizer Wrapper

### Overview
TypeScript wrapper class that manages the Swift binary as a child process, with auto-restart on crash, backpressure handling, and EventEmitter-based transcript events.

### Changes Required:

#### 1. SpeechRecognizer Class
**File**: `src/speech-recognition.ts` (new, 118 lines)
**Changes**:
- `SpeechRecognizer` extends `EventEmitter`
- `binaryExists(repoRoot)` static method checks if Swift binary is on disk
- `start()` spawns process with `stdio: ['pipe', 'pipe', 'pipe']`, reads JSON lines from stdout via `readline`
- `feedAudio(pcmBuffer)` writes to stdin, handles backpressure by dropping frames
- `stop()` closes stdin (graceful EOF shutdown)
- `kill()` forcefully kills process
- Auto-restart on crash (non-zero exit code) after 500ms delay, unless intentionally stopped. Note: each restart begins a fresh transcription session, so no duplicate final transcripts are possible from a partially-recognized utterance.
- **Crash-loop protection**: If the process crashes 3 times within 5 seconds (e.g., unsupported macOS version where binary compiles but SpeechTranscriber API is unavailable at runtime), auto-restart is disabled and an error is emitted. This prevents indefinite crash-looping on macOS 15-25 where the binary exists but exits immediately with code 1.
- Emits `transcript`, `error`, `exit` events

#### 2. Unit Tests
**File**: `src/__tests__/speech-recognition.test.ts` (new, 290 lines)
**Changes**: 17 tests covering start/stop, feedAudio with backpressure, transcript event parsing, error handling, auto-restart on crash, no restart on clean exit or intentional stop.

### Success Criteria:
- [ ] `npm test -- --testPathPattern=speech-recognition` passes (17 tests)
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

## Phase 3: Server Integration (Speech Recognition + Single WS Client)

### Overview
Wire the SpeechRecognizer into the WebSocket audio pipeline. Enforce single WebSocket client. Add `/api/speech-recognition-available` endpoint. Create utterances directly from final transcripts.

### Changes Required:

#### 1. Server-side Recognition Integration
**File**: `src/unified-server.ts`
**Changes**:
- Import `SpeechRecognizer` from `./speech-recognition.js`
- Add `NO_TRANSCRIBE` flag (`--no-transcribe` CLI arg or `MCP_VOICE_HOOKS_NO_TRANSCRIBE` env)
- Add `SPEECH_RECOGNIZER_AVAILABLE` constant (checks binary exists and not disabled)
- Add `recognizer: SpeechRecognizer | null` field to `WsAudioClient` interface
- `startRecognizerForClient()` function: creates recognizer, wires transcript events to WS messages, creates utterances on final transcript via `session.queue.add()`
- On `audio-start` control message: spawn recognizer if available
- On `audio-stop`: gracefully stop recognizer (close stdin to flush)
- On WS `close`: kill recognizer
- Pipe binary audio frames to `client.recognizer.feedAudio(buf)` instead of just counting
- Add `GET /api/speech-recognition-available` endpoint returning `{ available: boolean }`

#### 2. Single WebSocket Client Enforcement
**File**: `src/unified-server.ts`
**Changes**:
- On new WebSocket connection: iterate existing `wsAudioClients`, close each with `1000` status code and "Replaced by new connection" reason, kill their recognizers, clear ping timers
- This prevents duplicate recognition and TTS delivery from multiple tabs
- Design note: this is a single-user localhost dev tool. The browser already handles WS disconnection (reconnects automatically). No drain/handoff needed -- the old connection's audio pipeline is immediately replaced by the new one.

#### 3. Test Voice Endpoint
**File**: `src/unified-server.ts`
**Changes**:
- Add `POST /api/test-voice` endpoint that triggers TTS without side effects (used by the Test TTS button in the UI)

### Success Criteria:
- [ ] Server starts without Swift binary (falls back gracefully, logs message)
- [ ] `GET /api/speech-recognition-available` returns correct status
- [ ] Opening second WS connection closes the first
- [ ] Speech recognition produces utterances in the queue

---

## Phase 4: TTS Audio Fixes

### Overview
Fix click/pop artifacts from incorrect WAV header parsing and fix audio overlap when multiple TTS utterances arrive quickly.

### Changes Required:

#### 1. WAV Data Chunk Parsing
**File**: `src/unified-server.ts`
**Changes**:
- Remove `const WAV_HEADER_SIZE = 44` constant
- Add `findWavDataOffset(buf: Buffer): number` function that parses RIFF chunks to find the 'data' chunk, skipping JUNK/FLLR padding chunks inserted by macOS `say`
- In `streamTtsOverWs()`: use `findWavDataOffset()` instead of hardcoded 44-byte offset

#### 2. TTS Overlap Fix (Client)
**File**: `public/app.js`
**Changes**:
- In `AudioPlayer.prepareForPlayback()`: only reset `nextStartTime` if no audio is currently queued (i.e., `nextStartTime < currentTime`), preventing new audio from stomping on in-progress playback
- Add `isFirstChunk` flag to AudioPlayer for tracking first chunk of each TTS utterance

### Success Criteria:
- [ ] No click/pop at start of TTS audio playback
- [ ] Multiple consecutive TTS utterances play sequentially without overlap

---

## Phase 5: SSE Audio Fallback Removal

### Overview
Remove the SSE-based audio delivery path, making WebSocket the only way TTS audio reaches the client.

### Changes Required:

#### 1. Remove Server-Side SSE Audio Infrastructure
**File**: `src/unified-server.ts`
**Changes**:
- Remove `renderedAudioFiles` Map and its periodic cleanup interval
- Remove `notifyTTSAudio()` function
- Remove `GET /api/tts-audio/:id` endpoint (served WAV files via HTTP)
- In `processTtsQueue()`: replace SSE fallback with a debug log when no WS client is found
- In `POST /api/speak`: always render TTS audio (remove `if (selectedVoice === 'system')` conditional)

#### 2. Remove Client-Side SSE Audio Handling
**File**: `public/app.js`
**Changes**:
- Remove `audioQueue`, `audioPlaying`, `currentAudio` state
- Remove `processAudioQueue()` method (SSE-based audio playback via `new Audio(url)`)
- Remove `clearAudioQueue()` method
- Remove `speakText()` method (browser `SpeechSynthesisUtterance` TTS)
- Remove `initializeSpeechSynthesis()` method (voice loading, deduplication)
- Remove SSE event handler for `tts-audio` event (audio URL delivery path)
- Remove SSE event handler for `speak` event (browser TTS path -- server still sends these events but client no longer does browser TTS from them; conversation display uses the HTTP API, not SSE)
- In `tts-clear` SSE handler: only call `this.audioPlayer.clear()` (remove `clearAudioQueue()`)

### Success Criteria:
- [ ] No references to `tts-audio`, `audioQueue`, `notifyTTSAudio` in codebase
- [ ] TTS audio plays when WebSocket is connected
- [ ] When no WebSocket client: server logs a debug message and skips audio delivery (no audio reaches the client; server still sends SSE `speak` text events but client does not act on them for audio)

---

## Phase 6: UI Simplification

### Overview
Simplify the browser interface: single mic button toggles both voice input and output, settings moved to top-right dropdown, trigger word mode removed, recognition mode selector added.

### Changes Required:

#### 1. Single Mic Button Toggle
**File**: `public/app.js`
**Changes**:
- `startVoiceDictation()`: also calls `updateVoiceResponses(true)` to enable TTS when mic is on
- `stopVoiceDictation()`: also calls `updateVoiceResponses(false)` to disable TTS when mic is off
- Start browser `recognition` only when NOT using server recognition (`!this.useServerRecognition`)
- Add `useServerRecognition` getter: `recognitionMode === 'server' && serverRecognitionAvailable && wsConnected`
- Don't disable mic button when Web Speech API unavailable (server recognition may still work)

#### 2. Recognition Mode
**File**: `public/app.js`
**Changes**:
- Replace `sendMode`/`triggerWord`/`accumulatedText` state with `recognitionMode` ('server'|'browser') and `serverRecognitionAvailable`
- Add `checkServerRecognition()` method calling `GET /api/speech-recognition-available`
- Fall back to browser mode if server recognition unavailable
- Handle `transcript-interim` and `transcript-final` WS messages (display in input field / refresh conversation)
- Skip browser `recognition.onresult` when using server recognition
- Persist recognition mode in localStorage

#### 3. Settings Dropdown
**File**: `public/index.html`
**Changes**:
- Move settings toggle to top-right header area as a dropdown button
- Settings panel opens as a dropdown overlay instead of inline collapsible section
- Remove send mode controls (auto-send / trigger word radio buttons)
- Remove voice selection dropdown (browser voices, language filter, voice warnings)
- Remove voice responses toggle (now tied to mic button)
- Keep: speech rate slider/input, test TTS button, recognition mode selector, debug toggle

**File**: `public/app.js`
**Changes**:
- Settings toggle: `click` toggles `open` class, close on click-outside
- Remove `populateVoiceList()`, `populateLanguageFilter()`, `updateVoiceWarnings()` methods
- Remove voice selection event listeners
- Remove references to removed DOM elements (`voiceResponsesToggle`, `voiceOptions`, `voiceSelect`, etc.)

#### 4. Remove Trigger Word Mode
**File**: `public/app.js`
**Changes**:
- Remove `containsTriggerWord()` and `removeTriggerWord()` methods (if they existed)
- Remove trigger word logic from `stopVoiceDictation()`
- Simplify: on stop, send accumulated non-interim text and clear

### Success Criteria:
- [ ] Mic button toggles both voice input and TTS responses
- [ ] Settings dropdown opens/closes from top-right gear icon
- [ ] No trigger word UI elements visible
- [ ] Recognition mode selector shows server/browser options
- [ ] Server recognition option disabled when binary not available

---

## Testing Strategy

### Unit Tests:
- `src/__tests__/speech-recognition.test.ts`: 17 tests for SpeechRecognizer wrapper (start/stop, feedAudio, backpressure, transcript parsing, auto-restart, error handling)
- Existing test suite (86 tests total) should continue passing
- **Non-happy-path tests** (already covered in speech-recognition.test.ts):
  - Malformed JSON stdout lines: the `rl.on('line')` handler's `try/catch` is exercised by the existing test structure (mock process emits arbitrary data). The transcript event tests verify only valid JSON triggers events.
  - `findWavDataOffset` edge cases: should add targeted unit tests for WAV files with no data chunk (returns fallback 44 -- intentional: a malformed WAV will produce garbage audio but won't crash the server; the fallback is logged for debugging), WAV files with JUNK/FLLR chunks before data, and truncated WAV headers
  - Process exit on unsupported macOS: on macOS 15-25, the binary can compile but will exit with code 1 at runtime. The crash-loop protection (3 crashes in 5 seconds) disables auto-restart and emits an error. Test: verify that 3 rapid crashes within the threshold triggers disable behavior.

### Manual Testing:
1. Build Swift binary: `cd swift/speech-recognizer && swift build -c release`
2. Start server: `npm run build && node dist/unified-server.js --debug`
3. Open browser, click mic, speak -- verify interim transcripts appear and final transcripts create utterances
4. Open second tab -- verify first connection closes
5. Test without Swift binary (rename it) -- verify falls back to browser recognition
6. Test TTS: trigger a speak -- verify no click/pop, no overlap on rapid consecutive speaks
7. Verify settings dropdown opens/closes correctly

## Operational Safety

- **Process lifecycle**: Server must kill child recognizer processes on SIGTERM/SIGINT. The existing `process.on('exit')` handler in Node.js, combined with `client.recognizer.kill()` on WS close, handles this. The `SpeechRecognizer` class's `_stopped` flag prevents zombie restarts.
- **Stdout parsing**: `readline` interface reads one line at a time. Malformed JSON lines are caught and logged (existing `try/catch` in the `rl.on('line')` handler). Note: if the child emits a very long line without a newline, Node will buffer it in memory. This is accepted risk since the child process is a trusted local binary under our control (it always writes short JSON lines with `fflush(stdout)`).
- **Backpressure visibility**: Dropped audio frames are logged via `debugLog` when `--debug` is enabled. This is sufficient for a dev tool; no metrics infrastructure needed.

## Performance Considerations

- Speech recognizer auto-restarts on crash with 500ms delay (prevents tight restart loops)
- Audio frames dropped under backpressure rather than buffering unboundedly
- `StdinAudioSource` uses `bufferingNewest(256)` policy to avoid memory growth
- Single WS client enforcement prevents duplicate processing
- WAV data chunk parsing is O(n) in chunk count (typically 3-4 chunks), negligible overhead

## References
- Existing plan: `plans/websocket-audio-plan.md`
- Custom dictionary research: `plans/custom-dictionary-research.md`
- Apple SpeechTranscriber docs: https://developer.apple.com/documentation/speech/speechtranscriber
- Branch commits: `git log master...HEAD --oneline` (10 commits)
