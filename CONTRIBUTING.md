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

## Release

```bash
npm run release  # Bumps version, syncs plugins, pushes with tags
```

For minor/major versions:
```bash
npm version minor && git push --follow-tags
npm version major && git push --follow-tags
```
