# Audio Feedback State Machine — Implementation Plan

## Overview

Add continuous ambient audio feedback to the voice hooks browser UI so the user knows what state Claude is in without looking at the screen. A four-state machine (Inactive, Listening, Processing, Speaking) drives Web Audio API-generated ambient sounds that play in the background between transitions.

## Session Reference

This plan was generated during a Claude Code session on 2026-03-15 in the mcp-voice-hooks repo, branch `feature/ws-speech-recognizer`.

## Current State Analysis

### Existing Audio Infrastructure

The browser UI (`public/app.js`) already has several audio primitives:

1. **`AudioPlayer` class** (lines 1-94): Manages PCM16 TTS playback via a dedicated `AudioContext` at 22050Hz. Has `ttsActive` flag, `isPlaying()` method, and `unlock()` for iOS gesture requirements.

2. **`playWaitingChime()`** (lines 255-289): Plays a two-note chime (880Hz + 1100Hz sine waves) when Claude transitions to waiting. Creates a *throwaway* `AudioContext` each time — does not reuse `AudioPlayer.playbackContext`.

3. **`playWaitingChimeWhenReady()`** (lines 234-253): Delays the chime until TTS audio finishes (polls `audioPlayer.isPlaying()` every 100ms, max 15s). Uses `_waitingChimePending` flag to allow cancellation.

4. **Heartbeat** (lines 291-334): A processing indicator that plays a low 70Hz pulse every 2.5s. Uses its own `heartbeatContext` AudioContext. Started when `waitStatus=false` and `isListening=true` (i.e., Claude is processing). Stopped on `waitStatus=true` or TTS start.

5. **`handleWaitStatus(isWaiting)`** (lines 210-232): The main state dispatcher:
   - `isWaiting=true`: stops heartbeat, schedules waiting chime
   - `isWaiting=false` + `isListening`: starts heartbeat

### Existing State Signals

| Signal | Source | Meaning |
|--------|--------|---------|
| `isListening` | Local state, toggled by mic button | Voice mode on/off |
| `waitStatus.isWaiting=true` | SSE from server (`notifyWaitStatus`) | Claude is waiting for voice input |
| `waitStatus.isWaiting=false` | SSE from server | Claude is working/processing |
| `tts-start` WS message | WebSocket from server (line 1113) | TTS audio stream beginning |
| `tts-end` WS message | WebSocket from server (line 1120) | TTS audio stream ended |
| `tts-clear` WS message | WebSocket from server (line 1131) | TTS playback cancelled/cleared |
| `audioPlayer.isPlaying()` | Local check | TTS audio buffers still scheduled |

### Key Discoveries

- **Three AudioContexts in play**: `AudioPlayer.playbackContext` (22050Hz TTS), `heartbeatContext` (ambient pulse), and throwaway contexts in `playWaitingChime()`. Browsers limit AudioContext count (typically 6), so consolidation is important.
- **Heartbeat already implements "Processing" ambient sound** (70Hz pulse every 2.5s) but it's basic and disconnected from a formal state machine.
- **The waiting chime already handles the Listening transition** but the chime is a one-shot, not continuous ambient.
- **Echo suppression** (`_muteAudioCapture`) mutes mic during TTS — ambient sounds during Listening/Processing must not trigger this (they use a separate output path from TTS).
- **`handleWaitStatus`** is the natural integration point — it already switches between heartbeat and chime.
- **Server-side**: `notifyWaitStatus(isWaiting)` in `unified-server.ts:1006` broadcasts wait status to all SSE clients viewing the active session.
- **`tts-clear`** (line 1131) and WebSocket `onclose` (line 1077) are additional paths that can leave the audio state stale if not handled.

## Desired End State

A `VoiceStateMachine` class in `public/app.js` that:

1. Maintains one of four states: `inactive`, `listening`, `processing`, `speaking`
2. Uses a **derived-state reducer pattern**: a single `syncState()` function computes the desired state from four input signals (`isListening`, `waitStatusKnown`, `lastWaitStatus`, `ttsActive`) and calls `_transition()` — eliminating race conditions from imperative transitions scattered across handlers
3. Generates continuous ambient audio via Web Audio API (no audio files) for `listening` and `processing` states
4. Plays a transition chime when entering `listening` (preserving current behavior)
5. Produces no ambient sound in `inactive` or `speaking` states
6. Remains silent after mic-on until the first `waitStatus` event arrives from the server (avoids playing wrong ambient on stale state)
7. Uses a single shared `AudioContext` with a master gain node (set to `MAX_VOLUME`) for all state machine audio — both ambient and chime are capped
8. Integrates cleanly with existing `handleWaitStatus`, `tts-start`/`tts-end`/`tts-clear` handlers, WS `onclose`, and `toggleVoiceDictation`

### Verification

- Start voice mode -> silence (waiting for first waitStatus from server)
- Server sends waitStatus(true) -> hear chime then continuous listening ambient
- Speak to Claude -> ambient changes to processing rhythm
- Claude speaks back -> ambient stops, TTS plays cleanly
- TTS finishes, Claude waits -> chime + listening ambient resumes
- TTS finishes, Claude keeps working -> processing ambient plays
- TTS cancelled (tts-clear) -> reverts to correct state based on last waitStatus
- WS disconnects -> reverts to correct state based on last waitStatus
- Stop voice mode -> all sound stops immediately
- Late SSE event after mic off -> no sound plays (isListening guard)
- Toggle mic off then on -> no stale state leaks (lastWaitStatus and waitStatusKnown reset)

## What We're NOT Doing

- **No new server-side changes** — all signals needed already exist (waitStatus, tts-start, tts-end, tts-clear)
- **No audio files** — all sounds generated with Web Audio API oscillators/noise
- **No user-facing settings for ambient sounds** (volume, enable/disable) in this phase — can be added later
- **No changes to TTS playback** — AudioPlayer remains untouched
- **No changes to echo suppression** — ambient sounds use a separate AudioContext from TTS, so `_muteAudioCapture` (which controls mic streaming) is unaffected

## Implementation Approach

Replace the ad-hoc heartbeat + chime system with a formal state machine class using a **derived-state reducer** pattern. Instead of imperative `_transition()` calls scattered across event handlers, a single `syncState()` method computes the desired state from four input signals:

```
desiredState = f(isListening, waitStatusKnown, lastWaitStatus, ttsActive)
```

The reducer logic:
1. `!isListening` -> `inactive`
2. `isListening && ttsActive` -> `speaking`
3. `isListening && !ttsActive && !waitStatusKnown` -> `inactive` (silent until first server event)
4. `isListening && !ttsActive && waitStatusKnown && lastWaitStatus` -> `listening`
5. `isListening && !ttsActive && waitStatusKnown && !lastWaitStatus` -> `processing`

All event handlers simply update their respective signal and call `syncState()`. This eliminates race conditions from event ordering and makes state logic centralized and testable.

The state machine owns a single AudioContext. All audio (ambient and chime) routes through a `masterGain` node set to `MAX_VOLUME` (0.3) which caps the maximum output of all state machine sounds.

---

## Phase 1: Create `VoiceStateMachine` Class

### Overview

Define the state machine class with the derived-state reducer, ambient sound generation, and proper lifecycle management. This replaces `heartbeatContext`, `heartbeatInterval`, `playWaitingChime()`, `playWaitingChimeWhenReady()`, `startHeartbeat()`, `stopHeartbeat()`, and `_playHeartbeatPulse()`.

### Changes Required

#### 1. New `VoiceStateMachine` class in `public/app.js`

**File**: `public/app.js`
**Location**: Insert after the `AudioPlayer` class (after line 94), before `MessengerClient`

```javascript
// VoiceStateMachine: manages ambient audio feedback based on Claude's state
// Uses a derived-state reducer: desiredState = f(isListening, waitStatusKnown, lastWaitStatus, ttsActive)
// States: inactive, listening, processing, speaking
class VoiceStateMachine {
    // Maximum volume for ALL state machine audio (ambient + chime).
    // masterGain is set to this value so nothing exceeds it.
    static MAX_VOLUME = 0.3;

    constructor(audioPlayer) {
        this.audioPlayer = audioPlayer; // reference for isPlaying() checks
        this.state = 'inactive';
        this.audioCtx = null; // lazy-init on first use
        this.masterGain = null; // master gain node — caps all output
        this.ambientNodes = null; // currently playing ambient sound graph
        this._chimePending = false;
        this._chimeTimerId = null; // track setTimeout for cleanup

        // Input signals for the derived-state reducer
        this._isListening = false;
        this._waitStatusKnown = false; // true after first setWaitStatus() call in a session
        this._lastWaitStatus = false; // last known waitStatus from server
        this._ttsActive = false;
    }

    // --- Derived-State Reducer ---
    // Call this after updating any input signal. It computes the desired state
    // and transitions only if the state actually changed.

    syncState() {
        let desired;
        if (!this._isListening) {
            desired = 'inactive';
        } else if (this._ttsActive) {
            desired = 'speaking';
        } else if (!this._waitStatusKnown) {
            // Mic is on but we haven't received a waitStatus yet —
            // stay silent until we know what Claude is doing
            desired = 'inactive';
        } else if (this._lastWaitStatus) {
            desired = 'listening';
        } else {
            desired = 'processing';
        }
        this._transition(desired);
    }

    // Input signal setters — each updates its signal and calls syncState()

    setListening(isListening) {
        this._isListening = isListening;
        if (isListening) {
            // Reset server-side signals on new session to prevent stale state
            this._lastWaitStatus = false;
            this._waitStatusKnown = false;
            this._ttsActive = false;
        }
        this.syncState();
    }

    setWaitStatus(isWaiting) {
        this._waitStatusKnown = true;
        this._lastWaitStatus = isWaiting;
        this.syncState();
    }

    setTtsActive(active) {
        this._ttsActive = active;
        this.syncState();
    }

    // --- AudioContext Lifecycle ---

    // Must be called from a user gesture (e.g., mic button click) to satisfy
    // Safari/iOS autoplay policies. Creates and resumes the AudioContext.
    async unlock() {
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
            this.audioCtx = new AudioContext();
            this.masterGain = this.audioCtx.createGain();
            this.masterGain.gain.value = VoiceStateMachine.MAX_VOLUME;
            this.masterGain.connect(this.audioCtx.destination);
        }
        try {
            await this.audioCtx.resume();
        } catch (e) {
            console.warn('VoiceStateMachine: AudioContext resume failed:', e);
        }
    }

    // Lazy-init for non-gesture paths (will be suspended on Safari until unlock)
    _ensureContext() {
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
            this.audioCtx = new AudioContext();
            this.masterGain = this.audioCtx.createGain();
            this.masterGain.gain.value = VoiceStateMachine.MAX_VOLUME;
            this.masterGain.connect(this.audioCtx.destination);
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
        return this.audioCtx;
    }

    // --- State Transitions (internal) ---

    _transition(newState) {
        if (newState === this.state) return;
        const oldState = this.state;
        this.state = newState;

        // Stop any current ambient sound
        this._stopAmbient();
        // Cancel any pending chime timer
        this._cancelChimeTimer();

        switch (newState) {
            case 'inactive':
                this._chimePending = false;
                // Let AudioContext suspend to save resources
                if (this.audioCtx && this.audioCtx.state === 'running') {
                    this.audioCtx.suspend().catch(() => {});
                }
                break;

            case 'listening':
                // Play transition chime, then start listening ambient
                this._chimePending = true;
                this._playChimeWhenReady(() => {
                    if (this.state === 'listening') {
                        this._startListeningAmbient();
                    }
                });
                break;

            case 'processing':
                this._chimePending = false;
                this._startProcessingAmbient();
                break;

            case 'speaking':
                this._chimePending = false;
                // No ambient sound during TTS — would interfere with speech
                break;
        }
    }

    // --- Ambient Sound Generators ---
    // All audio routes through this.masterGain which is capped at MAX_VOLUME.
    // Individual gain values below are relative to the master gain.

    _startListeningAmbient() {
        // Gentle breathing/pulse: a slow-oscillating low-frequency hum
        // Soft sine wave at ~180Hz with amplitude modulated by a ~0.5Hz LFO
        // Gives a gentle "breathing" sensation
        const ctx = this._ensureContext();
        const now = ctx.currentTime;

        // Carrier: soft tone
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 180;

        // LFO for breathing effect (amplitude modulation)
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.5; // 0.5 Hz = one breath cycle per 2 seconds

        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.1; // modulation depth (relative to master)

        const baseGain = ctx.createGain();
        baseGain.gain.value = 0.15; // base volume (relative to master, so actual = 0.15 * 0.3 = 0.045)

        // Route: lfo -> lfoGain -> baseGain.gain (modulates amplitude)
        lfo.connect(lfoGain);
        lfoGain.connect(baseGain.gain);

        // Carrier -> baseGain -> masterGain -> destination
        osc.connect(baseGain);
        baseGain.connect(this.masterGain);

        osc.start(now);
        lfo.start(now);

        this.ambientNodes = { sources: [osc, lfo], gains: [lfoGain, baseGain] };
    }

    _startProcessingAmbient() {
        // Subtle working/ticking rhythm: low pulse with rhythmic amplitude modulation
        const ctx = this._ensureContext();
        const now = ctx.currentTime;

        // Low pulse oscillator (like current heartbeat but faster and more rhythmic)
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 90; // slightly higher than old 70Hz heartbeat

        // Amplitude envelope driven by a sine LFO for rhythmic pulsing
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 1.5; // 1.5 Hz = 3 ticks per 2 seconds

        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.2; // modulation depth (relative to master)

        const baseGain = ctx.createGain();
        baseGain.gain.value = 0.07; // base volume (relative to master, so actual = 0.07 * 0.3 = 0.021)

        lfo.connect(lfoGain);
        lfoGain.connect(baseGain.gain);

        osc.connect(baseGain);
        baseGain.connect(this.masterGain);

        osc.start(now);
        lfo.start(now);

        this.ambientNodes = { sources: [osc, lfo], gains: [lfoGain, baseGain] };
    }

    _stopAmbient() {
        if (!this.ambientNodes) return;
        const { sources, gains } = this.ambientNodes;
        // Fade out quickly to avoid clicks
        const ctx = this.audioCtx;
        if (ctx && ctx.state === 'running') {
            const now = ctx.currentTime;
            for (const g of gains) {
                try {
                    g.gain.cancelScheduledValues(now);
                    g.gain.setValueAtTime(g.gain.value, now);
                    g.gain.linearRampToValueAtTime(0, now + 0.05);
                } catch (_e) { /* ignore */ }
            }
            // Stop and disconnect sources after fade completes
            setTimeout(() => {
                for (const s of sources) {
                    try { s.stop(); } catch (_e) { /* may already be stopped */ }
                    try { s.disconnect(); } catch (_e) { /* ignore */ }
                }
                for (const g of gains) {
                    try { g.disconnect(); } catch (_e) { /* ignore */ }
                }
            }, 60);
        } else {
            for (const s of sources) {
                try { s.stop(); } catch (_e) { /* ignore */ }
                try { s.disconnect(); } catch (_e) { /* ignore */ }
            }
            for (const g of gains) {
                try { g.disconnect(); } catch (_e) { /* ignore */ }
            }
        }
        this.ambientNodes = null;
    }

    // --- Transition Chime ---

    _cancelChimeTimer() {
        if (this._chimeTimerId !== null) {
            clearTimeout(this._chimeTimerId);
            this._chimeTimerId = null;
        }
        this._chimePending = false;
    }

    _playChimeWhenReady(onComplete) {
        // Wait for TTS audio to finish before playing (same logic as existing playWaitingChimeWhenReady)
        const deadline = Date.now() + 15000;
        const check = () => {
            if (!this._chimePending) return;
            if (!this.audioPlayer.isPlaying()) {
                this._chimePending = false;
                this._chimeTimerId = null;
                this._playChime(onComplete);
            } else if (Date.now() >= deadline) {
                this._chimePending = false;
                this._chimeTimerId = null;
                this._playChime(onComplete);
            } else {
                this._chimeTimerId = setTimeout(check, 100);
            }
        };
        // Delay 500ms to let TTS start streaming (same as existing behavior)
        this._chimeTimerId = setTimeout(check, 500);
    }

    _playChime(onComplete) {
        try {
            const ctx = this._ensureContext();
            const now = ctx.currentTime;

            // Two-note ascending chime (same as existing playWaitingChime)
            // Gain values are relative to masterGain (0.3), so effective peak = 1.0 * 0.3 = 0.3
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.frequency.value = 880;
            osc1.type = 'sine';
            gain1.gain.setValueAtTime(1.0, now);
            gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
            osc1.connect(gain1);
            gain1.connect(this.masterGain);
            osc1.start(now);
            osc1.stop(now + 0.1);

            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.frequency.value = 1100;
            osc2.type = 'sine';
            gain2.gain.setValueAtTime(1.0, now + 0.1);
            gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
            osc2.connect(gain2);
            gain2.connect(this.masterGain);
            osc2.start(now + 0.1);
            osc2.stop(now + 0.2);

            // Start ambient after chime finishes; disconnect chime nodes
            osc2.onended = () => {
                try { osc1.disconnect(); gain1.disconnect(); } catch (_e) {}
                try { osc2.disconnect(); gain2.disconnect(); } catch (_e) {}
                if (onComplete) onComplete();
            };
        } catch (e) {
            console.warn('Could not play chime:', e);
            if (onComplete) onComplete();
        }
    }

    // --- Lifecycle ---

    // Clean shutdown — call on page unload or when destroying the client
    destroy() {
        this._stopAmbient();
        this._cancelChimeTimer();
        if (this.audioCtx) {
            this.audioCtx.close().catch(() => {});
            this.audioCtx = null;
            this.masterGain = null;
        }
        this.state = 'inactive';
    }
}
```

### Success Criteria
- [ ] `VoiceStateMachine` class is defined and instantiable
- [ ] `syncState()` correctly derives state from `(isListening, waitStatusKnown, lastWaitStatus, ttsActive)` inputs
- [ ] When `isListening=true` but `waitStatusKnown=false`, state is `inactive` (silent)
- [ ] `setListening(true)` resets `_lastWaitStatus`, `_waitStatusKnown`, and `_ttsActive`
- [ ] Each state transition stops old ambient and starts new ambient (or silence)
- [ ] Chime plays on transition to `listening`, followed by ambient
- [ ] No ambient plays during `speaking` or `inactive`
- [ ] All audio routes through `masterGain` (capped at `MAX_VOLUME = 0.3`)
- [ ] All audio nodes are properly disconnected on stop
- [ ] Chime timer IDs are tracked and cancelled on transitions

---

## Phase 2: Integrate State Machine into `MessengerClient`

### Overview

Wire the state machine into the existing event flow using the signal-setter API. Replace all ad-hoc heartbeat/chime methods. All event handlers simply update their signal and let `syncState()` compute the correct state.

### Changes Required

#### 1. Initialize state machine in constructor

**File**: `public/app.js`
**Location**: In `MessengerClient.constructor()`, replace heartbeat state (lines 147-149):

Replace:
```javascript
// Heartbeat state (processing indicator sound)
this.heartbeatContext = null;
this.heartbeatInterval = null;
```

With:
```javascript
// Audio feedback state machine
this.voiceState = new VoiceStateMachine(this.audioPlayer);
```

#### 2. Add `beforeunload` teardown

**File**: `public/app.js`
**Location**: In `setupEventListeners()` method, add:

```javascript
window.addEventListener('beforeunload', () => {
    this.voiceState.destroy();
});
```

#### 3. Replace `handleWaitStatus`

**File**: `public/app.js`
**Location**: Replace the entire `handleWaitStatus` method (lines 210-232)

```javascript
handleWaitStatus(isWaiting) {
    const waitingIndicator = document.getElementById('waitingIndicator');
    if (waitingIndicator) {
        const wasAtBottom = this.isUserNearBottom();
        waitingIndicator.style.display = isWaiting ? 'block' : 'none';
        if (isWaiting && wasAtBottom) {
            this.scrollToBottom();
        }
    }
    // Update the signal — syncState() handles the rest
    this.voiceState.setWaitStatus(isWaiting);
}
```

#### 4. Update TTS start/end/clear handlers

**File**: `public/app.js`
**Location**: In `handleWsMessage()`, the WebSocket message handler (around lines 1113-1135)

In the `tts-start` case, replace `this.stopHeartbeat()` with:
```javascript
this.voiceState.setTtsActive(true);
```

In the `tts-end` case, after `this.audioPlayer.finishPlayback()` and the tts-ack send, add:
```javascript
this.voiceState.setTtsActive(false);
```

In the WebSocket `tts-clear` case (line 1131-1134), after `this.audioPlayer.clear()`, add:
```javascript
this.voiceState.setTtsActive(false);
```

**Also** in `initializeTTSEvents()` (around line 191), the SSE `tts-clear` handler currently only calls `this.audioPlayer.clear()`. Add after it:
```javascript
this.voiceState.setTtsActive(false);
```

This ensures both the WebSocket and SSE `tts-clear` paths reset the TTS signal. Without this, a `tts-clear` received via SSE could leave the state machine stuck in `speaking`.

#### 5. Update WebSocket `onclose` handler

**File**: `public/app.js`
**Location**: In the WebSocket `onclose` callback (around line 1077)

After the existing `this.wsConnected = false` line, add:
```javascript
// TTS is no longer active if the WS drops
this.voiceState.setTtsActive(false);
```

#### 6. Update `startVoiceDictation` / `stopVoiceDictation`

**File**: `public/app.js`

In `startVoiceDictation()` (around line 848), after `await this.audioPlayer.unlock()`, add:
```javascript
// Unlock the state machine AudioContext on user gesture (Safari requirement)
await this.voiceState.unlock();
// Signal that we're now listening — syncState() will stay inactive (silent)
// until the first waitStatus event arrives from the server
this.voiceState.setListening(true);
```

In `stopVoiceDictation()` (around line 871), after setting `this.isListening = false`, replace `this.stopHeartbeat()` with:
```javascript
this.voiceState.setListening(false);
```

#### 7. Remove old methods

**File**: `public/app.js`

Delete the following methods entirely:
- `playWaitingChimeWhenReady()` (lines 234-253)
- `playWaitingChime()` (lines 255-289)
- `startHeartbeat()` (lines 291-305)
- `stopHeartbeat()` (lines 307-312)
- `_playHeartbeatPulse()` (lines 314-334)

Also remove the `_waitingChimePending` references (lines 222-223, 227, 242, 245).

#### 8. Remove stale references

**File**: `public/app.js`

Search for any remaining references to `startHeartbeat`, `stopHeartbeat`, `_waitingChimePending`, `heartbeatContext`, `heartbeatInterval`, `playWaitingChime`, `playWaitingChimeWhenReady` and remove them. Based on the grep results, there is one more `startHeartbeat` call at line 229 (inside the old `handleWaitStatus` which is being replaced) and a `stopHeartbeat` at line 1115 (in `tts-start`, being replaced).

### Success Criteria
- [ ] No references to old heartbeat/chime methods remain
- [ ] `VoiceStateMachine` is the sole controller of ambient audio
- [ ] All event handlers use signal setters (`setListening`, `setWaitStatus`, `setTtsActive`) — no direct `_transition` calls
- [ ] State is always correctly derived:
  - `!isListening` -> `inactive` (regardless of other signals)
  - `isListening + ttsActive` -> `speaking` (regardless of `waitStatusKnown`)
  - `isListening + !ttsActive + !waitStatusKnown` -> `inactive` (silent until first server event)
  - `isListening + !ttsActive + waitStatusKnown + lastWaitStatus` -> `listening`
  - `isListening + !ttsActive + waitStatusKnown + !lastWaitStatus` -> `processing`
- [ ] `setListening(true)` resets `_lastWaitStatus`, `_waitStatusKnown`, `_ttsActive`
- [ ] `tts-clear` and WS `onclose` both call `setTtsActive(false)`
- [ ] `unlock()` is called from user gesture path (mic button)
- [ ] `destroy()` is called on `beforeunload`
- [ ] Build succeeds (no JS errors in console)
- [ ] All existing tests pass: `npm test`

---

## Phase 3: Sound Design Tuning

### Overview

After the state machine is wired up and functional, tune the ambient sounds for comfort. This phase is iterative and subjective — the implementer should listen to the sounds and adjust parameters.

### Tuning Guidelines

**Listening ambient** (should feel calm, reassuring):
- Carrier frequency: 150-220Hz range (try different values)
- LFO rate: 0.3-0.8Hz (slower = more calming)
- Volume: 0.10-0.20 base gain relative to master (actual output = value * MAX_VOLUME)
- Consider adding a second harmonic oscillator at 2x frequency with lower volume for warmth

**Processing ambient** (should feel active but not stressful):
- Pulse frequency: 80-120Hz range
- Rhythm rate: 1.0-2.0Hz (faster = more "working" feeling)
- Volume: 0.05-0.15 base gain relative to master
- Consider using triangle wave instead of sine for slightly more presence

**Transition chime** (already good, minor tweaks):
- Current peak is 1.0 relative to master (effective 0.3 absolute) — same as existing chime
- Consider slightly lower relative gain (0.7) if it feels too loud compared to ambient

### Changes Required

Adjust the numeric constants in `_startListeningAmbient()` and `_startProcessingAmbient()` based on listening tests. No structural changes.

### Success Criteria
- [ ] Listening ambient is audible but not annoying over extended periods (test for 2+ minutes)
- [ ] Processing ambient is distinguishable from listening ambient
- [ ] Transition chime is audible over ambient without being jarring
- [ ] Ambient sounds do not interfere with TTS playback (verified by speaking while ambient plays, then transitioning to speaking state)
- [ ] No audio glitches (clicks, pops) on state transitions

---

## Testing Strategy

### Automated Tests
- No unit tests for Web Audio API (it's a browser API not available in Node.js test environment)
- Existing server-side tests should pass unchanged: `npm test`

### Manual Testing

**Core flow:**
1. Open browser UI, click mic button -> silence (state is `inactive` — `waitStatusKnown=false`)
2. Server sends first waitStatus(true) -> hear chime then continuous listening ambient
3. Speak to Claude -> ambient changes to processing rhythm
4. Claude speaks back via TTS -> ambient stops, TTS plays cleanly
5. TTS ends, Claude waits -> chime + listening ambient
6. TTS ends, Claude does tool call -> processing ambient (no chime)
7. Click mic button to stop -> all sound stops immediately

**Edge cases and race conditions:**
8. Rapid mic toggle (on/off/on quickly) -> no stuck audio, correct final state, stale state does not leak
9. Late SSE `waitStatus(true)` arrives after mic off -> no sound plays (`isListening=false` -> `inactive`)
10. `tts-clear` received during TTS -> reverts to correct ambient based on last waitStatus
11. WebSocket disconnects during TTS -> `ttsActive` reset, state reverts based on last waitStatus, no stuck `speaking` state
12. SSE reconnects (server restart) -> state correctly re-syncs when new waitStatus arrives
13. Leave in listening state for 5 minutes -> no audio degradation or memory leaks
14. Multiple rapid state changes (speaking->processing->listening->speaking) -> no audio glitches, clicks, or leaked nodes
15. Toggle mic off while `_chimePending=true` -> chime timer cancelled, no delayed sound after mic off
16. Previous session ended while waiting, new session starts -> no immediate chime (waitStatusKnown reset)

## Performance Considerations

- **AudioContext count**: The state machine uses exactly 1 AudioContext (down from 3+ currently). This is well within browser limits.
- **CPU usage**: Continuous oscillators use minimal CPU. Two oscillators (carrier + LFO) per ambient state is negligible.
- **Memory**: No audio buffers are created — oscillators generate audio in real-time. `_stopAmbient()` disconnects and stops all nodes for GC.
- **Fade-out on transitions**: 50ms linear ramp to zero prevents audio clicks without perceptible delay.
- **Master gain node**: All state machine audio routes through a single master gain node set to `MAX_VOLUME = 0.3`, providing a hard volume cap.
- **Timer cleanup**: All `setTimeout` IDs are tracked and cleared on state transitions and `destroy()` to prevent leaked timers.

## References

- Current audio code: `public/app.js:1-334` (AudioPlayer, chime, heartbeat)
- Wait status server code: `src/unified-server.ts:1005-1013` (notifyWaitStatus)
- TTS WebSocket messages: `src/unified-server.ts:1247-1272` (tts-start, tts-end)
- TTS clear handler: `public/app.js:1131-1134` (tts-clear)
- WS onclose handler: `public/app.js:1077` (WebSocket disconnect)
- Web Audio API docs: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
