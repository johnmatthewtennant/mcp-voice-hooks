# Voice Mode for Claude Code

Voice Mode for Claude Code allows you to have a continuous two-way conversation with Claude Code, hands-free.

It uses the new [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to deliver voice input to Claude while it works.

This lets you speak continuously to Claude - interrupt, redirect, or provide feedback without stopping what Claude is doing.

Optionally enable text-to-speech to have Claude speak back to you.

Voice recognition and text-to-speech are handled by the browser, so there is nothing to download, and no API keys are needed.

## Demo Video

[![Demo Video](https://img.youtube.com/vi/GbDatJtm8_k/0.jpg)](https://youtu.be/GbDatJtm8_k)

## Requirements

- Claude Code 2.1.69 or later (run `claude --version` to check)
- macOS (for system text-to-speech)
- Chrome or Safari (for speech recognition)

## Installation

Installation is easy.

### 1. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Install Voice Mode

Add the following to any Claude Code settings file (`~/.claude/settings.json`, `.claude/settings.json`, or `.claude/settings.local.json`):

```json
{
  "extraKnownMarketplaces": {
    "mcp-voice-hooks-marketplace": {
      "source": {
        "source": "git",
        "url": "https://github.com/johnmatthewtennant/mcp-voice-hooks.git"
      }
    }
  },
  "enabledPlugins": {
    "mcp-voice-hooks-plugin@mcp-voice-hooks-marketplace": true
  }
}
```

Restart Claude Code. Set `"mcp-voice-hooks-plugin@mcp-voice-hooks-marketplace"` to `false` to temporarily disable.

## Usage

### 1. Start Claude Code

```bash
claude
```

### 2. Start Listening

The browser interface will automatically open after 3 seconds (<http://localhost:5111>).

Click "Start Listening"

### 3. Speak

Say something to Claude. You will need to send one message in the Claude Code CLI to start the conversation.

### 4. Trigger Word Mode (Optional)

By default, utterances are sent automatically when you pause. You can switch to "Wait for Trigger Word" mode in the browser interface:

1. Toggle to "Wait for Trigger Word" mode
2. Enter a trigger word (e.g., "send", "claude", "go")
3. Speak your message(s) - they will queue up in the browser
4. Say your trigger word to send all queued messages at once (or click "Send Now")

The trigger word is case-insensitive and will be automatically removed from your message before sending.

## Browser Compatibility

- ✅ **Chrome**: Full support for speech recognition, browser text-to-speech, and system text-to-speech
- ⚠️ **Safari**: Full support for speech recognition and system text-to-speech, but browser text-to-speech cannot load high-quality voices
- ❌ **Edge**: Speech recognition not working on Apple Silicon (language-not-supported error)

## Voice responses

There are two options for voice responses:

1. Browser Text-to-Speech
2. System Text-to-Speech

### Selecting and downloading high quality System Voices (Mac only)

Mac has built-in text to speech, but high quality voices are not available by default.

You can download high quality voices from the system voice menu: `System Settings > Accessibility > Spoken Content > System Voice`

Click the info icon next to the system voice dropdown. Search for "Siri" to find the highest quality voices. You'll have to trigger a download of the voice.

Once it's downloaded, you can select it in the Browser Voice (Local) menu in Chrome.

Test it with the bash command:

```bash
say "Hi, this is your Mac system voice"
```

To use Siri voices with voice-hooks, you need to set your system voice and select "Mac System Voice" in the voice-hooks browser interface.

Other downloaded voices will show up in the voice dropdown in the voice-hooks browser interface so you can select them there directly, instead of using the "Mac System Voice" option.

There is a bug in Safari that prevents browser text-to-speech from loading high-quality voices after browser restart. This is a Safari Web Speech API limitation. To use high-quality voices in Safari you need to set your system voice to Siri and select "Mac System Voice" in the voice-hooks browser interface.

## Known Limitations

- **Background agents don't notify in voice mode.** When Claude launches background agents (via the Agent tool), their completion notifications appear in the conversation text but don't trigger hooks. This means you won't hear a voice notification when a background task finishes. **Workaround:** Manually check background agent status, or avoid using background agents during voice sessions. *(Verified with Claude Code 2.1.69, March 2026)*

## Uninstallation

Remove the `extraKnownMarketplaces` and `enabledPlugins` entries from your settings file and restart Claude Code.

### Alternative: Manual Installation

If you prefer not to use the plugin system, you can install manually:

```bash
npx mcp-voice-hooks@latest install-hooks
claude mcp add voice-hooks npx mcp-voice-hooks@latest
```

To uninstall:

```bash
claude mcp remove voice-hooks
npx mcp-voice-hooks uninstall
```

## Configuration

#### Port Configuration

The default port is 5111. To use a different port, set the `MCP_VOICE_HOOKS_PORT` environment variable in your project's `.claude/settings.local.json`:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_PORT": "8080"
  }
}
```

This environment variable is used by both:

- The MCP server to determine which port to listen on
- The Claude Code hooks to connect to the correct port

**Note**: Setting this in `.claude/settings.local.json` is the recommended approach. The environment variable will be available to both the MCP server process and the hook commands.

#### HTTPS (for access from other devices)

Browsers block microphone access on insecure origins. HTTPS is enabled automatically — the server generates a self-signed certificate on first startup and serves HTTPS on port 5112 (HTTP port + 1).

To access from another device, open `https://<your-hostname>.local:5112` and accept the self-signed certificate warning in the browser.

To customize the HTTPS port:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_HTTPS_PORT": "8443"
  }
}
```

To regenerate the certificate (e.g., after a hostname change), delete the `certs/` directory and restart, or run `./scripts/generate-certs.sh`.

#### Browser Auto-Open

When running in MCP-managed mode, the browser will automatically open if no frontend connects within 3 seconds. To disable this behavior:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER": "false"
  }
}
```
