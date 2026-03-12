# Plan: Remove Legacy UI

## Goal

Remove the legacy grid-based UI and all associated code. The messenger UI (`index.html` / `app.js`) is the only UI going forward.

## Files to Delete

1. `public/legacy.html` -- old grid-based interface
2. `public/legacy.js` -- old frontend logic

## Files to Modify

### `src/unified-server.ts` (lines 1088-1104)

**Current state:** The `GET /` route checks `MCP_VOICE_HOOKS_LEGACY_UI` env var to decide which HTML file to serve. There's a dedicated `GET /legacy` route and a `GET /messenger` route.

**Changes:**
- Simplify `GET /` to always serve `index.html` (remove the `useLegacyUI` check)
- Remove `GET /legacy` route entirely
- Keep `GET /messenger` route (it still makes sense as an alias for `/`)

**After:**
```typescript
// UI Routing
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/messenger', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
```

### `bin/cli.js` (lines 158-161)

**Current state:** Passes `--legacy-ui` CLI flag as `MCP_VOICE_HOOKS_LEGACY_UI` env var.

**Changes:**
- Remove the `--legacy-ui` flag handling (lines 158-161)

### `src/test-utils/test-server.ts` (lines 655-658)

**Current state:** Has a `GET /legacy` route serving `legacy.html`.

**Changes:**
- Remove the `/legacy` route

### `src/__tests__/ui-routing.test.ts` (lines 27-36)

**Current state:** Has a test for `GET /legacy` route.

**Changes:**
- Remove the `describe('GET /legacy', ...)` block

### `public/index.html`

**Current state:** Has CSS for `.legacy-link` (lines 57-68) and an anchor tag linking to `/legacy` (line 917).

**Changes:**
- Remove `.legacy-link` and `.legacy-link:hover` CSS rules
- Remove the `<a href="/legacy" ...>Switch to Legacy UI</a>` element

### `roadmap.md`

**Current state:** Has several references to legacy UI features (lines 40-42, 111).

**Changes:**
- These are all already marked as `[x]` completed items. No changes needed -- they serve as historical record.

### `docs/plans/2025-11-13-messenger-ui-with-text-input.md`

**Current state:** Historical plan document with many legacy UI references.

**Changes:**
- No changes. This is a historical document.

## Verification

1. `npm run build` -- confirms TypeScript compiles
2. `npx jest --no-coverage` -- confirms all tests pass
3. Manual check: `GET /` serves messenger UI, `GET /messenger` serves messenger UI, `GET /legacy` returns 404

## Risk Assessment

Low risk. The legacy UI has been superseded by the messenger UI for months. The `--legacy-ui` flag and `/legacy` route are convenience fallbacks that are no longer needed.
