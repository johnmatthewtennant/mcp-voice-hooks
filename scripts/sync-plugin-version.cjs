#!/usr/bin/env node

/**
 * Syncs the plugin version with package.json version
 * This script is automatically run by npm during the version bump process
 */

const fs = require('fs');
const path = require('path');

// Read package.json version
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

console.log(`Syncing plugin version to ${version}...`);

// Update plugin/.claude-plugin/plugin.json
const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
if (fs.existsSync(pluginJsonPath)) {
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  pluginJson.version = version;
  fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n');
  console.log(`✓ Updated plugin/.claude-plugin/plugin.json to version ${version}`);
} else {
  console.warn('⚠ Warning: plugin/.claude-plugin/plugin.json not found');
}

// Update dev-marketplace/dev-plugin/.claude-plugin/plugin.json
const devPluginJsonPath = path.join(__dirname, '..', 'dev-marketplace', 'dev-plugin', '.claude-plugin', 'plugin.json');
if (fs.existsSync(devPluginJsonPath)) {
  const devPluginJson = JSON.parse(fs.readFileSync(devPluginJsonPath, 'utf8'));
  devPluginJson.version = version;
  fs.writeFileSync(devPluginJsonPath, JSON.stringify(devPluginJson, null, 2) + '\n');
  console.log(`✓ Updated dev-marketplace/dev-plugin/.claude-plugin/plugin.json to version ${version}`);
} else {
  console.warn('⚠ Warning: dev-marketplace/dev-plugin/.claude-plugin/plugin.json not found');
}

// Update the pinned server version in plugin/.mcp.json
//
// The plugin is installed from git but launches the server from npm, so an unpinned
// `npx mcp-voice-hooks` runs whatever is latest on the registry — code that is not the
// code someone reviewed in this repo before enabling the plugin. The pin closes that gap,
// which means it has to move with every release or the plugin freezes on an old server.
const pluginMcpJsonPath = path.join(__dirname, '..', 'plugin', '.mcp.json');
if (fs.existsSync(pluginMcpJsonPath)) {
  const pluginMcpJson = JSON.parse(fs.readFileSync(pluginMcpJsonPath, 'utf8'));
  const args = pluginMcpJson.mcpServers?.['voice-hooks']?.args;
  const pkgArgIndex = args?.findIndex((a) => a === 'mcp-voice-hooks' || a.startsWith('mcp-voice-hooks@'));
  if (pkgArgIndex >= 0) {
    args[pkgArgIndex] = `mcp-voice-hooks@${version}`;
    fs.writeFileSync(pluginMcpJsonPath, JSON.stringify(pluginMcpJson, null, 2) + '\n');
    console.log(`✓ Pinned plugin/.mcp.json server to mcp-voice-hooks@${version}`);
  } else {
    console.warn('⚠ Warning: could not find the mcp-voice-hooks arg in plugin/.mcp.json');
  }
} else {
  console.warn('⚠ Warning: plugin/.mcp.json not found');
}

console.log('✓ Plugin versions synced successfully');
