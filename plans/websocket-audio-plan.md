# WebSocket-Based Bidirectional Audio Plan

> **Session reference**: `~/.claude/projects/-Users-jtennant-Development/d22f274d-b7c8-4700-89b4-8aea719e745e.jsonl`

## Problem Statement

The current voice interface has two reliability issues on iOS Safari:

1. **Speech recognition**: Uses browser Web Speech API, which is flaky on iOS Safari
2. **TTS playback**: Uses SSE (`/api/tts-events`) + HTTP WAV file fetches, which are blocked by iOS autoplay restrictions

## Desired Architecture

Replace both with a **single bidirectional WebSocket**:

- **Upstream (browser → server)**: Raw microphone audio for server-side speech recognition
- **Downstream (server → browser)**: Interim transcripts + TTS audio chunks for AudioContext playback

The server runs speech recognition via a standalone Swift binary using Apple's on-device `SpeechTranscriber` API (macOS 26+, Neural Engine), eliminating browser speech API dependency. The browser plays TTS audio by writing PCM buffers to an AudioContext, which works on iOS Safari once unlocked by a user gesture (the "Start Listening" tap).

---

## Current Architecture Summary

### Server (`src/unified-server.ts`, ~1518 lines)

- **Express HTTP server** with REST endpoints for utterance management
- **SSE endpoint** (`GET /api/tts-events`) for pushing TTS events to browser
- **TTS pipeline**: Serialized queue → macOS `say -o /tmp/...wav` → serve WAV via `/api/tts-audio/:id`
- **MCP server** on stdio exposing `speak` tool to Claude Code
- **Hook endpoints**: `POST /api/hooks/stop`, `/api/hooks/pre-speak`, `/api/hooks/post-tool`
- **Session management**: Multi-session support with composite keys `[sessionId, agentId]`
- **Utterance state machine**: pending → delivered → responded

### Browser Client (`public/app.js`, ~1124 lines + `public/index.html`, ~1048 lines)

- **Speech input**: Web Speech API (`SpeechRecognition`) with continuous mode + interim results
- **Speech output**: Browser `speechSynthesis` API or fetch WAV from server
- **SSE client**: Listens on `/api/tts-events` for `speak`, `tts-audio`, `tts-clear`, `session-reset`, `waitStatus` events
- **UI**: Messenger-style chat with microphone button, voice settings panel

### Speech Recognition (new standalone Swift binary)

- **Fresh standalone Swift CLI** built specifically for voice hooks — no dependency on speech-recognizer or external libraries
- **Uses Apple's `SpeechTranscriber` / `SpeechAnalyzer` API** (macOS 26+, Neural Engine)
- **Stdin input**: Reads PCM audio from stdin, produces `AsyncStream<TimestampedBuffer>` internally
- **JSON output**: Writes JSON lines to stdout — `{"type":"interim","text":"..."}` and `{"type":"final","text":"..."}`
- **Volatile/interim results**: Enabled via `reportingOptions: [.volatileResults]`
- **Audio format**: Accepts PCM16 at 16kHz mono from stdin, converts internally via AVAudioConverter if needed
- **Lifecycle**: One process per WebSocket connection, stays running across utterances
- **Location**: Built as a Swift package within the voice hooks repo (e.g., `swift/speech-recognizer/`)

---

## WebSocket Protocol Design

### Connection

```
wss://localhost:5112/ws/audio
```

Query params:
- `session` (optional): Session composite key to associate with

### Message Types

All messages are JSON text frames except raw audio, which uses binary frames.

#### Client → Server

| Type | Format | Description |
|------|--------|-------------|
| Audio data | Binary frame (PCM16 LE) | Raw microphone audio, 16kHz mono, 16-bit signed LE, sent in 20ms chunks (640 bytes) |
| `audio-start` | `{ "type": "audio-start", "sampleRate": 16000, "channels": 1, "encoding": "pcm16" }` | Sent when mic capture begins |
| `audio-stop` | `{ "type": "audio-stop" }` | Sent when mic capture stops (user clicks Stop Listening) |
| `vad-speech-start` | `{ "type": "vad-speech-start" }` | VAD detected speech onset |
| `vad-speech-end` | `{ "type": "vad-speech-end" }` | VAD detected speech offset (end of utterance) |
| `tts-ack` | `{ "type": "tts-ack", "audioId": "<id>" }` | Client finished playing a TTS audio segment |
| `ping` | `{ "type": "ping" }` | Keepalive heartbeat (sent every 30s) |

#### Server → Client

| Type | Format | Description |
|------|--------|-------------|
| `transcript-interim` | `{ "type": "transcript-interim", "text": "...", "utteranceId": "<id>" }` | Partial/volatile transcription result for UI display |
| `transcript-final` | `{ "type": "transcript-final", "text": "...", "utteranceId": "<id>" }` | Finalized transcription — triggers utterance creation |
| TTS audio | Binary frame (raw PCM16 LE data) | TTS audio chunk for playback (always preceded by `tts-start` JSON message) |
| `tts-start` | `{ "type": "tts-start", "audioId": "<id>", "sampleRate": 22050, "channels": 1 }` | TTS audio stream starting |
| `tts-end` | `{ "type": "tts-end", "audioId": "<id>" }` | TTS audio stream complete |
| `tts-clear` | `{ "type": "tts-clear" }` | Clear TTS playback queue |
| `session-reset` | `{ "type": "session-reset" }` | New Claude session detected |
| `wait-status` | `{ "type": "wait-status", "isWaiting": true, "sessionKey": "..." }` | Claude waiting indicator |
| `error` | `{ "type": "error", "message": "..." }` | Error from server |
| `pong` | `{ "type": "pong" }` | Keepalive response |

### Audio Format Rationale

- **PCM16 at 16kHz mono** for upstream (mic → server): Standard speech recognition input format. 16kHz is sufficient for voice and keeps bandwidth low (~256 kbps). Apple's Speech framework handles format conversion internally.
- **PCM16 at 22050Hz mono** for downstream (TTS → browser): Matches current `say` command output format (22050Hz). No re-encoding needed.
- **20ms frame size** for upstream: Industry standard, balances latency vs overhead. At 16kHz/16-bit/mono = 640 bytes per frame.
- **Binary WebSocket frames** for audio: 33% more efficient than base64, no encode/decode CPU cost.

---

## Server-Side Changes

### Phase 1: WebSocket Endpoint

Add WebSocket upgrade support to the existing Express server using the `ws` package.

**File**: `src/unified-server.ts`

```typescript
// New dependency: npm install ws @types/ws
import { WebSocketServer, WebSocket } from 'ws';

// Attach to existing HTTP server
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (url.pathname === '/ws/audio') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});
```

**WebSocket connection handler**:
- Parse session from query params
- Track connected WS clients alongside existing SSE clients
- On binary message: forward to speech recognition pipeline
- On text message: parse JSON and handle control messages
- On close: clean up

### Phase 2: Speech Recognition Pipeline

Create a new module `src/speech-recognition.ts` that wraps `speech-recognizer` integration.

**Standalone Swift binary: `speech-recognizer`**

A fresh Swift CLI built within the voice hooks repo (`swift/speech-recognizer/`). Uses Apple's `SpeechTranscriber` API (macOS 26+) with Neural Engine for high-quality on-device recognition.

**Swift package structure**:
- `Package.swift` — Swift package manifest
- `Sources/SpeechRecognizer/main.swift` — Entry point, CLI argument parsing
- `Sources/SpeechRecognizer/StdinAudioSource.swift` — Reads PCM from stdin, produces `AsyncStream<TimestampedBuffer>`

**Key implementation details**:
- Reads PCM16 LE at 16kHz mono from stdin
- Constructs `AVAudioPCMBuffer` objects with correct `AVAudioFormat` and `frameLength`
- Computes timestamps from sample count (not wall clock) to avoid network latency skew
- Uses `SpeechAnalyzer` with `reportingOptions: [.volatileResults]` for interim results
- Outputs JSON lines to stdout: `{"type":"interim","text":"..."}` and `{"type":"final","text":"..."}`
- Serializes stdout writes to avoid concurrent output corruption
- Gracefully finishes `AsyncStream` on stdin EOF to flush remaining results

**Node.js side**:

```typescript
class SpeechRecognizer {
  private process: ChildProcess;

  start(): void {
    this.process = spawn('./swift/speech-recognizer/.build/release/speech-recognizer');

    // Read JSON lines from stdout
    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on('line', (line) => {
      const result = JSON.parse(line);
      // Emit to WebSocket client
    });
  }

  feedAudio(pcmBuffer: Buffer): void {
    if (!this.process.stdin.write(pcmBuffer)) {
      // Backpressure: stdin buffer full, drop frame
    }
  }

  stop(): void {
    this.process.stdin.end();
  }
}
```

**One recognizer per WebSocket connection**: Each connected client gets its own process. The process lifecycle matches the WebSocket connection.

### Phase 3: TTS Audio Streaming

Modify the TTS pipeline to stream audio chunks over WebSocket instead of writing WAV files to disk.

**Current flow**:
```
speak endpoint → say -o /tmp/file.wav → SSE tts-audio event → browser fetches WAV
```

**New flow**:
```
speak endpoint → say -o /tmp/file.wav → read WAV → strip header → send PCM chunks over WS
```

Or better, stream from `say` directly:

```
speak endpoint → say -o - (stdout) → pipe PCM chunks over WS in real-time
```

**Implementation**:
- When WebSocket client is connected, prefer WS delivery over SSE
- Send `tts-start` JSON message with audio metadata
- Stream PCM data as binary frames (e.g., 4096-byte chunks)
- Send `tts-end` JSON message when complete
- Keep SSE as fallback for non-WS clients

### Phase 4: Migrate SSE Events to WebSocket

Route all existing SSE event types through WebSocket when available:
- `speak` text events → `transcript-final` or keep as-is for display
- `tts-audio` → replaced by binary WS frames
- `tts-clear` → same message type over WS
- `session-reset` → same message type over WS
- `waitStatus` → `wait-status` over WS

**SSE remains as fallback** for clients that don't support or haven't upgraded to WS.

---

## Client-Side Changes

### Phase 1: AudioWorklet for Mic Capture

Replace Web Speech API with direct audio capture via AudioWorklet.

**New file**: `public/audio-capture-worklet.js`

```javascript
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    // sampleRate is the actual AudioContext rate (e.g., 48000 on iOS, not 16000)
    // Target: 20ms frames at 16kHz = 320 samples output
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // e.g., 48000/16000 = 3
    this.inputFrameSize = Math.round(320 * this.ratio); // samples to accumulate before downsampling
  }

  downsample(buffer, ratio) {
    // Simple linear interpolation downsampling
    const outputLength = Math.floor(buffer.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      output[i] = buffer[Math.round(i * ratio)];
    }
    return output;
  }

  process(inputs) {
    const input = inputs[0][0]; // mono channel
    if (!input) return true;

    // Accumulate samples at native rate
    const newBuffer = new Float32Array(this.buffer.length + input.length);
    newBuffer.set(this.buffer);
    newBuffer.set(input, this.buffer.length);
    this.buffer = newBuffer;

    // Send 20ms frames, downsampled to 16kHz
    while (this.buffer.length >= this.inputFrameSize) {
      const chunk = this.buffer.slice(0, this.inputFrameSize);
      const downsampled = this.ratio === 1 ? chunk : this.downsample(chunk, this.ratio);
      this.port.postMessage({ type: 'audio-frame', frame: downsampled });
      this.buffer = this.buffer.slice(this.inputFrameSize);
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
```

**In `public/app.js`**:

```javascript
async startAudioCapture() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true }
  });

  // Create AudioContext at native rate — worklet handles downsampling to 16kHz
  this.audioContext = new AudioContext();
  await this.audioContext.resume(); // User gesture required on iOS

  const source = this.audioContext.createMediaStreamSource(stream);
  await this.audioContext.audioWorklet.addModule('/audio-capture-worklet.js');

  const processor = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');
  processor.port.onmessage = (e) => {
    if (e.data.type === 'audio-frame') {
      // Convert Float32 to Int16 PCM
      const pcm16 = float32ToInt16(e.data.frame);
      this.ws.send(pcm16.buffer); // Send binary frame
    }
  };

  source.connect(processor);
  processor.connect(this.audioContext.destination); // Required for worklet to process
}
```

### Phase 2: VAD Integration

Add client-side Voice Activity Detection using `@ricky0123/vad-web` (Silero VAD v5).

**Approach**: Run VAD alongside the AudioWorklet to detect speech boundaries. Send `vad-speech-start` and `vad-speech-end` control messages to the server.

**Why client-side VAD**:
- Reduces unnecessary audio streaming during silence
- Provides clear utterance boundaries for the server
- Silero VAD v5 is ~2MB ONNX model with 87.7% accuracy at 5% FPR
- Runs efficiently in the browser via ONNX Runtime Web

**Integration with audio capture**:
- VAD runs on the same audio stream
- On speech start: send `vad-speech-start` message, begin/continue streaming audio
- On speech end: send `vad-speech-end` message
- Optionally: only stream audio during speech (saves bandwidth, but may clip starts)
- Recommended: always stream audio, use VAD events as hints for the server's utterance segmentation

**Alternative: Server-side VAD**
- Could also run VAD on the server to simplify the client
- But adds latency and the server is already running speech recognition
- speech-recognizer's SpeechTranscriber may handle utterance boundaries internally
- Decision: Start with client-side VAD for lower latency; can move to server if simpler

### Phase 3: AudioContext Buffer Playback

Replace browser `speechSynthesis` and WAV file fetching with AudioContext buffer playback.

**New file**: `public/audio-playback-worklet.js` (optional, can use AudioBufferSourceNode instead)

**Simpler approach using AudioBufferSourceNode**:

```javascript
class AudioPlayer {
  constructor() {
    this.playbackContext = new AudioContext({ sampleRate: 22050 });
    this.nextStartTime = 0;
    this.queue = [];
  }

  // Call on user gesture (e.g., "Start Listening" button)
  async unlock() {
    await this.playbackContext.resume();
    // Play silent buffer to warm up iOS audio pipeline
    const silence = this.playbackContext.createBuffer(1, 1, 22050);
    const source = this.playbackContext.createBufferSource();
    source.buffer = silence;
    source.connect(this.playbackContext.destination);
    source.start();
  }

  // Called when binary TTS frame arrives over WebSocket
  playPCMChunk(pcm16Buffer, sampleRate = 22050) {
    const float32 = int16ToFloat32(pcm16Buffer);
    const audioBuffer = this.playbackContext.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const source = this.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackContext.destination);

    const now = this.playbackContext.currentTime;
    const startTime = Math.max(now, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;
  }

  clear() {
    // Reset scheduled playback
    this.nextStartTime = 0;
    // Note: can't cancel already-scheduled AudioBufferSourceNodes easily
    // May need to disconnect and recreate the chain
  }
}
```

**iOS Safari compatibility**:
- AudioContext MUST be created/resumed on a user gesture → tie to "Start Listening" button tap
- Once mic capture is active (`getUserMedia`), AudioContext playback may work without additional gesture (WebKit active-capture exception)
- Play a silent buffer on unlock to warm up the audio pipeline
- AudioWorklet supported since iOS 14.5 / Safari 14.1

### Phase 4: WebSocket Client

Replace SSE connection with WebSocket.

```javascript
class AudioWebSocket {
  connect(sessionKey) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws/audio?session=${sessionKey}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary frame = TTS audio
        this.audioPlayer.playPCMChunk(new Int16Array(event.data));
      } else {
        // Text frame = JSON control message
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      }
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'transcript-interim':
        this.updateInterimText(msg.text);
        break;
      case 'transcript-final':
        this.addUserMessage(msg.text, msg.utteranceId);
        break;
      case 'tts-start':
        this.audioPlayer.prepareForPlayback(msg.sampleRate);
        break;
      case 'tts-end':
        this.ws.send(JSON.stringify({ type: 'tts-ack', audioId: msg.audioId }));
        break;
      case 'tts-clear':
        this.audioPlayer.clear();
        break;
      case 'wait-status':
        this.updateWaitIndicator(msg.isWaiting);
        break;
      case 'session-reset':
        this.handleSessionReset();
        break;
    }
  }
}
```

**Reconnection**: Implement exponential backoff reconnection (same as current SSE logic). On reconnect, re-send `audio-start` if mic was active.

---

## Voice Activity Detection Approach

### Recommended: Hybrid Client + Server

1. **Client-side (Silero VAD via @ricky0123/vad-web)**:
   - Detects speech onset/offset in the browser
   - Sends `vad-speech-start` / `vad-speech-end` control messages
   - Provides instant feedback for UI (show "listening..." indicator)
   - ~2MB ONNX model, loads once

2. **Server-side (speech-recognizer implicit)**:
   - SpeechTranscriber internally handles utterance boundaries via its finalized results
   - VAD events from client serve as hints but server makes final segmentation decisions
   - Server emits `transcript-final` when it determines an utterance is complete

### Fallback: Energy-based

If Silero VAD adds too much bundle size or complexity:
- Simple RMS energy threshold in the AudioWorklet
- Less accurate but zero additional dependencies
- Can be a Phase 1 approach, replaced by Silero in Phase 2

---

## Backward Compatibility / Migration Strategy

### SSE Fallback

- **Keep SSE endpoint** (`/api/tts-events`) functional alongside WebSocket
- Browser detects WebSocket support and prefers it
- Falls back to SSE + HTTP for older browsers or if WS connection fails
- Server checks: if WS client connected for session, route TTS through WS; else use SSE

### Web Speech API Fallback

- **Keep Web Speech API code** in the browser as a fallback
- If speech-recognizer is not available (not installed, not macOS), fall back to browser speech recognition
- Browser sends `audio-start` → server responds with `{ "type": "error", "message": "speech recognition unavailable, use browser fallback" }` → client activates Web Speech API
- User can also manually toggle between server and browser recognition in settings

### REST API Compatibility

- All existing REST endpoints remain functional
- `POST /api/potential-utterances` still works (for non-WS clients or typed input)
- `POST /api/speak` still works (server internally routes to WS or SSE)
- Hook endpoints unchanged

### Phased Rollout

1. **Phase 1**: Add WebSocket endpoint + AudioWorklet capture. Server receives audio but doesn't process it yet. Keep Web Speech API active.
2. **Phase 2**: Add speech-recognizer integration. Server does speech recognition. Client can toggle between server and browser recognition.
3. **Phase 3**: Add TTS audio streaming over WebSocket. Client can toggle between WS playback and existing SSE+fetch.
4. **Phase 4**: Add VAD. Polish. Make WS the default with automatic fallback.

---

## Implementation Phases

### Phase 1: WebSocket Infrastructure + Audio Capture (~2-3 sessions)

**Goal**: Browser captures mic audio and streams to server via WebSocket. Server receives and logs audio. No speech recognition yet.

**Server tasks**:
- [ ] `npm install ws @types/ws`
- [ ] Add WebSocket upgrade handler to HTTP server in `unified-server.ts`
- [ ] Handle `audio-start`, `audio-stop` control messages
- [ ] Receive binary audio frames and log receipt (byte count, frame count)
- [ ] Track WS clients alongside SSE clients
- [ ] Add WS client cleanup on disconnect

**Client tasks**:
- [ ] Create `public/audio-capture-worklet.js`
- [ ] Add AudioContext creation + `getUserMedia` in `app.js`
- [ ] Wire "Start Listening" button to start audio capture + open WebSocket
- [ ] Convert Float32 to Int16 PCM and send as binary frames
- [ ] Send `audio-start` / `audio-stop` control messages
- [ ] Unlock AudioContext on "Start Listening" tap (iOS requirement)

**Verification**:
- [ ] Open browser, click Start Listening, speak — server logs received audio frames
- [ ] Test on iOS Safari — verify AudioContext unlocks on tap
- [ ] Test reconnection — close/reopen browser, WS reconnects
- [ ] Existing Web Speech API still works in parallel

### Phase 2: Server-Side Speech Recognition (~3-4 sessions)

**Goal**: Server transcribes audio using speech-recognizer and sends transcripts back to browser.

**Swift binary tasks** (in `swift/speech-recognizer/`):
- [ ] Create Swift package with `Package.swift`
- [ ] Implement `StdinAudioSource` — reads PCM16 LE 16kHz mono from stdin, produces `AsyncStream<TimestampedBuffer>`
- [ ] Construct `AVAudioPCMBuffer` from raw bytes with correct format and frameLength
- [ ] Compute timestamps from cumulative sample count, not wall clock
- [ ] Wire `SpeechTranscriber` with `reportingOptions: [.volatileResults]`
- [ ] Output JSON lines to stdout: `{"type":"interim","text":"..."}` and `{"type":"final","text":"..."}`
- [ ] Handle stdin EOF gracefully — finish async stream, flush remaining results
- [ ] Test with piped audio: `cat audio.raw | .build/release/speech-recognizer`
- [ ] Add build script / Makefile for `swift build -c release`

**Server tasks**:
- [ ] Create `src/speech-recognition.ts` module
- [ ] Spawn `speech-recognizer` as child process
- [ ] Pipe incoming WebSocket binary frames to child process stdin
- [ ] Parse JSON lines from stdout → emit `transcript-interim` and `transcript-final` over WS
- [ ] On `transcript-final`: create utterance in queue (same as current `POST /api/potential-utterances`)
- [ ] Handle process lifecycle: start on first audio, restart on crash, stop on WS disconnect
- [ ] Add `--no-transcribe` server flag to disable (for environments without speech-recognizer binary)

**Client tasks**:
- [ ] Handle `transcript-interim` messages → display in interim text area
- [ ] Handle `transcript-final` messages → add to conversation as user message
- [ ] Add toggle in settings: "Server Recognition" vs "Browser Recognition"
- [ ] When server recognition active, don't start Web Speech API

**Verification**:
- [ ] Speak into mic → see interim transcripts updating in UI → see final transcript appear as message
- [ ] Verify utterance appears in Claude Code via hooks
- [ ] Test with various speech patterns: short utterances, long sentences, pauses
- [ ] Fallback: disable server recognition (or speech-recognizer not built) → Web Speech API still works

### Phase 3: TTS Audio Streaming (~2 sessions)

**Goal**: TTS audio streams from server to browser over WebSocket. Browser plays via AudioContext.

**Server tasks**:
- [ ] Modify `enqueueTts()` to optionally stream audio over WS instead of writing file
- [ ] After `say` renders WAV: read file, strip 44-byte WAV header, send PCM as binary frames
- [ ] Send `tts-start` before audio, `tts-end` after
- [ ] If WS client connected: use WS delivery. Else: fall back to SSE + file serving
- [ ] Alternatively: explore `say -o -` (stdout) for real-time streaming without temp file

**Client tasks**:
- [ ] Create `AudioPlayer` class with `playPCMChunk()` method
- [ ] On `tts-start`: prepare playback context with correct sample rate
- [ ] On binary frame during TTS: decode and schedule for playback
- [ ] On `tts-end`: send `tts-ack`
- [ ] On `tts-clear`: stop all scheduled playback
- [ ] Unlock playback AudioContext on "Start Listening" tap
- [ ] Play silent buffer to warm up iOS audio pipeline

**Verification**:
- [ ] Claude speaks → audio plays in browser via WebSocket
- [ ] Test on iOS Safari — verify audio plays without autoplay block
- [ ] Test rapid successive speaks — audio queues and plays in order
- [ ] Test `tts-clear` — audio stops immediately
- [ ] Fallback: close WS → SSE + WAV fetch still works

### Phase 4: VAD + Polish (~1-2 sessions)

**Goal**: Add voice activity detection, polish the experience, make WS the default.

**Tasks**:
- [ ] Integrate `@ricky0123/vad-web` for browser-side VAD
- [ ] Send `vad-speech-start` / `vad-speech-end` to server
- [ ] Server uses VAD events as hints for utterance segmentation
- [ ] Add visual indicator for VAD state (speaking vs silence)
- [ ] Make WebSocket the default connection method
- [ ] Auto-fallback to SSE if WS fails to connect
- [ ] Add reconnection with exponential backoff
- [ ] Performance tuning: jitter buffer (~40ms) for smooth playback
- [ ] Test on Chrome, Safari, iOS Safari, Firefox
- [ ] Update README with new architecture notes
- [ ] Clean up any deprecated SSE-only code paths

---

## New Dependencies

### Server
- `ws` — WebSocket server for Node.js
- `@types/ws` — TypeScript types (dev)

### Client (loaded from CDN or bundled)
- `@ricky0123/vad-web` — Silero VAD v5 for browser (Phase 4)
- `onnxruntime-web` — ONNX Runtime for Silero VAD (Phase 4, peer dep of vad-web)

### Internal (built from source)
- `swift/speech-recognizer/` — standalone Swift binary for stdin-to-transcript (macOS 26+, SpeechTranscriber API)

---

## Risks and Open Questions

### Risks

1. **Speech recognizer implementation**: Building the standalone Swift binary requires careful handling of `AVAudioPCMBuffer` construction, `AVAudioFormat`, and `frameLength`. Timestamps should be computed from sample count (not wall clock) since network latency would skew `mach_continuous_time()`. Relevant code can be adapted from speech-recognizer. Mitigation: Test early with a simple stdin prototype.

2. **macOS 26.0 requirement**: `SpeechTranscriber` and `SpeechAnalyzer` APIs are macOS 26+ only. Anyone on macOS 15 (Sequoia) or earlier cannot use server-side recognition. Mitigation: Maintain Web Speech API fallback; consider adding SFSpeechRecognizer (macOS 10.15+) or Whisper API as alternative backends later.

3. **iOS Safari AudioWorklet reliability**: Some users report AudioWorklet issues on specific iOS versions (notably iOS 16-18) where AudioWorklet nodes can silently stop processing. Mitigation: Include ScriptProcessorNode fallback; test on multiple iOS versions.

4. **AudioContext sample rate mismatch**: iOS Safari ignores the requested `sampleRate` and uses the hardware rate (typically 48kHz). **This is not a risk to mitigate — it is the expected behavior.** The AudioWorklet MUST capture at native rate and downsample to 16kHz before sending. The worklet's `frameSize` must be calculated based on the actual AudioContext sample rate, not a hardcoded 16kHz assumption. See "Resolved Decisions" below.

5. **Speech recognizer process management**: Spawning a process per WS connection could be resource-intensive. `SpeechAnalyzer` loads a neural model (1-3s startup). Mitigation: Keep process running across utterances; limit to one recognizer at a time (only active session). Consider a singleton process that multiplexes audio.

6. **Echo cancellation**: Browser's `echoCancellation` constraint is designed for WebRTC (canceling far-end audio), NOT for same-device playback. It will not reliably handle the browser playing TTS audio through speakers while capturing mic. **Muting mic audio streaming during TTS playback MUST be the default behavior, not optional.** See "Resolved Decisions" below.

7. **Latency budget**: Voice-to-transcript latency depends on speech-recognizer's processing speed (~190x real-time is fast, but startup time matters). Mitigation: Keep the process running; don't restart per utterance.

8. **`say` command does not support stdout streaming**: `say -o -` and `say -o /dev/stdout` do not work — they produce 0 or 32 bytes instead of full audio. The file-based approach (render WAV, strip header, stream PCM) is the only reliable path. Can be replaced later with a streaming TTS provider (ElevenLabs, OpenAI).

9. **No backpressure mechanism**: If speech-recognizer falls behind, binary audio frames accumulate. The stdin pipe has a kernel buffer (~64KB on macOS). If the pipe fills, `process.stdin.write()` returns false and Node.js buffers in memory. Mitigation: Monitor `write()` return value; drop frames if buffer exceeds threshold.

10. **Security**: The WebSocket endpoint has no authentication. Low risk on localhost, but HTTPS remote access (already a feature) would allow any LAN device to connect. Mitigation: Add a simple token/cookie check for remote connections.

11. **Trigger word mode**: With server-side recognition, the server produces `transcript-final` events that would need to be buffered until the trigger word is detected. This requires either: (a) moving trigger word logic to the server, or (b) having the client intercept `transcript-final` messages and hold them. **Design this before starting Phase 2** as it affects the transcript event flow architecture.

### Resolved Decisions (from Codex review)

1. **AudioWorklet sample rate**: Always capture at native AudioContext rate and downsample in the worklet. Do NOT create AudioContext with `sampleRate: 16000`. The worklet must detect the actual sample rate and adjust frame size accordingly.

2. **Echo suppression**: Mute mic audio streaming during TTS playback by default. Do not rely on browser echo cancellation.

3. **TTS binary frame format**: Use separate text JSON messages for `tts-start`/`tts-end` and plain binary frames for audio data (no audioId prefix in binary frames). Simpler than the mixed prefix approach and avoids client parsing mismatch.

4. **Phase order**: Consider doing Phase 3 (TTS streaming) before Phase 2 (speech recognition) — TTS streaming is simpler and directly solves the iOS autoplay issue, which is the more urgent problem.

5. **`say` stdout streaming**: Not viable. Use file-based rendering. Can swap to streaming TTS provider later.

6. **WebSocket keepalive**: Add ping/pong heartbeat to the protocol for mobile connection reliability.

### Open Questions

1. **Should we support two separate AudioContexts** (one at native rate for capture, one at 22050Hz for playback) or use a single context? Two contexts is cleaner but iOS Safari has a limit (4-6 contexts). Two should be safe.

2. **Should VAD control audio streaming** (only send during speech) or should we stream continuously and use VAD events as metadata? Continuous is simpler but uses more bandwidth; gated streaming saves bandwidth but risks clipping.

3. **How should speech-recognizer handle the audio format conversion?** The `makeAnalyzerInputStream` function already handles conversion via `AVAudioConverter`. Verify that `SpeechAnalyzer.bestAvailableAudioFormat()` is compatible with 16kHz PCM16 mono input, or let speech-recognizer handle the conversion internally.

4. **Should we use a single WebSocket for all purposes** (audio + control + session management) or have separate connections? Single is simpler for the client; separate allows independent lifecycle management.

5. **VAD CORS requirements**: `@ricky0123/vad-web` uses ONNX Runtime WASM which requires `SharedArrayBuffer`, which in turn requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers. This may conflict with the SSE endpoint. Test early in Phase 4.

---

## File Changes Summary

### New Files
- `src/speech-recognition.ts` — Swift-transcribe wrapper and process management
- `public/audio-capture-worklet.js` — AudioWorklet processor for mic capture
- `public/audio-playback.js` — AudioContext-based TTS playback (or inline in app.js)

### Modified Files
- `src/unified-server.ts` — Add WebSocket server, route TTS through WS, integrate speech recognition
- `public/app.js` — Add AudioWorklet capture, WS client, AudioContext playback, VAD
- `public/index.html` — Add VAD library script tag (Phase 4)
- `package.json` — Add `ws` dependency

### New Swift Package
- `swift/speech-recognizer/Package.swift` — Swift package manifest
- `swift/speech-recognizer/Sources/SpeechRecognizer/main.swift` — Entry point, stdin reading, JSON output
- `swift/speech-recognizer/Sources/SpeechRecognizer/StdinAudioSource.swift` — PCM stdin to AsyncStream adapter
