#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { replaceVoiceHooks, areHooksEqual, removeVoiceHooks } from '../dist/hook-merger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main entry point for npx mcp-voice-hooks
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    if (command === '--version' || command === '-v') {
      // Read package.json to get version
      const packageJsonPath = path.join(__dirname, '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      console.log(packageJson.version);
    } else if (command === 'install-hooks') {
      console.log('🔧 Installing MCP Voice Hooks...');

      // Configure Claude Code settings automatically
      await configureClaudeCodeSettings();

      console.log('\n✅ Installation complete!');
      console.log('📝 To add the server to Claude Code, run: `claude mcp add voice-hooks npx mcp-voice-hooks@latest`');
    } else if (command === 'uninstall') {
      console.log('🗑️  Uninstalling MCP Voice Hooks...');
      await uninstall();
    } else {
      // Default behavior: ensure hooks are installed/updated, then run the MCP server
      console.log('🎤 MCP Voice Hooks - Starting server...');

      // Skip hook installation if --skip-hooks flag is present (used by plugin mode)
      const skipHooks = args.includes('--skip-hooks');
      if (!skipHooks) {
        // Auto-install/update hooks on every startup
        await ensureHooksInstalled();
      } else {
        console.log('ℹ️  Skipping hook installation (plugin mode)');
      }

      console.log('');
      await runMCPServer();
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}


// Automatically configure Claude Code settings
async function configureClaudeCodeSettings() {
  const claudeDir = path.join(process.cwd(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  // This was used in versions <= v1.0.21.
  const oldSettingsPath = path.join(claudeDir, 'settings.json');

  console.log('⚙️  Configuring project Claude Code settings...');

  // Create .claude directory if it doesn't exist
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    console.log('✅ Created project .claude directory');
  }

  // Clean up old settings.json if it exists (for users upgrading from older versions)
  if (fs.existsSync(oldSettingsPath)) {
    try {
      console.log('🔄 Found old settings.json, cleaning up voice hooks...');
      const oldSettingsContent = fs.readFileSync(oldSettingsPath, 'utf8');
      const oldSettings = JSON.parse(oldSettingsContent);

      if (oldSettings.hooks) {
        // Remove voice hooks from old settings
        const cleanedHooks = removeVoiceHooks(oldSettings.hooks);

        if (Object.keys(cleanedHooks).length === 0) {
          delete oldSettings.hooks;
        } else {
          oldSettings.hooks = cleanedHooks;
        }

        // Write back cleaned settings
        fs.writeFileSync(oldSettingsPath, JSON.stringify(oldSettings, null, 2));
        console.log('✅ Cleaned up voice hooks from old settings.json');
      }
    } catch (error) {
      console.log('⚠️  Could not clean up old settings.json:', error.message);
    }
  }

  // Read existing settings or create new
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const settingsContent = fs.readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(settingsContent);
      console.log('📖 Read existing settings');
    } catch (error) {
      console.log('⚠️  Error reading existing settings, creating new');
      settings = {};
    }
  }

  // Load hook configuration from plugin/hooks/hooks.json
  const hooksJsonPath = path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json');
  const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const hookConfig = hooksJson.hooks;

  // Replace voice hooks intelligently
  const updatedHooks = replaceVoiceHooks(settings.hooks || {}, hookConfig);

  // Check if hooks actually changed (ignoring order)
  if (areHooksEqual(settings.hooks || {}, updatedHooks)) {
    console.log('✅ Claude settings already up to date');
    return;
  }

  // Update settings with new hooks
  settings.hooks = updatedHooks;

  // Write settings back
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✅ Updated project Claude Code settings');
}

// Silent hook installation check - runs on every startup
async function ensureHooksInstalled() {
  try {
    console.log('🔄 Updating hooks to latest version...');

    // Update hooks configuration in settings.json
    await configureClaudeCodeSettings();
    console.log('✅ Hooks and settings updated');
  } catch (error) {
    // Silently continue if hooks can't be updated
    console.warn('⚠️  Could not auto-update hooks:', error.message);
  }
}

// Run the MCP server
async function runMCPServer() {
  const serverPath = path.join(__dirname, '..', 'dist', 'unified-server.js');

  // Build server arguments
  const serverArgs = ['--mcp-managed'];
  const args = process.argv.slice(2);
  if (args.includes('--debug') || args.includes('-d')) {
    serverArgs.push('--debug');
  }

  // Pass legacy UI flag to server via environment variable
  if (args.includes('--legacy-ui')) {
    process.env.MCP_VOICE_HOOKS_LEGACY_UI = 'true';
  }

  // Run the compiled JavaScript server
  const child = spawn('node', [serverPath, ...serverArgs], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });

  child.on('error', (error) => {
    console.error('❌ Failed to start MCP server:', error.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    console.log(`🔄 MCP server exited with code ${code}`);
    process.exit(code);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    child.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    child.kill('SIGTERM');
  });
}

// Uninstall MCP Voice Hooks
async function uninstall() {
  const claudeDir = path.join(process.cwd(), '.claude');
  const settingsLocalPath = path.join(claudeDir, 'settings.local.json');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Helper function to remove hooks from a settings file
  async function removeHooksFromFile(filePath, fileName) {
    if (fs.existsSync(filePath)) {
      try {
        console.log(`⚙️  Removing voice hooks from ${fileName}...`);

        const settingsContent = fs.readFileSync(filePath, 'utf8');
        const settings = JSON.parse(settingsContent);

        if (settings.hooks) {
          // Remove voice hooks
          const cleanedHooks = removeVoiceHooks(settings.hooks);

          if (Object.keys(cleanedHooks).length === 0) {
            // If no hooks remain, remove the hooks property entirely
            delete settings.hooks;
          } else {
            settings.hooks = cleanedHooks;
          }

          // Write updated settings
          fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
          console.log(`✅ Removed voice hooks from ${fileName}`);
        } else {
          console.log(`ℹ️  No hooks found in ${fileName}`);
        }
      } catch (error) {
        console.log(`⚠️  Could not update ${fileName}:`, error.message);
      }
    }
  }

  // Remove hooks from both settings.local.json and settings.json (for backwards compatibility)
  await removeHooksFromFile(settingsLocalPath, 'settings.local.json');
  await removeHooksFromFile(settingsPath, 'settings.json');

  if (!fs.existsSync(settingsLocalPath) && !fs.existsSync(settingsPath)) {
    console.log('ℹ️  No Claude settings files found in current project');
  }

  console.log('\n✅ Uninstallation complete!');
  console.log('👋 MCP Voice Hooks has been removed.');
}

// Run the main function
main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});