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

console.log('✓ Plugin versions synced successfully');
