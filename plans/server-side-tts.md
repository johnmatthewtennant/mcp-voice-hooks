# Plan: Server-Side TTS Rendering with Browser Playback

## Problem

1. `say` plays audio through Mac speakers only — mobile clients can't hear it
2. Multiple `say` commands can overlap when queued speak calls arrive close together

## Proposed Solution

Eliminate the browser-to-server round trip for system voice TTS.

**Currently:** Server sends text to browser via SSE -> browser calls `POST /api/speak-system` back to server -> server runs `say` on Mac speakers. This round trip exists because the browser decides which voice to use, but it means audio only plays on Mac speakers.

**After:** Server always sends text via SSE (for conversation display + browser TTS). When "Mac System Voice" is selected, server also renders audio via `say -o` and sends the audio URL via a second SSE event. Browser fetches and plays the audio. No round trip.

### Key Design: Always Text, Conditionally Audio

When server processes a speak call:
1. **Always:** store text in conversation history, send `{ type: "speak", text }` via SSE
2. **If selectedVoice === "system":** ALSO render via `say -o`, send `{ type: "tts-audio", audioUrl }` via SSE after render completes
3. **If selectedVoice !== "system":** don't render — browser handles TTS from the text event

This means:
- Text always arrives immediately for conversation display
- Audio arrives after render delay only when Mac System Voice is selected
- Browser plays audio if it gets a `tts-audio` event, otherwise does browser TTS from the `speak` event
- No wasted CPU renders when browser TTS is active

### Responsibility Split

| Concern | Owner |
|---------|-------|
| Rendering (`say -o`) | Server — only when system voice selected, serialized via TTS render queue |
| Serving audio files | Server — `GET /api/tts-audio/:id` endpoint |
| SSE text notification | Server — always sent immediately |
| SSE audio notification | Server — sent after render, only for system voice |
| Playback ordering | **Browser** — client-side audio queue in app.js |
| Playback | **Browser** — `Audio` element (system voice) or `speechSynthesis` (browser voice) |

### Current Flow

```
Agent calls MCP speak tool
  -> POST /api/speak
  -> Server: notifyTTSClients(text)      -- SSE {type:"speak", text}
  -> Browser: speakText(text)
  -> Browser: POST /api/speak-system     -- round trip back to server
  -> Server: say "text"                  -- plays on Mac speakers only
```

### New Flow

```
Agent calls MCP speak tool
  -> POST /api/speak
  -> Server: notifyTTSClients(text)      -- SSE {type:"speak", text}  (always, immediate)
  -> Server: if system voice:
       renderTtsToFile(text, rate)        -- say -o /tmp/tts-{id}.m4a  (~1.5-5s)
       notifyTTSAudio(audioUrl)           -- SSE {type:"tts-audio", audioUrl}
  -> Browser: receives "speak" event     -- displays in conversation immediately
  -> Browser: if system voice selected:
       ignores "speak" for TTS, waits for "tts-audio" event
       fetches audio, adds to playback queue, plays
     else:
       uses speechSynthesis from "speak" text
```

## Voice Dropdown (unchanged)

1. **"Mac System Voice"** — server renders via `say -o`, pushes audio URL via SSE, browser plays
2. **Browser voices** — browser's speechSynthesis API (unchanged)

## Research Findings

### Format Support

| Format | Extension | Codec | File Size (5s speech) | Browser Support |
|--------|-----------|-------|-----------------------|-----------------|
| **M4A (AAC)** | `.m4a` | AAC | **28-48 KB** | All browsers |
| AIFF | `.aiff` | PCM | 162 KB | Safari only |
| WAV | `.wav` | PCM | 123 KB | All browsers |

**Recommendation: M4A with AAC codec.** Smallest file size, universal browser support, native `say` output.

### Render Speed vs Playback Duration

Rendering is **3-4x faster than realtime**:

| Text Length | Playback Duration | Render Time | Speedup |
|-------------|-------------------|-------------|---------|
| Short (6 words) | 1.3s | 1.5s | 0.8x (overhead dominates) |
| Medium (25 words) | 6.5s | 2.8s | 2.3x |
| Long (70 words) | 18.8s | 5.5s | 3.4x |

### Latency

For a medium sentence (25 words, 6.5s playback):
- **Before (direct `say`):** audio starts immediately, plays on Mac speakers only
- **After (render + browser):** ~2.8s render delay, then audio plays in browser (any device)

## Implementation Plan

### Phase 1: Render-to-File Function + Serving Endpoint

**File: `src/unified-server.ts`**

1. Add a `renderTtsToFile(text, rate)` function:
   - Generate a unique filename: `/tmp/mcp-voice-hooks-tts-{uuid}.m4a`
   - Use `execFile('say', ['-r', String(rate), '-o', filepath, '--data-format=aac', text])` — avoids shell injection by passing args as array
   - Validate `rate` is a number clamped to range 50-500
   - Return `{ filePath, audioId }`
   - Track rendered files in a `Map<string, { filePath: string, createdAt: number }>` for cleanup
   - Keep `ttsCurrentProcess` tracking on the `say -o` child process so `clearTtsQueue()` can abort in-flight renders

2. Add `GET /api/tts-audio/:id` endpoint:
   - Look up file path from the rendered files map
   - Serve the M4A file with `Content-Type: audio/mp4`
   - Return 404 if file not found or expired

### Phase 2: Rewrite TTS Queue (Render + Notify)

**File: `src/unified-server.ts`**

3. Rewrite `processTtsQueue()`:
   - **Render:** Call `renderTtsToFile(text, rate)` to produce the M4A file
   - **Notify:** Send SSE event to browser: `{ type: "tts-audio", audioUrl: "/api/tts-audio/{id}", sessionKey: <key> }` — include the session key captured at enqueue time so audio is routed to the correct SSE viewer even if active session changes during render
   - **Resolve:** Resolve the promise with `audioId`
   - **Drain:** Call `processTtsQueue()` again for next item
   - Queue serializes renders to prevent concurrent `say -o` processes overloading CPU
   - Queue items include `sessionKey` captured at enqueue time for correct SSE routing

4. Update `clearTtsQueue()`:
   - Kill any running `say -o` render process via `ttsCurrentProcess`
   - Reject pending queue items
   - Clean up rendered files for cleared items
   - Send SSE event to browser: `{ type: "tts-clear" }` — tells browser to call `clearAudioQueue()` and stop any currently playing audio

### Phase 3: Update `/api/speak` — Always Text, Conditionally Audio

**File: `src/unified-server.ts`**

5. Add `selectedVoice` to `voicePreferences` on the server:
   - Add `selectedVoice: string` to the existing `voicePreferences` object (default: `'browser'`)
   - Browser syncs this via the existing voice preferences API pattern. Add to `POST /api/voice-responses` or create `POST /api/selected-voice` endpoint
   - This is a global setting — same scope as existing `voiceResponsesEnabled`

6. Update `POST /api/speak`:
   - After whitelist/session checks:
   - **Always:** call `notifyTTSClients(text)` to send `{ type: "speak", text }` SSE — this is immediate, for conversation display and browser TTS
   - **Always:** store assistant message in conversation history, mark utterances responded
   - **If `selectedVoice === 'system'`:** ALSO call `enqueueTts(text, rate, sessionKey)` — this triggers async render + SSE `tts-audio` event after render completes. The speak endpoint does NOT await the render — it returns immediately. The audio SSE arrives later.
   - **If `selectedVoice !== 'system'`:** nothing extra — browser handles TTS from the text event

7. Update `POST /api/speak-system`:
   - Keep this endpoint for browser-initiated system voice requests (e.g., test TTS button)
   - Response: `{ success: true, audioUrl: "/api/tts-audio/{id}" }`

### Phase 4: Browser Playback Queue

**File: `public/app.js`**

8. Add client-side audio playback queue to `MessengerClient`:
   - `audioQueue: []` — array of audio URLs to play
   - `audioPlaying: false` — flag
   - `currentAudio: null` — reference to currently playing Audio element
   - `processAudioQueue()` method:
     - If `audioPlaying` or queue empty, return
     - Set `audioPlaying = true`
     - Shift next URL from queue
     - Create `new Audio(url)`, store as `currentAudio`, call `.play()`:
       - Handle `play()` promise rejection (autoplay restrictions): set `audioPlaying = false`, log warning, call `processAudioQueue()` to skip to next
     - On `ended` event: set `audioPlaying = false`, set `currentAudio = null`, call `processAudioQueue()`
     - On `error` event: set `audioPlaying = false`, set `currentAudio = null`, log warning, call `processAudioQueue()`

9. Add `clearAudioQueue()` method:
   - Clear the `audioQueue` array
   - If `currentAudio`, pause it and set to null
   - Set `audioPlaying = false`

10. Update SSE handler in `initializeTTSEvents()`:
    - On `{ type: "speak", text }`:
      - If `selectedVoice === 'system'`: display text in conversation only, do NOT call `speakText()` — audio will arrive via separate `tts-audio` event
      - If `selectedVoice !== 'system'`: call `speakText(text)` as before (browser TTS)
    - On `{ type: "tts-audio", audioUrl }`: push URL to `audioQueue`, call `processAudioQueue()`
    - On `{ type: "tts-clear" }`: call `clearAudioQueue()` to stop playback and discard queued audio

11. Update `speakText()` system voice branch:
    - Keep for browser-initiated system voice calls (e.g., test TTS button)
    - Call `/api/speak-system`, check `response.ok`, read `audioUrl` from JSON response, push to `audioQueue`, call `processAudioQueue()`

12. Sync `selectedVoice` to server when voice dropdown changes:
    - On voice change, POST to server with the new voice selection
    - This tells the server whether to render audio on speak calls

### Phase 5: File Cleanup

**File: `src/unified-server.ts`**

13. File cleanup strategy:
    - Run a periodic sweep every 5 minutes to delete files older than 10 minutes from the rendered files map
    - 10-minute TTL is generous — typical render-to-playback cycle is seconds, but handles edge cases (tab backgrounded, mobile autoplay gating, multiple queued items with long playback)
    - On server shutdown, clean up all `/tmp/mcp-voice-hooks-tts-*` files
    - Temp file deletion in `renderTtsToFile` error path should be in `finally` block

### Phase 6: Mirror in Test Server

**File: `src/test-utils/test-server.ts`**

14. Mock the new behavior:
    - `renderTtsToFile` is a no-op that returns a fake path/id
    - `GET /api/tts-audio/:id` returns an empty buffer with `Content-Type: audio/mp4`
    - speak-system response includes `audioUrl` field
    - Update existing tests in `speak-endpoint.test.ts` that assert JSON body for `/api/speak-system` — rewrite to assert new response shape

## API Changes

### Modified: `POST /api/speak`

No response change. Behavior change: always sends `{ type: "speak", text }` SSE immediately. When system voice selected, also enqueues async render that sends `{ type: "tts-audio", audioUrl }` SSE after completion.

### Modified: `POST /api/speak-system`

Before:
```json
{ "success": true, "message": "Text spoken successfully via system voice" }
```

After:
```json
{ "success": true, "audioUrl": "/api/tts-audio/abc-123" }
```

### New: `GET /api/tts-audio/:id`

- Returns the rendered M4A audio file
- Content-Type: `audio/mp4`
- 404 if file not found or expired

### New: `POST /api/selected-voice` (or extend existing voice preferences endpoint)

- Request: `{ selectedVoice: "system" }` or `{ selectedVoice: "browser:3" }`
- Server stores in `voicePreferences.selectedVoice`

### Modified: SSE `tts-events`

New event types:
```
data: {"type":"tts-audio","audioUrl":"/api/tts-audio/abc-123","sessionKey":"..."}
data: {"type":"tts-clear"}
```

Existing event type (always sent, unchanged):
```
data: {"type":"speak","text":"Hello world","sessionKey":"..."}
```

## End-to-End Flow

```
Agent calls MCP speak tool
  |
  v
POST /api/speak { text: "Hello" }
  |
  +-- marks utterances responded, stores assistant message
  |
  +-- ALWAYS: notifyTTSClients("Hello")
  |     -> SSE: { type: "speak", text: "Hello" }     (immediate)
  |     -> Browser displays text in conversation
  |     -> If browser voice: speakText("Hello") via speechSynthesis
  |     -> If system voice: ignores for TTS, waits for tts-audio
  |
  +-- IF system voice selected:
  |     enqueueTts("Hello", rate, sessionKey)          (async, non-blocking)
  |       |
  |       processTtsQueue():
  |         +-- execFile('say', ['-r','200','-o','/tmp/tts-{id}.m4a','--data-format=aac','Hello'])
  |         +-- SSE: { type: "tts-audio", audioUrl }  (after ~1.5-5s render)
  |         +-- resolve(audioId)
  |         +-- processTtsQueue()                      (drain next)
  |
  v
Response: { success: true, respondedCount: N }         (returns immediately, doesn't wait for render)

Browser (system voice path, after tts-audio SSE arrives):
  |
  +-- push audioUrl to playback queue
  +-- processAudioQueue():
        +-- new Audio("/api/tts-audio/{id}").play().catch(skip)
        +-- GET /api/tts-audio/{id}                    (downloads M4A)
        +-- on ended: processAudioQueue()              (drain next)
```

## Improvements from Codex Review (retained)

1. **Command injection fix:** `execFile` with args array instead of shell string interpolation. Rate clamped and validated.
2. **Process tracking:** `ttsCurrentProcess` tracks `say -o` render process for abort on queue clear.
3. **play() promise rejection:** Browser handles autoplay restrictions gracefully.
4. **clearAudioQueue():** Browser-side queue clear triggered by server SSE `tts-clear` event.
5. **response.ok check:** Browser checks response status before processing speak-system responses.
6. **Session identity:** Queue items capture `sessionKey` at enqueue time for correct SSE routing.
7. **Test migration:** `speak-endpoint.test.ts` tests updated for new response shape.

## What Changes for the User

- "Mac System Voice" now plays through their browser instead of Mac speakers
- Audio works on any device with the browser open (Mac, phone, tablet)
- ~1.5-3s delay before audio starts (render time), but text appears immediately
- Same Mac voice quality — it's the same `say` engine, just rendered to file
- Browser TTS voices are completely unaffected
