# Consolidate voiceInputActive and voiceResponsesEnabled into single voiceActive flag

## Overview

The single mic button now toggles both voice input and voice output together. Having separate `voiceInputActive` and `voiceResponsesEnabled` flags in `voicePreferences` is redundant. This plan consolidates them into a single `voiceActive` flag.

## Current State Analysis

The `voicePreferences` object is defined at `src/unified-server.ts:209`:
```ts
let voicePreferences = {
  voiceResponsesEnabled: false,
  voiceInputActive: false,
  selectedVoice: 'browser' as string,
  speechRate: 200 as number
};
```

Both flags are always set together:
- Browser sets both on mic toggle: `public/app.js:800-801` (start) and `public/app.js:830-831` (stop)
- `syncVoiceStateToServer()` at `public/app.js:957-963` syncs both to same `this.isListening` value
- Session reset at `src/unified-server.ts:804-805` sets both to false
- SSE disconnect at `src/unified-server.ts:975-976` sets both to false
- WS disconnect at `src/unified-server.ts:1136-1137` sets both to false

Two separate API endpoints exist:
- `POST /api/voice-preferences` (for voiceResponsesEnabled) at `src/unified-server.ts:1324`
- `POST /api/voice-input-state` (for voiceInputActive) at `src/unified-server.ts:1338`

The test-server mirrors this at `src/test-utils/test-server.ts:162-163` with separate endpoints at lines 543-567.

### Key Discoveries:
- `voiceInputActive` is checked for: utterance dequeuing guards, wait-for-utterance guards, stop hook auto-wait, validate-action pending checks
- `voiceResponsesEnabled` is checked for: speak endpoint guard, voice response reminders, delivered utterance checks in hooks, must-speak-after-tool checks
- Both are always toggled in sync — the browser never sets one without the other
- The `backgroundVoiceEnforcement` feature references `voiceResponsesEnabled` but that's orthogonal

## Desired End State

A single `voiceActive` boolean replaces both `voiceInputActive` and `voiceResponsesEnabled`:
```ts
let voicePreferences = {
  voiceActive: false,
  selectedVoice: 'browser' as string,
  speechRate: 200 as number
};
```

A single API endpoint `POST /api/voice-active` replaces both `/api/voice-preferences` and `/api/voice-input-state`. The old endpoints are removed.

All checks that previously referenced either flag now reference `voiceActive`.

### Verification:
- `npm test` passes
- `grep -r 'voiceInputActive\|voiceResponsesEnabled' src/ public/` returns zero matches (excluding plans/docs)

## Design Decision: Independent Control Intentionally Removed

Independent control of voice input vs voice responses is intentionally removed. The browser UI already treats them as a single toggle (mic button), and no external callers use the separate endpoints. This is an internal API — the browser is the only consumer, and it is updated in the same commit. No backward-compatibility aliases are needed.

## What We're NOT Doing

- Not changing the `backgroundVoiceEnforcement` feature
- Not changing `selectedVoice` or `speechRate`
- Not modifying the browser UI behavior (single mic button already works correctly)
- Not changing hook logic beyond the flag rename
- Not adding backward-compatibility aliases — this is an internal API with a single consumer (the browser UI) updated atomically

---

## Phase 1: Server — unified-server.ts

### Overview
Replace both flags with `voiceActive` in the main server.

### Changes Required:

#### 1. voicePreferences object
**File**: `src/unified-server.ts:209-214`
**Change**: Replace two boolean fields with one.

```ts
let voicePreferences = {
  voiceActive: false,
  selectedVoice: 'browser' as string,
  speechRate: 200 as number
};
```

#### 2. All references to voiceInputActive → voiceActive
Replace every `voicePreferences.voiceInputActive` and `voicePreferences.voiceResponsesEnabled` with `voicePreferences.voiceActive`. Also replace local destructured variables like `const voiceResponsesEnabled = voicePreferences.voiceResponsesEnabled` with `const voiceActive = voicePreferences.voiceActive`.

Key locations in `src/unified-server.ts`:
- Line 238: comment — update text
- Line 453: comment — update text
- Line 484: `voicePreferences.voiceInputActive` → `voicePreferences.voiceActive`
- Line 505: same
- Line 604: `voicePreferences.voiceResponsesEnabled` → `voicePreferences.voiceActive`
- Line 613: `voicePreferences.voiceInputActive` → `voicePreferences.voiceActive`
- Line 626: `voiceResponsesEnabled` → `voiceActive` (local var)
- Line 639: `voicePreferences.voiceInputActive` → `voicePreferences.voiceActive`
- Line 659-660: both local var assignments → single `const voiceActive = voicePreferences.voiceActive`
- Line 682: `voiceResponsesEnabled` → `voiceActive`
- Line 710: same
- Line 719: `voiceInputActive` → `voiceActive`
- Lines 804-805: two assignments → one `voicePreferences.voiceActive = false`
- Lines 973-976: `voiceInputActive || voiceResponsesEnabled` → `voiceActive`, single assignment
- Lines 1135-1137: same pattern
- Line 1343-1349: `/api/voice-input-state` handler → rename to `/api/voice-active`
- Lines 1324-1336: `/api/voice-preferences` handler → replace with `/api/voice-active`
- Line 1418: `voicePreferences.voiceResponsesEnabled` → `voicePreferences.voiceActive`
- Line 1665: `voicePreferences.voiceResponsesEnabled` → `voicePreferences.voiceActive`

#### 3. Consolidate API endpoints
**File**: `src/unified-server.ts:1323-1351`
**Change**: Replace both endpoints with a single `POST /api/voice-active`:

```ts
app.post('/api/voice-active', (req: Request, res: Response) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active must be a boolean' });
    return;
  }
  voicePreferences.voiceActive = active;
  debugLog(`[Voice] ${voicePreferences.voiceActive ? 'Activated' : 'Deactivated'}`);
  res.json({
    success: true,
    voiceActive: voicePreferences.voiceActive
  });
});
```

Remove the old `/api/voice-preferences` POST and `/api/voice-input-state` POST endpoints.

### Success Criteria:
- [ ] No references to `voiceInputActive` or `voiceResponsesEnabled` in `src/unified-server.ts`
- [ ] TypeScript compiles: `npx tsc --noEmit`

---

## Phase 2: Test Server — test-server.ts

### Overview
Mirror the same changes in the test server.

### Changes Required:

#### 1. VoicePreferences interface
**File**: `src/test-utils/test-server.ts:161-166`

```ts
interface VoicePreferences {
  voiceActive: boolean;
  selectedVoice: string;
  speechRate: number;
}
```

#### 2. All references throughout test-server.ts
Replace every `voiceInputActive` and `voiceResponsesEnabled` with `voiceActive`. Key locations:
- Line 208-209: init object
- Line 291-292: session reset → single assignment
- Line 407, 451: dequeue/wait guards
- Line 486: speak guard
- Line 552: voice-input endpoint handler
- Line 565: voice-responses endpoint handler
- Line 646, 659, 672: hook handlers
- Line 770: stop hook check
- Lines 914-915: reset method

#### 3. Consolidate API endpoints
Replace `POST /api/voice-input` and `POST /api/voice-responses` (lines 543-567) with single `POST /api/voice-active`:

```ts
this.app.post('/api/voice-active', (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active must be a boolean' });
    return;
  }
  this.voicePreferences.voiceActive = active;
  res.json({ success: true });
});
```

### Success Criteria:
- [ ] No references to `voiceInputActive` or `voiceResponsesEnabled` in `src/test-utils/test-server.ts`
- [ ] TypeScript compiles

---

## Phase 3: Tests

### Overview
Update all test files to use `voiceActive` and the new `/api/voice-active` endpoint.

### Changes Required:

All 13 test files that reference the old flags must be updated. For each file, replace `voiceInputActive` and `voiceResponsesEnabled` with `voiceActive`, and replace `/api/voice-input` and `/api/voice-responses` endpoints with `/api/voice-active` (body: `{ active: true/false }`). Where tests previously made two separate API calls (one to each endpoint), consolidate into a single call.

#### Files with inline mock objects (replace field names):
1. **`browser-disconnect-unit.test.ts`** — mock object `{ voiceActive: false }`, all assertions updated
2. **`connection-drop-timeout.test.ts`** — type `{ voiceActive: boolean }`, init `{ voiceActive: true }`, two assignments → one
3. **`conversation-flow.test.ts`** — init object, inline references to `voicePreferences.voiceInputActive`. Also rename `process.env.VOICE_RESPONSES_ENABLED` → `process.env.VOICE_ACTIVE` and all local `voiceResponsesEnabled` variables that read from it

#### Files using TestServer (replace endpoint URLs and assertion field names):
4. **`session-restart.test.ts`** — `/api/voice-input` and `/api/voice-responses` → `/api/voice-active`, remove redundant second call, update assertions
5. **`http-server-integration.test.ts`** — endpoint URLs and `getVoicePreferences()` assertions
6. **`voice-input-state.test.ts`** — endpoint URL `/api/voice-input` → `/api/voice-active`, assertion field names
7. **`speak-endpoint.test.ts`** — any references to `voiceResponsesEnabled` or `/api/voice-responses`
8. **`validate-action.test.ts`** — endpoint URLs and field references
9. **`utterance-states.test.ts`** — endpoint URLs and field references
10. **`conversation-api.test.ts`** — endpoint URLs and field references
11. **`session-state.test.ts`** — endpoint URLs and field references
12. **`whitelist-routing.test.ts`** — endpoint URLs and field references
13. **`session-routing-bugs.test.ts`** — endpoint URLs and field references

### Success Criteria:
- [ ] `npm test` passes with all tests green
- [ ] No references to `voiceInputActive` or `voiceResponsesEnabled` in any test files
- [ ] `grep -rn 'voiceInputActive\|voiceResponsesEnabled\|voice-input-state\|/api/voice-input\|/api/voice-responses\|/api/voice-preferences' src/__tests__/` returns zero matches

---

## Phase 4: Browser — public/app.js

### Overview
Consolidate the two browser API calls into one.

### Changes Required:

#### 1. Replace updateVoiceInputState and updateVoiceResponses
**File**: `public/app.js`

Replace both methods with a single `updateVoiceActive`:
```js
async updateVoiceActive(active) {
    try {
        await fetch(`${this.baseUrl}/api/voice-active`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active })
        });
    } catch (error) {
        console.error('Failed to update voice active state:', error);
    }
}
```

#### 2. Update callers
- Line 800-801: Replace two calls with `await this.updateVoiceActive(true)`
- Line 830-831: Replace two calls with `await this.updateVoiceActive(false)`
- Line 957-963: `syncVoiceStateToServer` becomes:
  ```js
  async syncVoiceStateToServer() {
      await this.updateVoiceActive(this.isListening);
      await this.syncSelectedVoiceToServer();
  }
  ```

#### 3. Remove localStorage for voiceResponsesEnabled
- Line 944: Remove `localStorage.setItem('voiceResponsesEnabled', ...)` — no longer needed

#### 4. Remove old methods
Delete `updateVoiceInputState` and `updateVoiceResponses` methods entirely.

### Success Criteria:
- [ ] No references to `voiceInputActive`, `voiceResponsesEnabled`, `updateVoiceInputState`, or `updateVoiceResponses` in `public/app.js`
- [ ] Browser mic toggle works correctly (manual verification by running server)

---

## Testing Strategy

### Automated Tests:
- All existing tests updated to use `voiceActive`
- `npm test` passes with all tests green

### Verification:
```bash
# Ensure no stale references remain
grep -rn 'voiceInputActive\|voiceResponsesEnabled' src/ public/ --include='*.ts' --include='*.js' | grep -v 'node_modules\|dist\|plans\|docs'
```

## References
- Browser mic toggle already syncs both flags: `public/app.js:799-801`, `public/app.js:829-831`
- `syncVoiceStateToServer` proves they're always equal: `public/app.js:957-963`
