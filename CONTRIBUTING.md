# Contributing to MCP Voice Hooks

## Local Development

1. Clone and install:
   ```bash
   git clone https://github.com/johnmatthewtennant/mcp-voice-hooks.git
   cd mcp-voice-hooks
   npm install
   npm link
   npx mcp-voice-hooks install-hooks
   ```

2. Start developing:
   ```bash
   npm run build  # After changing TypeScript files
   claude         # Restart to test changes
   ```

**Important**: Claude runs compiled JavaScript from `dist/`, not TypeScript source. Run `npm run build` after changing `.ts` files. Browser files (`public/*`) just need Claude restart.

## Dev Plugin Marketplace

For plugin development, use the dev marketplace instead of the production one. This lets you test hook and plugin changes without publishing to npm.

### How the plugin works

The plugin has two separate systems with different update paths:

1. **Hooks** — Defined in `plugin/hooks/hooks.json`. These are copied to `~/.claude/plugins/cache/mcp-voice-hooks-dev-marketplace/` and loaded at Claude Code session start. Changes to hooks.json are synced to the cache automatically but require a Claude Code restart to take effect (hooks are captured at startup).

2. **Server** — The MCP server binary at `dist/unified-server.js`. The plugin launches the server via `npx mcp-voice-hooks`, which uses the **npx cache** (`~/.npm/_npx/`), NOT your local build. `npm link` alone may not be enough since npx has its own resolution.

### Setting up the dev plugin

Add to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "mcp-voice-hooks-dev-marketplace": {
      "source": {
        "source": "local",
        "path": "/path/to/your/mcp-voice-hooks"
      }
    }
  },
  "enabledPlugins": {
    "mcp-voice-hooks-dev-plugin@mcp-voice-hooks-dev-marketplace": true,
    "mcp-voice-hooks-plugin@mcp-voice-hooks-marketplace": false
  }
}
```

Disable the production plugin when using the dev one.

### Running your local server code

After `npm link`, the global `mcp-voice-hooks` command points to your local repo. Restart Claude Code after building to run your local server code.

### Verifying your local code is running

The server writes a startup log to `/tmp/mcp-voice-hooks.log` with the git commit hash:

```bash
cat /tmp/mcp-voice-hooks.log
# [2026-03-12T04:05:44.753Z] mcp-voice-hooks started: git=940517e port=5111 mode=mcp features=[subagent-detection]
```

Compare the git hash to your local HEAD to confirm the right version is running.

### Development workflow

```bash
# 1. Make changes to TypeScript files
vim src/unified-server.ts

# 2. Build
npm run build

# 3. Run tests
npm test

# 4. Restart Claude Code to pick up changes
# (hooks changes require restart; server changes require restart if not symlinked)
```

## Debug Mode

Enable debug logging to see detailed server output:

```bash
npx mcp-voice-hooks --debug
# or
npx mcp-voice-hooks -d
```

This is useful for troubleshooting issues during development.

## Release

```bash
npm run release  # Bumps version, syncs plugins, pushes with tags
```

For minor/major versions:
```bash
npm version minor && git push --follow-tags
npm version major && git push --follow-tags
```
