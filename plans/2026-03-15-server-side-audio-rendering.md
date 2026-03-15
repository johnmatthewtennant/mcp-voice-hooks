# Server-Side Audio Rendering — Implementation Plan

## Overview

Move ALL audio rendering to the server side. Currently, TTS voice output is rendered server-side (macOS `say` command to WAV, streamed as PCM over WebSocket), but the chime and heartbeat pulse sounds are generated browser-side using Web Audio API (`VoiceStateMachine` class in `public/app.js`). This plan unifies everything so all audio goes through the same server-side render-and-stream pipeline.

## Session Reference

Generated during a Claude Code session on 2026-03-15 in the mcp-voice-hooks repo, branch `feature/ws-speech-recognizer`.

## Current State Analysis

### Server-Side TTS Pipeline (already working)

The server has a complete render-and-stream pipeline for TTS:

1. **`renderTtsToFile(text, rate)`** (`src/unified-server.ts:211-229`): Renders text to WAV using `say -o` with format `LEI16@22050` (16-bit PCM, mono, 22050 Hz).
2. **`enqueueTts(text, rate, sessionKey)`** (`src/unified-server.ts:70-75`): Queues TTS renders. Queue is serialized (one render at a time) to prevent CPU overload.
3. **`processTtsQueue()`** (`src/unified-server.ts:47-68`): Dequeues items, renders to WAV, streams over WebSocket.
4. **`streamTtsOverWs(client, filePath, audioId)`** (`src/unified-server.ts:1244-1281`): Reads WAV file, finds the data chunk (skipping macOS `say` padding), sends `tts-start` message, streams PCM chunks, sends `tts-end` message.
5. **`findWavDataOffset(buf)`** (`src/unified-server.ts:1230-1242`): Handles macOS `say`'s non-standard WAV headers (JUNK/FLLR padding chunks).
6. **`clearTtsQueue()`** (`src/unified-server.ts:77-92`): Kills in-flight renders, rejects pending items, sends `tts-clear` to browser.

### Browser-Side Audio (to be replaced)

The `VoiceStateMachine` class (`public/app.js:96-427`) generates all non-TTS audio in the browser:

1. **Transition chime** (`_playChime`, line 373): Two-note ascending sine waves (880Hz + 1100Hz), 200ms total. Plays when entering `listening` state.
2. **Listening pulse** (`_playListeningPulse`, line 253): Soft sine at 220Hz + harmonic at 440Hz, 350ms. Repeats every 7 seconds.
3. **Processing pulse** (`_playProcessingPulse`, line 306): Low sine at 90Hz, 200ms. Repeats every 5 seconds.
4. **State machine** (`syncState`, line 125): Derives state from `(isListening, waitStatusKnown, lastWaitStatus, ttsActive)`. States: `inactive`, `listening`, `processing`, `speaking`.
5. **Chime delay logic** (`_playChimeWhenReady`, line 352): Waits for TTS audio to finish before playing chime (polls `audioPlayer.isPlaying()` every 100ms, max 15s).

### Browser AudioPlayer (stays as-is)

`AudioPlayer` class (`public/app.js:1-94`): Plays PCM16 audio chunks via `AudioContext` at 22050Hz. Handles `tts-start`, binary PCM chunks, `tts-end` messages. This class is the single audio output path and will receive ALL audio (TTS, chimes, pulses) after this change.

### State Signal Flow

The server already broadcasts state changes that drive the browser state machine:

| Signal | Server source | Browser handler |
|--------|--------------|-----------------|
| `waitStatus(true)` | `notifyWaitStatus(true)` at line 492 (wait starts) | `voiceState.setWaitStatus(true)` |
| `waitStatus(false)` | `notifyWaitStatus(false)` at lines 499, 524, 553 (wait ends) | `voiceState.setWaitStatus(false)` |
| `tts-start` | `streamTtsOverWs()` at line 1248 | `voiceState.setTtsActive(true)` |
| `tts-end` | `streamTtsOverWs()` at line 1271 | `voiceState.setTtsActive(false)` |
| `tts-clear` | `notifyTTSClear()` at line 982 | `voiceState.setTtsActive(false)` |

### Available Sound Generation Tools

- **`ffmpeg`** is installed at `/opt/homebrew/bin/ffmpeg` -- can generate tones with `sine` lavfi filter and convert system sounds
- **`say -o`** renders speech to WAV -- already used for TTS
- **macOS system sounds** at `/System/Library/Sounds/` (Tink.aiff, Glass.aiff, Ping.aiff, etc.) -- can be converted to matching WAV format
- **`sox`** is NOT installed
- **Target format**: WAV, PCM 16-bit signed LE, mono, 22050 Hz (matches TTS pipeline)

### Key Discoveries

- **ffmpeg can generate matching WAV**: `ffmpeg -f lavfi -i "sine=frequency=880:duration=0.15" -ar 22050 -ac 1 -sample_fmt s16 -f wav out.wav` produces files identical in format to `say -o` output (~7KB for 150ms tone).
- **ffmpeg can convert system sounds**: `ffmpeg -i /System/Library/Sounds/Tink.aiff -ar 22050 -ac 1 -sample_fmt s16 -f wav out.wav` works (25KB for 560ms sound).
- **The existing `streamTtsOverWs()` function works with any WAV file** -- not just `say` output. It reads the file, finds the data chunk, and streams PCM. So we can stream pre-rendered chime/pulse WAV files through the exact same path.
- **The `AudioPlayer` class doesn't care what the PCM represents** -- it just schedules Float32 samples for playback. TTS, chimes, and pulses will all sound correct.
- **Echo suppression (`_muteAudioCapture`)** mutes the mic during any TTS playback. Sound effects must NOT trigger echo suppression -- they're too short and would cause annoying mic flicker. The solution is to add a `kind` field to `tts-start` messages (`'tts'` vs `'sfx'`) so the browser can skip mic muting for sound effects.
- **The TTS queue is serialized** -- only one `say -o` process runs at a time. Chime/pulse WAV files should be pre-rendered at startup (not generated on-demand) so they don't block TTS renders.
- **Stream interleaving risk**: Since sound effects bypass the TTS queue and `streamTtsOverWs()` is async, two streams could overlap on the same WebSocket (e.g., a pulse fires while TTS is mid-stream). A per-client output mutex is needed to prevent interleaved binary frames.

## Desired End State

1. **Server renders all audio** -- TTS (via `say -o`), chime, and heartbeat pulses (via `ffmpeg` at startup or embedded PCM buffers) -- and streams PCM chunks over WebSocket.
2. **Browser plays whatever PCM arrives** via the existing `AudioPlayer` class. No Web Audio API oscillators for sounds.
3. **Browser `VoiceStateMachine` retains its state logic** (syncState, signal setters, state derivation) for **visual UI only** (waiting indicator text, mic button color, status display) but generates **no audio**.
4. **Server has its own state tracking** that mirrors the browser state machine, driven by the same signals it already emits (waitStatus, tts-start/end/clear). The server decides when to play chime/pulse sounds.
5. **Pre-rendered WAV files** for chime and pulses are generated once at server startup using `ffmpeg`, stored in a per-process temp directory created with `fs.mkdtemp()` (not a shared path).
6. **Heartbeat pulses are periodic short sounds** (every 5-10 seconds), not continuous tones. Two distinct sounds: one for listening (higher pitch), one for processing (lower pitch).
7. **The chime plays on transition to listening state**, after TTS finishes.

### Verification

- Start voice mode -> silence (no waitStatus yet)
- Server sends waitStatus(true) -> hear chime then periodic listening pulses (every 7s)
- Speak to Claude -> pulses change to processing rhythm (every 5s, lower pitch)
- Claude speaks back -> pulses stop, TTS plays cleanly
- TTS finishes, Claude waits -> chime + listening pulses resume
- Stop voice mode -> all sound stops immediately
- All audio plays through the same AudioPlayer as TTS (same volume, same echo suppression)

## What We're NOT Doing

- **Minimal changes to `AudioPlayer`** -- only adding `kind` field awareness to skip echo suppression for sound effects
- **No changes to TTS rendering** -- `say -o` pipeline stays the same
- **No changes to visual UI** -- `VoiceStateMachine` keeps managing waiting indicator, mic button state, etc.
- **No user-facing sound settings** (volume, enable/disable, sound selection) in this phase
- **No changes to echo suppression logic** -- it naturally applies to all audio through `AudioPlayer`
- **No continuous ambient tones** -- just periodic short pulses (same as current browser implementation)
- **Minimal WebSocket protocol changes** -- only adding a `kind` field to `tts-start`/`tts-end` messages to distinguish TTS from sound effects

## Implementation Approach

### Strategy: Pre-render + Server State Machine + Queue Bypass

1. **Pre-render sounds at startup** using `ffmpeg` to create WAV files matching the TTS format (22050Hz, 16-bit PCM, mono). These are tiny files (5-25KB) and render in <100ms.
2. **Add a `ServerAudioState` tracker** on the server that mirrors the browser state machine logic (same derived-state reducer). It's driven by the same signals the server already emits: `notifyWaitStatus()`, TTS start/end events.
3. **Stream pre-rendered sounds directly** via `streamTtsOverWs()` -- bypassing the TTS queue since these are instant (no rendering delay). A per-client output mutex prevents interleaved binary frames when TTS and sound effects fire close together.
4. **Add `kind` field to WebSocket messages** (`'tts'` or `'sfx'`) so the browser can distinguish TTS from sound effects and skip echo suppression (mic muting) for sound effects.
5. **Remove audio generation from browser `VoiceStateMachine`** -- delete `_playChime`, `_playListeningPulse`, `_playProcessingPulse`, `_startListeningAmbient`, `_startProcessingAmbient`, `_stopAmbient`, `_ensureContext`, `unlock()`, and all AudioContext management. Keep signal setters and `syncState()` for visual state.

### Why bypass the TTS queue for sounds?

The TTS queue serializes `say -o` renders to prevent CPU overload. But pre-rendered WAV files don't need rendering -- they're just file reads. If we put chimes in the TTS queue, a queued TTS render could block the chime for seconds. Instead, we stream pre-rendered files directly. A per-client output mutex ensures only one stream writes binary frames at a time, preventing interleaving corruption while still allowing sounds to play promptly after TTS finishes.

### Why a per-client output mutex?

`streamTtsOverWs()` is async and writes binary frames in a loop. If a pulse timer fires while TTS is mid-stream, both could write to the same WebSocket concurrently, interleaving PCM chunks from different audio. The mutex serializes writes per-client: the pulse waits for the current TTS chunk batch to finish before sending its own frames. Since sound effects are tiny (~7KB), the wait is negligible.

### Why not use macOS system sounds?

While `/System/Library/Sounds/Tink.aiff` etc. exist, generating tones with `ffmpeg` gives us precise control over frequency, duration, and envelope -- and produces smaller files. System sounds are also tied to macOS and wouldn't work if we ever support other platforms.

---

## Phase 1: Pre-render Sound Files at Startup

### Overview

Generate WAV files for chime, listening pulse, and processing pulse at server startup using `ffmpeg`. Store them in a temp directory. These files are small (~5-25KB each) and render in <100ms.

### Changes Required

#### 1. Sound generation module

**File**: `src/unified-server.ts`
**Location**: After the TTS rendering functions (after line 229)

Add a `SoundLibrary` that pre-renders three sounds at startup:

```typescript
import os from 'os';

// Pre-rendered sound effects — generated at startup, streamed on demand
interface SoundLibrary {
  chime: string | null;           // path to chime WAV
  listeningPulse: string | null;  // path to listening pulse WAV
  processingPulse: string | null; // path to processing pulse WAV
}

const sounds: SoundLibrary = {
  chime: null,
  listeningPulse: null,
  processingPulse: null,
};

let soundsDir: string | null = null;

// Resolve ffmpeg binary — check explicit paths for non-interactive shells
function findFfmpeg(): string {
  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
  for (const candidate of candidates) {
    try {
      require('child_process').execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error('ffmpeg not found');
}

async function generateSounds(): Promise<void> {
  const ffmpegPath = findFfmpeg();

  // Create per-process temp directory (not shared, avoids symlink/tampering risks)
  soundsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-voice-hooks-sounds-'));
  // Restrict permissions to owner only
  await fs.promises.chmod(soundsDir, 0o700);

  // All sounds: 22050Hz, mono, 16-bit PCM WAV (matches TTS pipeline)
  const ffmpegBase = ['-ar', '22050', '-ac', '1', '-sample_fmt', 's16', '-f', 'wav', '-y'];

  // Chime: two-note ascending (880Hz 100ms + 1100Hz 100ms)
  const chimePath = path.join(soundsDir, 'chime.wav');
  await renderFfmpeg(ffmpegPath, [
    '-f', 'lavfi', '-i',
    'sine=frequency=880:duration=0.1,afade=t=out:st=0.05:d=0.05[a];sine=frequency=1100:duration=0.1,adelay=100|100,afade=t=out:st=0.05:d=0.05[b];[a][b]amix=inputs=2:duration=longest',
    ...ffmpegBase, chimePath,
  ]);
  sounds.chime = chimePath;

  // Listening pulse: soft warm tone at 220Hz + 440Hz harmonic, 350ms with fade
  const listeningPath = path.join(soundsDir, 'listening-pulse.wav');
  await renderFfmpeg(ffmpegPath, [
    '-f', 'lavfi', '-i',
    'sine=frequency=220:duration=0.35,afade=t=in:d=0.04,afade=t=out:st=0.1:d=0.25[a];sine=frequency=440:duration=0.3,volume=0.3,afade=t=in:d=0.04,afade=t=out:st=0.08:d=0.22[b];[a][b]amix=inputs=2:duration=longest',
    ...ffmpegBase, listeningPath,
  ]);
  sounds.listeningPulse = listeningPath;

  // Processing pulse: low thump at 90Hz, 200ms with quick attack
  const processingPath = path.join(soundsDir, 'processing-pulse.wav');
  await renderFfmpeg(ffmpegPath, [
    '-f', 'lavfi', '-i',
    'sine=frequency=90:duration=0.2,afade=t=in:d=0.03,afade=t=out:st=0.05:d=0.15',
    ...ffmpegBase, processingPath,
  ]);
  sounds.processingPulse = processingPath;

  debugLog(`[Sounds] Pre-rendered chime, listening pulse, processing pulse to ${soundsDir}`);
}

function renderFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Cleanup sounds directory on shutdown
function cleanupSounds(): void {
  if (soundsDir) {
    fs.rmSync(soundsDir, { recursive: true, force: true });
    soundsDir = null;
  }
}
// Register cleanup on process exit
process.on('exit', cleanupSounds);
process.on('SIGINT', () => { cleanupSounds(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSounds(); process.exit(0); });
```

#### 2. Call `generateSounds()` at startup

**File**: `src/unified-server.ts`
**Location**: In the server startup section (where `httpServer.listen()` is called)

Add `await generateSounds()` early in the startup sequence, before the server starts listening. If `ffmpeg` is not available, log a warning and continue (sounds will be `null`, and the server will skip playing them).

Wrap in try/catch:
```typescript
try {
  await generateSounds();
} catch (e) {
  console.warn('[Sounds] Failed to pre-render sounds (ffmpeg may not be installed):', e);
}
```

### Success Criteria

- [ ] Three WAV files are created in a per-process temp directory at startup
- [ ] Temp directory has 0700 permissions (owner-only access)
- [ ] Files are 22050Hz, 16-bit PCM, mono WAV format (verified with `file` command)
- [ ] `ffmpeg` failure doesn't crash the server (graceful degradation, no sounds but no crash)
- [ ] `ffmpeg` is resolved from explicit paths (works in non-interactive shells)
- [ ] Server starts normally: `npm run build && node dist/unified-server.js --debug`
- [ ] Files are small (<30KB each)
- [ ] Sounds directory is cleaned up on process exit (SIGINT, SIGTERM)

---

## Phase 2: Server-Side Audio State Machine

### Overview

Add a `ServerAudioState` class that tracks the same state as the browser `VoiceStateMachine` but runs on the server. It uses the same derived-state reducer logic. When it transitions states, it streams pre-rendered sounds over WebSocket.

### Changes Required

#### 1. `ServerAudioState` class

**File**: `src/unified-server.ts`
**Location**: After the sound generation code

```typescript
// Server-side audio state machine — mirrors browser VoiceStateMachine logic
// but plays sounds by streaming pre-rendered WAV files over WebSocket
class ServerAudioState {
  static _sfxCounter = 0; // monotonic counter for unique SFX audioIds (avoids same-ms collisions)
  state: 'inactive' | 'listening' | 'processing' | 'speaking' = 'inactive';
  private _isListening = false;
  private _waitStatusKnown = false;
  private _lastWaitStatus = false;
  private _ttsActive = false;
  private _pulseTimer: ReturnType<typeof setInterval> | null = null;
  private _chimeDelayTimer: ReturnType<typeof setTimeout> | null = null;

  syncState(): void {
    let desired: typeof this.state;
    if (!this._isListening) {
      desired = 'inactive';
    } else if (this._ttsActive) {
      desired = 'speaking';
    } else if (!this._waitStatusKnown) {
      desired = 'inactive';
    } else if (this._lastWaitStatus) {
      desired = 'listening';
    } else {
      desired = 'processing';
    }
    if (desired !== this.state) {
      this._transition(desired);
    }
  }

  setListening(isListening: boolean): void {
    this._isListening = isListening;
    if (isListening) {
      this._lastWaitStatus = false;
      this._waitStatusKnown = false;
      this._ttsActive = false;
    }
    this.syncState();
  }

  setWaitStatus(isWaiting: boolean): void {
    this._waitStatusKnown = true;
    this._lastWaitStatus = isWaiting;
    this.syncState();
  }

  setTtsActive(active: boolean): void {
    this._ttsActive = active;
    this.syncState();
  }

  private _transition(newState: typeof this.state): void {
    const oldState = this.state;
    this.state = newState;
    this._stopPulseTimer();
    this._cancelChimeDelay();

    debugLog(`[ServerAudio] ${oldState} -> ${newState}`);

    switch (newState) {
      case 'inactive':
        break;

      case 'listening':
        // Delay chime to let TTS finish draining from AudioPlayer
        this._scheduleChimeThenPulses();
        break;

      case 'processing':
        this._startPulseTimer('processing');
        break;

      case 'speaking':
        // No sounds during TTS
        break;
    }
  }

  private _scheduleChimeThenPulses(): void {
    // Wait 600ms for any final TTS chunks to drain, then play chime
    this._chimeDelayTimer = setTimeout(() => {
      this._chimeDelayTimer = null;
      if (this.state !== 'listening') return;
      this._streamSound('chime');
      // Start listening pulses after chime (chime is ~200ms)
      setTimeout(() => {
        if (this.state === 'listening') {
          this._startPulseTimer('listening');
        }
      }, 300);
    }, 600);
  }

  private _startPulseTimer(type: 'listening' | 'processing'): void {
    const interval = type === 'listening' ? 7000 : 5000;
    const soundKey = type === 'listening' ? 'listeningPulse' : 'processingPulse';

    // Play first pulse immediately
    this._streamSound(soundKey);

    this._pulseTimer = setInterval(() => {
      if (this.state !== type) {
        this._stopPulseTimer();
        return;
      }
      this._streamSound(soundKey);
    }, interval);
  }

  private _stopPulseTimer(): void {
    if (this._pulseTimer !== null) {
      clearInterval(this._pulseTimer);
      this._pulseTimer = null;
    }
  }

  private _cancelChimeDelay(): void {
    if (this._chimeDelayTimer !== null) {
      clearTimeout(this._chimeDelayTimer);
      this._chimeDelayTimer = null;
    }
  }

  private _streamSound(soundKey: keyof SoundLibrary): void {
    const filePath = sounds[soundKey];
    if (!filePath) return;

    // Find a connected WS client to stream to
    const targetKey = activeCompositeKey;
    const wsClient = findWsClientForSession(targetKey);
    if (!wsClient || wsClient.ws.readyState !== WebSocket.OPEN) return;

    // Stream the pre-rendered WAV — reuse the existing TTS streaming function
    // Use a unique audioId so AudioPlayer can track it
    const audioId = `sfx-${soundKey}-${ServerAudioState._sfxCounter++}`;
    streamTtsOverWs(wsClient, filePath, audioId, 'sfx').catch(err => {
      debugLog(`[ServerAudio] Failed to stream ${soundKey}: ${err}`);
    });
  }

  destroy(): void {
    this._stopPulseTimer();
    this._cancelChimeDelay();
    this.state = 'inactive';
  }
}

const serverAudioState = new ServerAudioState();
```

#### 2. Per-client output mutex

**File**: `src/unified-server.ts`
**Location**: Add to `WsAudioClient` interface and `streamTtsOverWs()`

Since sound effects bypass the TTS queue, two concurrent `streamTtsOverWs()` calls could interleave binary frames on the same WebSocket. Add a simple mutex (promise chain) per client:

```typescript
// Add to WsAudioClient interface:
interface WsAudioClient {
  // ... existing fields ...
  streamMutex: Promise<void>;  // serializes outbound audio streams
}

// Initialize in WS connection handler:
const client: WsAudioClient = {
  // ... existing fields ...
  streamMutex: Promise.resolve(),
};

// Wrap streamTtsOverWs to acquire mutex:
// Design: uses acquire/release pattern. The body runs from both fulfillment
// and rejection paths of the prior chain entry, so a poisoned chain can't
// prevent future streams from running. Errors propagate to callers.
async function streamTtsOverWs(client: WsAudioClient, filePath: string, audioId: string, kind: 'tts' | 'sfx' = 'tts'): Promise<void> {
  let streamError: Error | null = null;
  let releaseResolve: () => void;
  const released = new Promise<void>(r => { releaseResolve = r; });

  // Run body from BOTH fulfillment and rejection of prior entry —
  // this ensures the chain stays healthy even if a prior entry rejected.
  const runBody = async () => {
    try {
      await _streamTtsOverWsInner(client, filePath, audioId, kind);
    } catch (e) {
      streamError = e instanceof Error ? e : new Error(String(e));
    } finally {
      releaseResolve!(); // always release so next stream can proceed
    }
  };

  // Chain: run body regardless of prior outcome
  client.streamMutex = client.streamMutex.then(runBody, runBody);

  await released;
  if (streamError) throw streamError;
}

// Inner function (existing streamTtsOverWs logic):
async function _streamTtsOverWsInner(client: WsAudioClient, filePath: string, audioId: string, kind: 'tts' | 'sfx'): Promise<void> {
  const { ws } = client;

  // Send tts-start with kind field
  ws.send(JSON.stringify({
    type: 'tts-start',
    audioId,
    sampleRate: 22050,
    channels: 1,
    kind,  // 'tts' or 'sfx' — browser uses this to decide echo suppression
  }));

  // Track per-client WS state (used for existing WS connection management).
  // NOTE: This is client.ttsActive (per-WS-client tracking), NOT
  // serverAudioState.setTtsActive() (server state machine).
  // serverAudioState.setTtsActive() is managed ONLY in processTtsQueue().
  if (kind === 'tts') {
    client.ttsActive = true;
    client.currentAudioId = audioId;
  }

  // Read WAV, find data chunk, stream PCM chunks (existing logic)
  const fileData = await fs.promises.readFile(filePath);
  const dataOffset = findWavDataOffset(fileData);
  const pcmData = fileData.subarray(dataOffset);

  for (let offset = 0; offset < pcmData.length; offset += TTS_WS_CHUNK_SIZE) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const chunk = pcmData.subarray(offset, Math.min(offset + TTS_WS_CHUNK_SIZE, pcmData.length));
    ws.send(chunk);
  }

  // Send tts-end with kind field
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tts-end', audioId, kind }));
  }

  if (kind === 'tts') {
    client.ttsActive = false;
    client.currentAudioId = null;
  }
}
```

#### 3. Wire `ServerAudioState` into existing signal points

**File**: `src/unified-server.ts`

**At `notifyWaitStatus()` (line 1006)**: After broadcasting SSE, also update server audio state:
```typescript
function notifyWaitStatus(isWaiting: boolean) {
  const message = JSON.stringify({ type: 'waitStatus', isWaiting, sessionKey: activeCompositeKey });
  ttsClients.forEach((viewingKey, client) => {
    if (viewingKey === null || viewingKey === activeCompositeKey) {
      client.write(`data: ${message}\n\n`);
    }
  });
  // Drive server-side audio state
  serverAudioState.setWaitStatus(isWaiting);
}
```

**At TTS queue processing** (SOLE location for `serverAudioState.setTtsActive`): In `processTtsQueue()`, call `serverAudioState.setTtsActive(true)` before calling `streamTtsOverWs()` and `serverAudioState.setTtsActive(false)` after it completes. `serverAudioState.setTtsActive()` is NEVER called inside `streamTtsOverWs()` or `_streamTtsOverWsInner()` -- only here:

```typescript
async function processTtsQueue() {
  if (ttsPlaying || ttsQueue.length === 0) return;
  ttsPlaying = true;
  const item = ttsQueue.shift()!;
  try {
    const { audioId, filePath } = await renderTtsToFile(item.text, item.rate);
    const targetKey = item.sessionKey || activeCompositeKey;
    const wsClient = findWsClientForSession(targetKey);
    if (wsClient && wsClient.ws.readyState === WebSocket.OPEN) {
      serverAudioState.setTtsActive(true);
      await streamTtsOverWs(wsClient, filePath, audioId, 'tts');
      serverAudioState.setTtsActive(false);
    }
    item.resolve(audioId);
  } catch (error) {
    serverAudioState.setTtsActive(false);
    item.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    ttsPlaying = false;
    processTtsQueue();
  }
}
```

**Centralize voice-active transitions**: Create a single `setVoiceActive()` function that updates both `voicePreferences.voiceActive` and `serverAudioState`. Use it everywhere instead of setting `voicePreferences.voiceActive` directly:

```typescript
function setVoiceActive(active: boolean): void {
  voicePreferences.voiceActive = active;
  serverAudioState.setListening(active);
  debugLog(`[VoiceActive] ${active ? 'activated' : 'deactivated'}`);
}
```

Wire this into ALL places that currently set `voicePreferences.voiceActive`:
- `POST /api/voice-active` handler (line ~1307) -- explicit user toggle
- SSE `allClientsDisconnected` handler -- all browser tabs closed, voice mode should deactivate
- Session reset paths that currently set `voiceActive = false`
- Any other place `voicePreferences.voiceActive = false` appears

Search for all occurrences: `grep -n 'voiceActive' src/unified-server.ts` and replace direct assignments with `setVoiceActive()`.

**Disconnect policy**: WS audio disconnect does NOT deactivate voice mode. The WS connection is just an audio transport -- it reconnects automatically. Voice mode is controlled by the explicit `POST /api/voice-active` toggle and the SSE `allClientsDisconnected` event (which means all browser tabs are closed). This means `ServerAudioState` timers continue running across WS reconnects, but `_streamSound()` silently skips when no WS client is available (the `findWsClientForSession` guard). When the WS reconnects, the next timer tick resumes audio delivery.

#### 4. Update `_streamSound()` to pass `kind: 'sfx'`

In the `ServerAudioState._streamSound()` method:
```typescript
streamTtsOverWs(wsClient, filePath, audioId, 'sfx')
```

#### 5. Handle `kind` field in browser AudioPlayer

**File**: `public/app.js`
**Location**: In the WebSocket message handler (`handleWsMessage`)

When processing `tts-start` messages, check the `kind` field:
```javascript
case 'tts-start': {
  const isSfx = parsed.kind === 'sfx';
  this.audioPlayer.prepareForPlayback(parsed.sampleRate, parsed.audioId);
  if (!isSfx) {
    this.voiceState.setTtsActive(true);
    this._muteAudioCapture(true);  // Only mute mic for real TTS
  }
  break;
}
```

When processing `tts-end` messages:
```javascript
case 'tts-end': {
  const isSfx = parsed.kind === 'sfx';
  this.audioPlayer.finishPlayback();
  if (!isSfx) {
    this.voiceState.setTtsActive(false);
    this._muteAudioCapture(false);  // Only unmute for real TTS
  }
  break;
}
```

This ensures:
- Sound effects play through AudioPlayer normally (same volume, scheduling)
- Sound effects do NOT trigger echo suppression (no mic muting for 200ms pulses)
- Sound effects do NOT flip the browser VoiceStateMachine to `speaking` state
- TTS behavior is completely unchanged

### Success Criteria

- [ ] `ServerAudioState` transitions correctly when `notifyWaitStatus()` is called
- [ ] Chime WAV streams over WebSocket when entering `listening` state
- [ ] Listening pulses stream every 7s while in `listening` state
- [ ] Processing pulses stream every 5s while in `processing` state
- [ ] No pulses during `speaking` or `inactive` states
- [ ] Sound effects don't interfere with TTS queue (they bypass it)
- [ ] Per-client output mutex prevents interleaved binary frames
- [ ] `serverAudioState.setTtsActive()` is called ONLY from `processTtsQueue()` -- never from `streamTtsOverWs` or `_streamTtsOverWsInner`
- [ ] `client.ttsActive` (per-WS-client field) is set inside `_streamTtsOverWsInner` only for `kind === 'tts'` (this is separate from `serverAudioState`)
- [ ] Sound effects use `kind: 'sfx'` in tts-start/tts-end messages
- [ ] Browser skips echo suppression (mic muting) for `kind: 'sfx'` messages
- [ ] Browser does NOT set `voiceState.ttsActive` for sound effects
- [ ] `voicePreferences.voiceActive` is ONLY set through `setVoiceActive()` (centralized)
- [ ] All voice deactivation paths use `setVoiceActive(false)` (explicit toggle, SSE allClientsDisconnected, session reset)
- [ ] WS audio disconnect does NOT call `setVoiceActive(false)` (WS is just audio transport, reconnects automatically)
- [ ] Build succeeds: `npm run build`
- [ ] Tests pass: `npm test`

---

## Phase 3: Remove Browser-Side Audio Generation

### Overview

Strip all audio generation code from the browser `VoiceStateMachine`. Keep the state derivation logic (syncState, signal setters) because it still drives visual UI elements (waiting indicator, mic button color). Remove AudioContext management, oscillator code, chime/pulse generators.

### Changes Required

#### 1. Gut audio from `VoiceStateMachine`

**File**: `public/app.js`

**Remove these methods entirely:**
- `unlock()` (lines 171-183) — AudioContext no longer needed
- `_ensureContext()` (lines 186-197) — AudioContext no longer needed
- `_startListeningAmbient()` (lines 246-251)
- `_playListeningPulse()` (lines 253-297)
- `_startProcessingAmbient()` (lines 299-303)
- `_playProcessingPulse()` (lines 306-333)
- `_stopAmbient()` (lines 335-340)
- `_playChimeWhenReady()` (lines 352-371)
- `_playChime()` (lines 373-412)
- `_cancelChimeTimer()` (lines 344-350)

**Remove these constructor properties:**
- `this.audioCtx` (line 107)
- `this.masterGain` (line 108)
- `this.ambientNodes` (line 109)
- `this._chimePending` (line 110)
- `this._chimeTimerId` (line 111)
- `this._pulseTimerId` (line 112)

**Remove `static MAX_VOLUME`** (line 102).

**Remove `audioPlayer` parameter from constructor** (line 104) and `this.audioPlayer` (line 105).

**Simplify `_transition()`** to only handle visual state — no audio:
```javascript
_transition(newState) {
    if (newState === this.state) return;
    this.state = newState;
    // Audio is now handled server-side; this method only drives visual UI
}
```

**Simplify `destroy()`:**
```javascript
destroy() {
    this.state = 'inactive';
}
```

#### 2. Update `VoiceStateMachine` instantiation

**File**: `public/app.js`
**Location**: In `MessengerClient` constructor (around where `this.voiceState = new VoiceStateMachine(this.audioPlayer)` is)

Change to:
```javascript
this.voiceState = new VoiceStateMachine();
```

#### 3. Remove `voiceState.unlock()` call

**File**: `public/app.js`
**Location**: In `startVoiceDictation()` method

Remove the `await this.voiceState.unlock()` line. The `audioPlayer.unlock()` call stays (it's for TTS playback).

#### 4. Remove `beforeunload` listener for voiceState

If there's a `window.addEventListener('beforeunload', () => { this.voiceState.destroy(); })`, keep it -- `destroy()` is now a no-op but harmless.

### Success Criteria

- [ ] `VoiceStateMachine` has no AudioContext, no oscillators, no gain nodes
- [ ] `VoiceStateMachine` still tracks state correctly (syncState works)
- [ ] Visual UI (waiting indicator, mic button) still works correctly
- [ ] No JavaScript errors in browser console
- [ ] `npm run build` succeeds (no TS changes in app.js, but verify no regressions)
- [ ] `npm test` passes

---

## Phase 4: Integration Testing and Volume Tuning

### Overview

Test the end-to-end flow and tune sound volumes. Since sounds now go through the same `AudioPlayer` as TTS, volume matching is critical.

### Changes Required

#### 1. Volume calibration for sound effects

The `AudioPlayer` plays PCM samples at full scale (Int16 range -32768 to 32767). The `ffmpeg`-generated tones will be at full scale by default. TTS from `say -o` is typically quieter. We need to adjust the ffmpeg volume so sounds are audible but not jarring relative to TTS.

In the `generateSounds()` ffmpeg commands, add volume filters:
- Chime: `volume=0.3` (30% of full scale, since chime should be noticeable but not loud)
- Listening pulse: `volume=0.15` (subtle background indicator)
- Processing pulse: `volume=0.1` (very subtle, just enough to be perceptible)

These map to the effective volumes from the browser implementation:
- Browser chime peak: `1.0 * MAX_VOLUME(0.3) = 0.3`
- Browser listening pulse peak: `0.25 * MAX_VOLUME(0.3) = 0.075`
- Browser processing pulse peak: `0.15 * MAX_VOLUME(0.3) = 0.045`

#### 2. Prevent sound effects during TTS

The `ServerAudioState` should NOT play pulses while TTS is active. The `_ttsActive` flag handles this via `syncState()` (state becomes `speaking`, pulses stop). But there's a timing edge case: TTS queue processing is async, so `setTtsActive(true)` must be called BEFORE the first PCM chunk is sent.

Verify that `processTtsQueue()` calls `serverAudioState.setTtsActive(true)` before calling `streamTtsOverWs()`. This is already specified in Phase 2 -- `setTtsActive` is managed ONLY in `processTtsQueue()`, never inside `streamTtsOverWs` or `_streamTtsOverWsInner`.

#### 3. Handle rapid state transitions

If `notifyWaitStatus()` is called rapidly (true -> false -> true), the server audio state should cancel pending chimes and restart cleanly. The `_transition()` method already calls `_cancelChimeDelay()` and `_stopPulseTimer()` on every transition, so this is handled.

### Success Criteria

- [ ] Chime is audible but not jarring after TTS finishes
- [ ] Listening pulses are subtle (barely noticeable, just enough to know the system is active)
- [ ] Processing pulses are distinguishable from listening pulses (lower pitch, different rhythm)
- [ ] Sounds don't overlap with TTS playback
- [ ] Rapid state changes don't produce glitched audio or leaked timers
- [ ] No audio plays when voice mode is off
- [ ] `npm test` passes

### Manual Testing Checklist

1. Start voice mode -> silence (no waitStatus yet)
2. Server sends waitStatus(true) -> hear chime then periodic listening pulses
3. Speak to Claude -> pulses change to processing rhythm
4. Claude speaks back via TTS -> pulses stop, TTS plays cleanly
5. TTS finishes, Claude waits -> chime + listening pulses resume
6. TTS finishes, Claude keeps working -> processing pulses (no chime)
7. Click mic button to stop -> all sound stops immediately
8. Rapid mic toggle (on/off/on) -> no stuck audio, correct final state
9. WebSocket disconnects during pulses -> pulses silently skip (no WS client), reconnect resumes on next tick
10. Leave in listening state for 2+ minutes -> no audio degradation
11. TTS and pulse fire close together -> mutex serializes, no interleaved audio corruption
12. Sound effects do NOT mute the mic (verify speech recognition continues during pulses)
13. Session reset -> `setVoiceActive(false)` clears all timers, no stale pulses after reset

---

## WebSocket Reconnect Behavior

**Policy**: WS disconnect does NOT deactivate voice mode. Voice mode is controlled by explicit user toggle (`POST /api/voice-active`) and SSE `allClientsDisconnected` (all browser tabs closed).

When a WebSocket audio client disconnects and reconnects while voice mode is active:

1. **Server side**: `ServerAudioState` continues running -- timers keep firing, but `_streamSound()` silently skips when `findWsClientForSession()` returns null (no connected WS client).
2. **On reconnect**: The new WS client is registered, and the next pulse timer tick delivers audio to it. No special re-sync needed -- pulses are stateless short sounds.
3. **If all SSE clients disconnect** (browser tabs closed): `setVoiceActive(false)` is called via the existing `allClientsDisconnected` event, which stops `ServerAudioState` timers. On browser reopen + voice re-enable, fresh state begins.

## Testing Strategy

### Automated Tests

- Existing server-side tests should pass unchanged: `npm test`
- **New: `ServerAudioState` state transition tests** (pure logic, no I/O):
  - Test `syncState()` derives correct state from all signal combinations
  - Test `setListening(true)` resets `_waitStatusKnown`, `_lastWaitStatus`, `_ttsActive`
  - Test rapid state transitions cancel timers (mock `setInterval`/`setTimeout`)
  - Test `setTtsActive(true)` transitions to `speaking` and stops pulses
  - These tests don't need ffmpeg or WebSocket -- just test the state logic
- **New: Integration test for `kind` field in WS messages**:
  - Verify `tts-start` messages include `kind: 'tts'` for TTS and `kind: 'sfx'` for sound effects
  - Verify no `voiceState.setTtsActive()` call for `kind: 'sfx'` messages

### Manual Testing

See Phase 4 manual testing checklist above. These are the core verification steps.

## Performance Considerations

- **Startup cost**: Three `ffmpeg` invocations add ~300ms to startup. Acceptable since server starts once.
- **Memory**: Pre-rendered WAV files are <30KB each, read into memory on each stream. Could be cached in a Buffer for zero disk I/O, but not necessary given the small size.
- **CPU**: Streaming a pre-rendered file is trivial (just reading + sending). No CPU overhead compared to generating oscillator audio in real-time.
- **WebSocket bandwidth**: Each pulse is ~7-25KB of PCM data. At one pulse every 5-7 seconds, this is negligible (~3KB/s average).
- **Timer cleanup**: All `setInterval` and `setTimeout` IDs are tracked and cleared on transitions and destroy. No timer leaks.

## References

- TTS render pipeline: `src/unified-server.ts:47-92` (queue), `211-229` (renderTtsToFile), `1244-1281` (streamTtsOverWs)
- Browser AudioPlayer: `public/app.js:1-94`
- Browser VoiceStateMachine: `public/app.js:96-427`
- Wait status notification: `src/unified-server.ts:1006-1013`
- Current audio feedback plan: `plans/2026-03-15-audio-feedback-state-machine.md`
- Server-side TTS plan: `plans/server-side-tts.md`
