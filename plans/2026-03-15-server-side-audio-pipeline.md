# Server-Side Audio Pipeline — Implementation Plan

## Overview

Move all audio rendering (chime, heartbeat pulses, and TTS) to the server side so the browser plays only PCM chunks received over WebSocket. Currently, TTS is rendered server-side (`say` command -> WAV -> WebSocket PCM streaming), but chime and heartbeat/pulse sounds are generated browser-side using Web Audio API oscillators. This plan unifies everything through the existing server-side WAV-to-WebSocket pipeline.

## Session Reference

Generated during Claude Code session on 2026-03-15 in the `mcp-voice-hooks` repo, branch `feature/ws-speech-recognizer`.

## Current State Analysis

### Server-Side TTS Pipeline (already working)

1. **`renderTtsToFile()`** (`src/unified-server.ts:211-229`): Renders text to WAV via `say -o` with format `LEI16@22050` (16-bit PCM, 22050Hz, mono).
2. **`streamTtsOverWs()`** (`src/unified-server.ts:1244-1281`): Reads WAV, finds data chunk via `findWavDataOffset()`, sends `tts-start` -> PCM binary chunks -> `tts-end` over WebSocket.
3. **`enqueueTts()` / `processTtsQueue()`** (`src/unified-server.ts:47-75`): Serializes TTS renders to prevent CPU overload. Queue items have `text`, `rate`, `sessionKey`.
4. **`notifyWaitStatus()`** (`src/unified-server.ts:1006-1013`): Broadcasts `waitStatus` events to SSE clients.
5. **`notifyTTSClear()`** (`src/unified-server.ts:980-993`): Sends `tts-clear` to both SSE and WS clients.

### Browser-Side Audio (to be replaced)

1. **`AudioPlayer` class** (`public/app.js:1-94`): Plays PCM16 audio at 22050Hz via `AudioContext`. Has `prepareForPlayback()`, `scheduleChunk()`, `finishPlayback()`, `clear()`, `isPlaying()`.
2. **`VoiceStateMachine` class** (`public/app.js:96-461`): Already implemented. Manages four states (`inactive`, `listening`, `processing`, `speaking`) using a derived-state reducer. Currently generates audio via Web Audio API oscillators:
   - `_startListeningAmbient()` (lines 242-277): 180Hz sine + 0.5Hz LFO breathing
   - `_startProcessingAmbient()` (lines 279-309): 90Hz sine + 1.5Hz LFO pulse
   - `_playChime()` (lines 373-417): Two-note 880Hz + 1100Hz ascending chime
3. **Echo suppression** (`public/app.js:1381-1395`): `_muteAudioCapture(mute)` sets `_micMuted` flag; `_scheduleUnmute()` polls `audioPlayer.isPlaying()`.

### Key Discoveries

- **`afconvert` can convert system sounds to WAV PCM16@22050Hz mono** — matching the TTS pipeline exactly: `afconvert input.aiff output.wav -d LEI16@22050 -f WAVE -c 1`. This means system sounds can be streamed through the same `streamTtsOverWs()` path.
- **macOS system sounds** at `/System/Library/Sounds/` are good candidates: Tink (0.56s), Pop (1.63s), Purr (0.76s), Glass (1.65s). They're AIFF, 2-channel, 48kHz — `afconvert` handles the conversion.
- **`findWavDataOffset()`** already handles macOS WAV quirks (JUNK/FLLR chunks, data at byte ~4096).
- **The VoiceStateMachine is already wired** into all event handlers via `setListening()`, `setWaitStatus()`, `setTtsActive()`. The browser already dispatches state correctly — we just need to remove its audio generation and have the server send audio instead.
- **The server already knows wait status** — `notifyWaitStatus(isWaiting)` broadcasts to SSE clients. The server can use this same signal to trigger chime/pulse audio.
- **Echo suppression uses `_muteAudioCapture`** which gates on `_micMuted` flag. Since server-sent chime/pulse audio flows through `AudioPlayer` (same as TTS), echo suppression will work automatically for all sounds.
- **The TTS queue serializes renders** — chime/pulse WAV files should NOT go through `enqueueTts()` (they'd block behind speech). They need a separate path, but must be serialized with TTS to prevent interleaved WebSocket chunks.
- **Concurrent wait loops** — `waitForUtteranceCore()` can have overlapping true/false emissions (`src/unified-server.ts:492,553`). A simple boolean is insufficient; a ref-count (`activeWaitCount`) is needed to correctly track when Claude is truly waiting vs. processing.

### Available System Sounds (tested with `afconvert`)

| Sound | Duration | Character | Candidate Use |
|-------|----------|-----------|---------------|
| Tink | 0.56s | Short, light tap | Chime (transition to listening) |
| Pop | 1.63s | Soft bubble pop | Alternative chime |
| Purr | 0.76s | Soft vibration | Heartbeat pulse |
| Glass | 1.65s | Crystal ring | Too long for pulse |
| Morse | 0.70s | Dot-dash beep | Alternative pulse |
| Ping | 1.50s | Sonar ping | Alternative chime |
| Submarine | 1.49s | Low sonar | Processing pulse |

## Desired End State

1. **Server renders all audio**: TTS speech, transition chime, and heartbeat pulses — all as WAV files streamed as PCM chunks over WebSocket.
2. **Browser `AudioPlayer` plays whatever arrives** — no distinction between TTS, chime, or pulse audio.
3. **Browser `VoiceStateMachine` stays** for visual UI state (waiting indicator text, mic button color) but generates NO audio. All `_startListeningAmbient()`, `_startProcessingAmbient()`, `_playChime()` methods are removed.
4. **Server decides when to play sounds** based on its own state awareness:
   - On `notifyWaitStatus(true)`: play chime, then start periodic listening pulses
   - On `notifyWaitStatus(false)`: stop listening pulses, start periodic processing pulses
   - On TTS start: stop all pulses (TTS takes over the audio channel)
   - On TTS end: resume appropriate pulses based on current wait status
5. **Echo suppression works the same** — all audio flows through `AudioPlayer`, so `_muteAudioCapture` gates mic during any server-sent audio.
6. **Two distinct sounds**: one for listening state (waiting for voice), one for processing state (Claude thinking). Plus a chime on transition to listening.
7. **Heartbeat pulses are periodic** (every 5-10 seconds), not continuous oscillators.
8. **WebSocket audio serialization** — a mutex ensures TTS and feedback audio never interleave chunks on the same socket.
9. **Reconnection state sync** — when a WebSocket client connects (or reconnects), the server immediately reconciles audio feedback from current state.

### Verification

- Start voice mode -> silence (no waitStatus yet)
- Server sends waitStatus(true) -> hear chime, then periodic listening pulse every ~8 seconds
- Speak to Claude -> pulses change to processing rhythm (every ~5 seconds)
- Claude speaks TTS -> pulses stop, speech plays cleanly
- TTS finishes, Claude waits -> chime + listening pulses resume
- TTS finishes, Claude keeps working -> processing pulses (no chime)
- Stop voice mode -> all pulses stop immediately
- Mic is muted during chime/pulse playback (echo suppression)
- No browser-side audio generation (Web Audio API oscillators removed from state machine)
- WebSocket reconnect mid-session -> audio feedback resumes from correct state
- Multiple rapid waitStatus toggles -> no corrupt audio

## What We're NOT Doing

- **No custom audio file bundling** — using macOS system sounds from `/System/Library/Sounds/` via `afconvert`
- **No changes to AudioPlayer class** — it already handles PCM streaming perfectly
- **No changes to TTS rendering** — `renderTtsToFile()` and `enqueueTts()` stay as-is
- **No user-configurable sound selection** in this phase — hardcoded sound choices
- **No cross-platform support** — macOS only (system sounds + `afconvert`)
- **No continuous ambient audio** — switching from Web Audio oscillators to periodic short sound clips
- **No changes to SSE event flow** — `waitStatus` SSE events continue for browser UI state

## Implementation Approach

### Strategy: Pre-rendered Sound Cache + Server-Side State Machine + Audio Mutex

Pre-render system sounds to WAV at server startup (one-time `afconvert` call per sound) into a per-process private temp directory. The server maintains an `AudioFeedbackController` that tracks wait status and TTS state, and uses `setInterval` to periodically stream pulse audio over WebSocket.

A promise-based `wsAudioMutex` serializes all WebSocket audio sends (both TTS and feedback) to prevent chunk interleaving. Both `streamTtsOverWs()` and `streamSoundOverWs()` acquire the mutex before sending.

The browser `VoiceStateMachine` is simplified to only manage visual UI state — all audio methods are removed. An `isFeedback: true` field on `tts-start`/`tts-end` messages distinguishes feedback audio from speech so the browser can:
- Apply echo suppression for both (mic muted during any audio)
- Only set `ttsActive` UI state for real speech (not feedback sounds)
- Only send `tts-ack` for real speech

### Wait Status Modeling

Replace the simple boolean `lastWaitStatus` with a ref-counted `activeWaitCount`. Each `notifyWaitStatus(true)` increments the count; each `notifyWaitStatus(false)` decrements it. The effective wait status is `activeWaitCount > 0`. This correctly handles concurrent wait loops.

### Audio Message Protocol

Reuse the existing `tts-start` / binary chunks / `tts-end` protocol for all audio. Add an `isFeedback: true` field to `tts-start` so the browser knows this is a short feedback sound vs. speech. This matters for:
- Echo suppression duration (feedback sounds are <1s, don't need extended unmute polling)
- UI state (feedback audio shouldn't show "Claude is speaking" indicators)

---

## Phase 1: Server-Side Sound Cache + Audio Mutex

### Overview

Pre-render macOS system sounds to WAV files at server startup in a per-process private temp directory. Create a `SoundCache` that converts selected `/System/Library/Sounds/*.aiff` files to the same format as TTS output (`LEI16@22050`, mono, WAV). Add a WebSocket audio mutex to prevent chunk interleaving between TTS and feedback.

### Changes Required

#### 1. Add per-process temp directory and `SoundCache`

**File**: `src/unified-server.ts`
**Location**: After the TTS queue code (after line ~93), before the UtteranceQueue class

```typescript
// Per-process private temp directory for sound cache
let soundCacheDir: string | null = null;

// Pre-rendered sound cache for audio feedback (chime, pulses)
interface CachedSound {
  name: string;
  filePath: string;  // path to rendered WAV file
  pcmData: Buffer | null;  // pre-loaded PCM data (after WAV header stripped)
  ready: boolean;
}

const soundCache = new Map<string, CachedSound>();

async function initSoundCache(): Promise<void> {
  // Create per-process private temp directory (0700 permissions)
  try {
    soundCacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-voice-hooks-sounds-'));
  } catch (err) {
    debugLog(`[SoundCache] Failed to create temp dir: ${err}`);
    return;
  }

  const sounds: Array<{ name: string; source: string }> = [
    { name: 'chime', source: '/System/Library/Sounds/Tink.aiff' },
    { name: 'listening-pulse', source: '/System/Library/Sounds/Purr.aiff' },
    { name: 'processing-pulse', source: '/System/Library/Sounds/Submarine.aiff' },
  ];

  const renderPromises = sounds.map(async ({ name, source }) => {
    const outPath = path.join(soundCacheDir!, `${name}.wav`);
    const entry: CachedSound = { name, filePath: outPath, pcmData: null, ready: false };
    soundCache.set(name, entry);

    // Check if source exists
    try {
      await fs.promises.access(source);
    } catch {
      debugLog(`[SoundCache] Source not found: ${source} — skipping ${name}`);
      return;
    }

    // Check if afconvert is available
    return new Promise<void>((resolve) => {
      execFile('afconvert', [source, outPath, '-d', 'LEI16@22050', '-f', 'WAVE', '-c', '1'], async (error) => {
        if (error) {
          debugLog(`[SoundCache] Failed to convert ${name}: ${error.message}`);
        } else {
          // Pre-load PCM data into memory to avoid disk I/O on each play
          try {
            const fileData = await fs.promises.readFile(outPath);
            const dataOffset = findWavDataOffset(fileData);
            entry.pcmData = Buffer.from(fileData.subarray(dataOffset));
            entry.ready = true;
            debugLog(`[SoundCache] Cached ${name}: ${entry.pcmData.length} bytes PCM`);
          } catch (readErr) {
            debugLog(`[SoundCache] Failed to read ${name}: ${readErr}`);
          }
        }
        resolve();
      });
    });
  });

  await Promise.all(renderPromises);
  debugLog(`[SoundCache] ${[...soundCache.values()].filter(s => s.ready).length}/${sounds.length} sounds ready`);
}

function cleanupSoundCache(): void {
  if (soundCacheDir) {
    fs.rm(soundCacheDir, { recursive: true, force: true }, () => {});
    soundCacheDir = null;
  }
}
```

#### 2. Add `os` import

**File**: `src/unified-server.ts`
**Location**: Top of file, with other imports

```typescript
import os from 'os';
```

#### 3. Add WebSocket audio mutex

**File**: `src/unified-server.ts`
**Location**: Before `streamTtsOverWs()` (before line ~1244)

A promise-based mutex that prevents concurrent WebSocket audio streams from interleaving:

```typescript
// WebSocket audio send mutex — prevents TTS and feedback audio from interleaving
let wsAudioLock: Promise<void> = Promise.resolve();

function withWsAudioLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = wsAudioLock;
  let resolve: () => void;
  wsAudioLock = new Promise<void>(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}
```

#### 4. Wrap `streamTtsOverWs()` with the mutex

**File**: `src/unified-server.ts`
**Location**: In `processTtsQueue()` (line ~57), wrap the `streamTtsOverWs` call:

Change:
```typescript
await streamTtsOverWs(wsClient, filePath, audioId);
```

To:
```typescript
await withWsAudioLock(() => streamTtsOverWs(wsClient, filePath, audioId));
```

#### 5. Add `streamSoundOverWs()` helper (uses mutex)

**File**: `src/unified-server.ts`
**Location**: After `streamTtsOverWs()` (after line ~1281)

This reuses the WAV streaming logic but with an `isFeedback` flag, pre-loaded PCM data, and mutex serialization:

```typescript
async function streamSoundOverWs(client: WsAudioClient, soundName: string): Promise<void> {
  const cached = soundCache.get(soundName);
  if (!cached || !cached.ready || !cached.pcmData) {
    debugLog(`[WS Sound] Sound not available: ${soundName}`);
    return;
  }

  await withWsAudioLock(async () => {
    const { ws } = client;
    if (ws.readyState !== WebSocket.OPEN) return;

    const audioId = `feedback-${soundName}-${Date.now()}`;

    // Send tts-start with isFeedback flag
    ws.send(JSON.stringify({
      type: 'tts-start',
      audioId,
      sampleRate: 22050,
      channels: 1,
      isFeedback: true,
    }));

    // Stream pre-loaded PCM data in chunks
    const pcmData = cached.pcmData!;
    for (let offset = 0; offset < pcmData.length; offset += TTS_WS_CHUNK_SIZE) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const chunk = pcmData.subarray(offset, Math.min(offset + TTS_WS_CHUNK_SIZE, pcmData.length));
      ws.send(chunk);
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tts-end',
        audioId,
        isFeedback: true,
      }));
    }

    debugLog(`[WS Sound] Streamed ${soundName} (${pcmData.length} bytes)`);
  });
}
```

#### 6. Call `initSoundCache()` at startup and `cleanupSoundCache()` on shutdown

**File**: `src/unified-server.ts`
**Location**: The server startup section is callback-based around `httpServer.listen()` (line ~1533). The startup needs to be restructured slightly.

Find where `httpServer.listen()` is called and wrap it in an async IIFE or add to existing async startup:

```typescript
// Before httpServer.listen():
initSoundCache().catch(err => {
  debugLog(`[SoundCache] Init failed (non-fatal): ${err}`);
});
```

Add cleanup on process exit:

```typescript
process.on('exit', cleanupSoundCache);
process.on('SIGINT', () => { cleanupSoundCache(); process.exit(0); });
process.on('SIGTERM', () => { cleanupSoundCache(); process.exit(0); });
```

Note: `initSoundCache()` is fire-and-forget here — the server starts immediately and sounds become available once conversion completes (~150ms). If `afconvert` is not available (non-macOS), sounds simply won't be cached and feedback audio will be silently skipped.

### Success Criteria
- [ ] Server starts without errors, even when `afconvert` is unavailable
- [ ] Sound cache WAV files are created in a per-process temp directory (not predictable `/tmp` paths)
- [ ] Each WAV is mono, 16-bit PCM, 22050Hz
- [ ] PCM data is pre-loaded into memory buffers
- [ ] `streamSoundOverWs()` acquires the audio mutex before sending
- [ ] `streamTtsOverWs()` acquires the audio mutex before sending
- [ ] TTS and feedback audio never interleave WebSocket chunks
- [ ] Temp directory is cleaned up on process exit (SIGINT, SIGTERM)
- [ ] `npm test` passes (no existing tests broken)
- [ ] `npm run build` succeeds (TypeScript compiles)

---

## Phase 2: Server-Side Audio Feedback Controller

### Overview

Create an `AudioFeedbackController` on the server that listens for state changes (wait status, TTS start/end, browser connect/disconnect) and sends appropriate sounds over WebSocket. This replaces the browser's `VoiceStateMachine` audio generation. Uses ref-counted wait status to handle concurrent wait loops.

### Changes Required

#### 1. Add ref-counted wait status tracking

**File**: `src/unified-server.ts`
**Location**: Near `notifyWaitStatus()` (line ~1006)

```typescript
// Ref-counted wait status: tracks concurrent wait loops
let activeWaitCount = 0;

function isEffectivelyWaiting(): boolean {
  return activeWaitCount > 0;
}
```

Update `notifyWaitStatus()`:
```typescript
function notifyWaitStatus(isWaiting: boolean) {
  if (isWaiting) {
    activeWaitCount++;
  } else {
    activeWaitCount = Math.max(0, activeWaitCount - 1);
  }

  const effectivelyWaiting = isEffectivelyWaiting();

  // Broadcast to SSE clients (existing behavior)
  const message = JSON.stringify({ type: 'waitStatus', isWaiting: effectivelyWaiting, sessionKey: activeCompositeKey });
  ttsClients.forEach((viewingKey, client) => {
    if (viewingKey === null || viewingKey === activeCompositeKey) {
      client.write(`data: ${message}\n\n`);
    }
  });

  // Trigger server-side audio feedback
  audioFeedback.onWaitStatusChange(effectivelyWaiting);
}
```

#### 2. Add `AudioFeedbackController` class

**File**: `src/unified-server.ts`
**Location**: After `streamSoundOverWs()`, before the HTTP route definitions

```typescript
// Derive the desired audio feedback state from server-side signals.
// Used for both normal transitions and reconnect reconciliation.
function deriveFeedbackState(): 'inactive' | 'listening' | 'processing' | 'speaking' {
  if (!voicePreferences.voiceActive) return 'inactive';
  if (ttsPlaying) return 'speaking';
  if (activeWaitCount > 0) return 'listening';
  return 'processing';
}

// Server-side audio feedback controller
// Sends chime and periodic pulse sounds based on Claude's state
class AudioFeedbackController {
  private state: 'inactive' | 'listening' | 'processing' | 'speaking' = 'inactive';
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private client: WsAudioClient | null = null;

  // Pulse intervals (milliseconds)
  private static LISTENING_PULSE_INTERVAL = 8000;   // Every 8 seconds
  private static PROCESSING_PULSE_INTERVAL = 5000;  // Every 5 seconds

  // Called when a WebSocket client connects or reconnects.
  // Immediately reconciles audio state from current server state.
  setClient(client: WsAudioClient | null) {
    if (!client) {
      this.stop();
      return;
    }
    this.client = client;

    // Reconcile: derive the correct state from all server-side signals
    // and transition immediately. This handles reconnect mid-session
    // for all states (listening, processing, speaking).
    const desired = deriveFeedbackState();
    if (desired !== 'inactive') {
      this._transitionTo(desired);
    }
  }

  // Called when waitStatus changes (after ref-count resolution)
  onWaitStatusChange(isWaiting: boolean) {
    if (!this.client) return;

    // Don't interrupt TTS — onTtsEnd() will reconcile
    if (this.state === 'speaking') return;

    if (isWaiting) {
      this._transitionTo('listening');
    } else {
      this._transitionTo('processing');
    }
  }

  // Called when TTS starts streaming
  onTtsStart() {
    this._transitionTo('speaking');
  }

  // Called when TTS finishes streaming.
  // Derives the correct post-TTS state from current server signals.
  onTtsEnd() {
    const desired = deriveFeedbackState();
    this._transitionTo(desired);
  }

  // Called when voice mode is deactivated or browser disconnects
  stop() {
    this._transitionTo('inactive');
    this.client = null;
  }

  private _transitionTo(newState: typeof this.state) {
    if (newState === this.state) return;
    const oldState = this.state;
    this.state = newState;

    // Stop any running pulse timer
    this._stopPulseTimer();

    switch (newState) {
      case 'inactive':
        break;

      case 'listening':
        // Always play chime on transition to listening
        this._playSound('chime');
        // Start periodic listening pulses
        this._startPulseTimer('listening-pulse', AudioFeedbackController.LISTENING_PULSE_INTERVAL);
        break;

      case 'processing':
        // Start periodic processing pulses
        this._startPulseTimer('processing-pulse', AudioFeedbackController.PROCESSING_PULSE_INTERVAL);
        break;

      case 'speaking':
        // No feedback sounds during TTS
        break;
    }

    debugLog(`[AudioFeedback] ${oldState} -> ${newState}`);
  }

  private _playSound(soundName: string) {
    if (!this.client || this.client.ws.readyState !== WebSocket.OPEN) return;
    // Don't play feedback sounds while TTS is active on the client
    if (this.client.ttsActive) return;
    streamSoundOverWs(this.client, soundName).catch(err => {
      debugLog(`[AudioFeedback] Failed to play ${soundName}: ${err}`);
    });
  }

  private _startPulseTimer(soundName: string, intervalMs: number) {
    this.pulseTimer = setInterval(() => {
      this._playSound(soundName);
    }, intervalMs);
  }

  private _stopPulseTimer() {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }
}

const audioFeedback = new AudioFeedbackController();
```

#### 3. Wire controller to TTS start/end

**File**: `src/unified-server.ts`
**Location**: In `streamTtsOverWs()` (line 1244)

After `client.ttsActive = true` (line 1255), add:
```typescript
audioFeedback.onTtsStart();
```

After `client.ttsActive = false` (line 1277), add:
```typescript
audioFeedback.onTtsEnd();
```

#### 4. Wire controller to WebSocket connect/disconnect

**File**: `src/unified-server.ts`
**Location**: In the `wss.on('connection')` handler (line 1036)

After the client is added to `wsAudioClients` (line 1065), add:
```typescript
audioFeedback.setClient(client);
```

In the WebSocket `onclose` handler, add:
```typescript
audioFeedback.stop();
```

Also in the "close existing connections" loop (line 1042), before closing the existing connection:
```typescript
audioFeedback.stop();
```

#### 5. Centralize voice deactivation cleanup

**File**: `src/unified-server.ts`
**Location**: Add a helper near `voicePreferences` declaration, then call it from every deactivation site.

Add a centralized cleanup helper:
```typescript
// Centralized voice mode deactivation — resets all audio state.
// Must be called from EVERY path that sets voicePreferences.voiceActive = false.
function deactivateVoiceMode() {
  voicePreferences.voiceActive = false;
  activeWaitCount = 0;
  audioFeedback.stop();
}
```

Replace all existing sites that set `voicePreferences.voiceActive = false` with a call to `deactivateVoiceMode()`. The known sites are:

1. **`/api/voice-active` endpoint** (line ~1315) — when user toggles voice off via API
2. **New Claude session detection** (line ~790) — when a new session starts and old voice state is stale
3. **Last client disconnect (WS)** (line ~959) — when the last WebSocket client disconnects
4. **Last client disconnect (SSE)** (line ~1120) — when the last SSE client disconnects

Search for all occurrences of `voicePreferences.voiceActive = false` and replace with `deactivateVoiceMode()`.

This prevents stale `activeWaitCount` from causing `deriveFeedbackState()` to incorrectly resolve to `listening` on a later reconnect/reenable.

### Success Criteria
- [ ] Server sends chime WAV over WebSocket when `waitStatus(true)` is emitted
- [ ] Server sends periodic listening pulse every ~8 seconds during listening state
- [ ] Server sends periodic processing pulse every ~5 seconds during processing state
- [ ] Pulses stop during TTS playback
- [ ] Pulses resume (with correct type) after TTS ends
- [ ] All pulses stop when voice mode is deactivated
- [ ] All pulses stop when WebSocket disconnects
- [ ] Chime plays on every transition to listening state (including first `waitStatus(true)`)
- [ ] Concurrent wait loops handled correctly via ref-counting
- [ ] WebSocket reconnect reconciles to correct state (listening, processing, or speaking) via `deriveFeedbackState()`
- [ ] Reconnect during processing state correctly starts processing pulses
- [ ] `npm test` passes
- [ ] `npm run build` succeeds

---

## Phase 3: Browser-Side Simplification

### Overview

Remove all audio generation from the browser `VoiceStateMachine`. Keep the state tracking for visual UI, but remove Web Audio API oscillators, chime generation, and the dedicated `AudioContext`. Handle the `isFeedback` flag in WebSocket messages so feedback audio gets echo suppression but doesn't set UI "speaking" state.

### Changes Required

#### 1. Handle `isFeedback` flag in WebSocket message handler

**File**: `public/app.js`
**Location**: In `handleWsMessage()`, the `tts-start` and `tts-end` cases (lines 1344-1368)

Update `tts-start` handler:
```javascript
case 'tts-start':
    console.log('[WS] TTS start:', msg.audioId, 'sampleRate:', msg.sampleRate, 'feedback:', !!msg.isFeedback);
    if (!msg.isFeedback) {
        this.voiceState.setTtsActive(true);
    }
    this.audioPlayer.prepareForPlayback(msg.sampleRate, msg.audioId);
    // Echo suppression: mute mic during any audio playback (TTS or feedback)
    this._muteAudioCapture(true);
    break;
```

Update `tts-end` handler:
```javascript
case 'tts-end':
    this.debugLog('[WS] TTS end:', msg.audioId);
    this.audioPlayer.finishPlayback();
    if (!msg.isFeedback) {
        this.voiceState.setTtsActive(false);
    }
    // Send tts-ack to server (only for real TTS, not feedback)
    if (!msg.isFeedback && this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
        this.audioWs.send(JSON.stringify({ type: 'tts-ack', audioId: msg.audioId }));
    }
    // Un-mute mic after playback finishes
    this._scheduleUnmute();
    break;
```

#### 2. Strip audio generation from `VoiceStateMachine`

**File**: `public/app.js`
**Location**: The `VoiceStateMachine` class (lines 96-461)

Remove the following methods entirely:
- `_startListeningAmbient()` (lines 242-277)
- `_startProcessingAmbient()` (lines 279-309)
- `_stopAmbient()` (lines 312-345)
- `_cancelChimeTimer()` (lines 349-355)
- `_playChimeWhenReady()` (lines 357-376)
- `_playChime()` (lines 378-417)

Remove these instance properties from the constructor:
- `this.audioCtx` — no longer needed
- `this.masterGain` — no longer needed
- `this.ambientNodes` — no longer needed
- `this._chimePending` — no longer needed
- `this._chimeTimerId` — no longer needed

Remove the `audioPlayer` constructor parameter and `this.audioPlayer` property — no longer referenced.

Remove these methods:
- `unlock()` — no longer needs its own AudioContext
- `_ensureContext()` — no longer needed

Simplify `_transition()` to only track state (no audio):
```javascript
_transition(newState) {
    if (newState === this.state) return;
    const oldState = this.state;
    this.state = newState;
    // Visual UI updates can be driven by state if needed
    console.log(`[VoiceState] ${oldState} -> ${newState}`);
}
```

Simplify `destroy()`:
```javascript
destroy() {
    this.state = 'inactive';
}
```

Keep these (they drive state for visual UI):
- `syncState()`
- `setListening()`
- `setWaitStatus()`
- `setTtsActive()`

#### 3. Update `VoiceStateMachine` instantiation

**File**: `public/app.js`
**Location**: In `MessengerClient.constructor()` (line ~481)

Change:
```javascript
this.voiceState = new VoiceStateMachine(this.audioPlayer);
```
To:
```javascript
this.voiceState = new VoiceStateMachine();
```

#### 4. Remove `voiceState.unlock()` call

**File**: `public/app.js`
**Location**: In `startVoiceDictation()` (around line 1078)

Remove:
```javascript
await this.voiceState.unlock();
```

The `VoiceStateMachine` no longer has an `AudioContext` to unlock.

#### 5. Keep `voiceState.destroy()` in beforeunload

**File**: `public/app.js`
**Location**: In `setupEventListeners()` (around line 789)

The `destroy()` method is now a simple state reset. Keep the call for cleanliness.

### Success Criteria
- [ ] No `AudioContext` is created by `VoiceStateMachine`
- [ ] No Web Audio API oscillators are created by the state machine
- [ ] `VoiceStateMachine` only tracks state for UI purposes
- [ ] Feedback audio plays through `AudioPlayer` (same path as TTS)
- [ ] Echo suppression works for feedback audio (mic muted during playback)
- [ ] Feedback audio does NOT trigger "speaking" UI state
- [ ] TTS audio still triggers "speaking" UI state correctly
- [ ] Visual indicators (waiting text, mic button color) still work
- [ ] No JavaScript errors in browser console
- [ ] `npm test` passes
- [ ] `npm run build` succeeds

---

## Phase 4: Sound Tuning and Testing

### Overview

Test the chosen system sounds and adjust if needed. The sound choices (Tink for chime, Purr for listening, Submarine for processing) are initial picks that may need swapping based on how they sound in practice.

### Changes Required

Adjust the sound mappings in `initSoundCache()` based on listening tests. Candidates:

**Chime (transition to listening):**
- Tink (0.56s) — light, short, unobtrusive
- Pop (1.63s) — softer but longer
- Glass (1.65s) — more prominent, crystal ring

**Listening pulse (waiting for voice, every ~8s):**
- Purr (0.76s) — soft vibration
- Tink (0.56s) — light tap

**Processing pulse (Claude thinking, every ~5s):**
- Submarine (1.49s) — low sonar
- Morse (0.70s) — dot-dash beep

Also tune the pulse intervals:
- Listening: 5-10 seconds (longer = less intrusive for extended waiting)
- Processing: 3-8 seconds (shorter = more "active" feeling)

### Success Criteria
- [ ] Chime is clearly audible as a transition indicator
- [ ] Listening pulse is distinguishable from processing pulse
- [ ] Neither pulse is annoying over 2+ minutes of continuous play
- [ ] Pulse sounds don't interfere with speech recognition
- [ ] Echo suppression mutes mic during each pulse (verify no feedback loop)
- [ ] Sounds play at appropriate volume relative to TTS speech

---

## Testing Strategy

### Automated Tests

- **Existing tests**: `npm test` must pass unchanged. Server-side changes don't affect existing test infrastructure.
- **Unit test `initSoundCache()`**: Mock `execFile` to verify `afconvert` is called with correct args. Test graceful handling when source files don't exist and when `afconvert` is unavailable.
- **Unit test `AudioFeedbackController` state machine**: Test state transitions, pulse timer lifecycle, `deriveFeedbackState()` correctness, ref-counted wait status, and reconnect reconciliation. This is pure logic, no I/O needed.
- **Integration test: serialized mixed audio events**: Send a sequence of `feedback -> tts -> feedback` events through a real WebSocket connection and verify chunks never interleave (each `tts-start` is followed by its binary chunks and `tts-end` before the next `tts-start`).
- **Integration test: reconnect state resync**: Connect a WebSocket, trigger `waitStatus(true)`, disconnect, reconnect, and verify audio feedback resumes from the correct state.

### Manual Testing

1. Start server, verify sound cache files are created in the private temp directory
2. Open browser, start voice mode
3. Verify chime plays when Claude starts waiting
4. Verify listening pulses play periodically
5. Speak to Claude, verify switch to processing pulses
6. Verify pulses stop during TTS
7. Verify pulses resume after TTS (correct type based on state)
8. Stop voice mode, verify all pulses stop
9. Verify mic is muted during pulse playback (check speech recognition doesn't trigger)
10. Rapid mic toggle — no stuck audio
11. WebSocket disconnect and reconnect — pulses resume from correct state

## Performance Considerations

- **Pre-rendered sounds**: `afconvert` runs once at startup (~50ms per file). No runtime rendering overhead for feedback sounds.
- **In-memory PCM cache**: PCM data is loaded into `Buffer` objects at startup. No disk I/O on each play. Memory cost is minimal (< 50KB per sound).
- **Audio mutex**: Promise-based lock adds negligible latency. Contention is rare — feedback sounds are short (~0.5-1.5s) and pulses are 5-8s apart.
- **Pulse timers**: Simple `setInterval` with negligible overhead. Cleared on state transitions.
- **WebSocket bandwidth**: Each pulse sends < 50KB of PCM data. At 5-8 second intervals, this is negligible.
- **Echo suppression**: Short feedback sounds (~0.5-1.5s) mean the mic is muted briefly. The `_scheduleUnmute()` polling (100ms intervals) handles unmute timing.
- **No additional AudioContexts**: Browser no longer creates an AudioContext for the state machine. Only `AudioPlayer.playbackContext` remains.
- **Graceful degradation**: If `afconvert` is unavailable (non-macOS), sound cache initialization succeeds with 0 sounds cached, and feedback audio is silently skipped.

## References

- TTS rendering: `src/unified-server.ts:211-229` (`renderTtsToFile`)
- TTS queue: `src/unified-server.ts:47-75` (`enqueueTts`, `processTtsQueue`)
- WAV streaming: `src/unified-server.ts:1244-1281` (`streamTtsOverWs`)
- WAV data offset: `src/unified-server.ts:1230-1242` (`findWavDataOffset`)
- Wait status broadcast: `src/unified-server.ts:1006-1013` (`notifyWaitStatus`)
- Wait status emissions: `src/unified-server.ts:492,499,524,553` (concurrent wait loops)
- TTS clear: `src/unified-server.ts:980-993` (`notifyTTSClear`)
- WS client tracking: `src/unified-server.ts:1021-1066` (`WsAudioClient`, connection handler)
- Browser VoiceStateMachine: `public/app.js:96-461`
- Browser AudioPlayer: `public/app.js:1-94`
- Browser WS message handler: `public/app.js:1344-1368`
- Browser echo suppression: `public/app.js:1381-1395`
- System sounds: `/System/Library/Sounds/*.aiff`
- Current state machine plan: `plans/2026-03-15-audio-feedback-state-machine.md`
