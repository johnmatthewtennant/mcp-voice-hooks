# Voice Mode for Claude Code

Voice Mode for Claude Code allows you to have a continuous two-way conversation with Claude Code, hands-free.

It uses the new [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to deliver voice input to Claude while it works.

This lets you speak continuously to Claude - interrupt, redirect, or provide feedback without stopping what Claude is doing.

Optionally enable text-to-speech to have Claude speak back to you.

Voice recognition and text-to-speech are handled by the browser, so there is nothing to download, and no API keys are needed.

## Demo Video

[![Demo Video](https://img.youtube.com/vi/GbDatJtm8_k/0.jpg)](https://youtu.be/GbDatJtm8_k)

## Installation

Installation is easy.

### 1. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Install Voice Mode

```bash
npx mcp-voice-hooks@latest install-hooks
claude mcp add voice-hooks npx mcp-voice-hooks@latest
```

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

## Manual Hook Installation

The hooks are automatically installed/updated when the MCP server starts. However, if you need to manually install or reconfigure the hooks:

```bash
npx mcp-voice-hooks install-hooks
```

This will configure your project's `.claude/settings.local.json` with the necessary hook commands.

## Uninstallation

To completely remove MCP Voice Hooks:

```bash
# Remove from Claude MCP servers
claude mcp remove voice-hooks
```

```bash
# Also remove hooks and settings
npx mcp-voice-hooks uninstall
```

This will:

- Clean up voice hooks from your project's `.claude/settings.local.json`
- Preserve any custom hooks you've added

## Development Mode

If you're developing mcp-voice-hooks itself:

```bash
# 1. Clone the repository
git clone https://github.com/johnmatthewtennant/mcp-voice-hooks.git
cd mcp-voice-hooks

# 2. Install dependencies
npm install

# 3. Link the package locally
npm link

# 4. Install hooks (one time)
npx mcp-voice-hooks install-hooks

# 5. Start Claude Code
claude
```

**Important**: When developing with `npm link`:

- Claude runs the compiled JavaScript from the `dist` folder, not your TypeScript source
- After making changes to **TypeScript files** (`src/*.ts`), you must run `npm run build`
- For changes to **browser files** (`public/*`), just restart Claude Code
- Then restart Claude Code to use the updated code

### Configuration

#### Port Configuration

The default port is 5111. To use a different port, add to your project's `.claude/settings.local.json`:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_PORT": "8080"
  }
}
```

#### Browser Auto-Open

When running in MCP-managed mode, the browser will automatically open if no frontend connects within 3 seconds. To disable this behavior:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_AUTO_OPEN_BROWSER": "false"
  }
}
```

#### Auto-Deliver Voice Input Before Tools

By default, voice input is not automatically delivered before tool execution to allow for faster tool execution. To enable auto-delivery before tools:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT_BEFORE_TOOLS": "true"
  }
}
```

When auto-delivery before tools is enabled:

- Voice input is automatically delivered before each tool execution
- Tools may be delayed if there's pending voice input
- This ensures voice commands are processed before tools run
- **Note**: This setting only applies when `MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT` is enabled (default)

When auto-delivery before tools is disabled (default):

- Tools will execute immediately without checking for pending voice input
- Voice input will only be processed at the stop hook or post-tool hook
- **Important**: Delivered utterances that require voice responses will still be enforced
- This provides better performance when voice interruption before tools is not needed

#### Auto-Deliver Voice Input (Default)

By default, mcp-voice-hooks automatically delivers voice input to Claude after tool use, before speaking, and before stopping:

- The `dequeue_utterances` and `wait_for_utterance` MCP tools are hidden from Claude
- Voice input is automatically delivered when Claude performs any action
- Claude receives voice input naturally without needing to explicitly call mcp-voice-hooks tools

To disable auto-delivery:

```json
{
  "env": {
    "MCP_VOICE_HOOKS_AUTO_DELIVER_VOICE_INPUT": "false"
  }
}
```

When auto-delivery is disabled:

- The `dequeue_utterances` and `wait_for_utterance` tools become visible
- Hooks no longer automatically process voice input
- Claude will be blocked from making tool calls until it manually dequeues voice input
- This mode is useful for debugging or when you want manual control
