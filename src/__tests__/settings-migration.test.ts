import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

describe('Settings Migration', () => {
  const testDir = path.join(process.cwd(), 'test-project');
  const claudeDir = path.join(testDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settingsLocalPath = path.join(claudeDir, 'settings.local.json');
  const cliPath = path.join(process.cwd(), 'bin', 'cli.js');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up after tests
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('install-hooks', () => {
    it('should create settings.local.json when no settings exist', () => {
      // Run install-hooks
      execSync(`node ${cliPath} install-hooks`, { cwd: testDir });

      // Check that settings.local.json was created
      expect(fs.existsSync(settingsLocalPath)).toBe(true);
      expect(fs.existsSync(settingsPath)).toBe(false);

      // Verify hooks were added
      const settings = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
    });

    it('should migrate hooks from settings.json to settings.local.json', () => {
      // Create old settings.json with voice hooks and custom hooks
      fs.mkdirSync(claudeDir, { recursive: true });
      const oldSettings = {
        hooks: {
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }],
          PreToolUse: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: "echo 'custom hook'"  // This is a custom hook, not a voice hook
            }]
          }, {
            matcher: "^(?!mcp__voice-hooks__).*",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/pre-tool\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }]
        }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(oldSettings, null, 2));

      // Run install-hooks
      execSync(`node ${cliPath} install-hooks`, { cwd: testDir });

      // Check that voice hooks were removed from settings.json, but custom hooks remain
      const cleanedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(cleanedSettings.hooks?.Stop).toBeUndefined(); // Voice hooks removed
      expect(cleanedSettings.hooks?.PreToolUse).toBeDefined(); // Custom hook remains
      expect(cleanedSettings.hooks.PreToolUse.length).toBe(1);
      expect(cleanedSettings.hooks.PreToolUse[0].hooks[0].command).toBe("echo 'custom hook'");

      // Check that settings.local.json has the voice hooks
      const newSettings = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      expect(newSettings.hooks).toBeDefined();
      expect(newSettings.hooks.Stop).toBeDefined();
      expect(newSettings.hooks.PreToolUse).toBeDefined();
      expect(newSettings.hooks.PostToolUse).toBeDefined();
    });

    it('should preserve custom hooks in settings.json when migrating', () => {
      // Create old settings.json with mixed hooks
      fs.mkdirSync(claudeDir, { recursive: true });
      const oldSettings = {
        hooks: {
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }],
          PreToolUse: [{
            matcher: "^custom-tool$",
            hooks: [{
              type: "command",
              command: "echo 'custom hook'"
            }]
          }, {
            matcher: "^(?!mcp__voice-hooks__).*",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/pre-tool\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }]
        }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(oldSettings, null, 2));

      // Run install-hooks
      execSync(`node ${cliPath} install-hooks`, { cwd: testDir });

      // Check that custom hooks remain in settings.json
      const cleanedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(cleanedSettings.hooks.PreToolUse).toBeDefined();
      expect(cleanedSettings.hooks.PreToolUse.length).toBe(1);
      expect(cleanedSettings.hooks.PreToolUse[0].matcher).toBe("^custom-tool$");
      expect(cleanedSettings.hooks.Stop).toBeUndefined(); // Voice hooks removed
    });

    it('should update existing settings.local.json hooks', () => {
      // Create existing settings.local.json with outdated voice hooks
      fs.mkdirSync(claudeDir, { recursive: true });
      const existingSettings = {
        env: { PORT: "3000" },
        hooks: {
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop\" || echo 'old version'"
            }]
          }]
        }
      };
      fs.writeFileSync(settingsLocalPath, JSON.stringify(existingSettings, null, 2));

      // Run install-hooks
      execSync(`node ${cliPath} install-hooks`, { cwd: testDir });

      // Check that settings were updated
      const updatedSettings = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      expect(updatedSettings.env.PORT).toBe("3000"); // Preserved
      expect(updatedSettings.hooks.Stop[0].hooks[0].command).toContain("voice-hooks not running"); // Updated to new version
      expect(updatedSettings.hooks.PreToolUse).toBeDefined(); // Added
      expect(updatedSettings.hooks.PostToolUse).toBeDefined(); // Added
    });
  });

  describe('uninstall', () => {
    it('should remove hooks from both settings files', () => {
      // Create both settings files with voice hooks
      fs.mkdirSync(claudeDir, { recursive: true });

      // settings.json with voice hooks
      const settings = {
        hooks: {
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }]
        }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      // settings.local.json with voice hooks
      const settingsLocal = {
        env: { PORT: "3000" },
        hooks: {
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }],
          PreToolUse: [{
            matcher: "^(?!mcp__voice-hooks__).*",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/pre-tool\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }]
        }
      };
      fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2));

      // Run uninstall
      execSync(`node ${cliPath} uninstall`, { cwd: testDir });

      // Check that hooks were removed from both files
      const cleanedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(cleanedSettings.hooks).toBeUndefined();

      const cleanedSettingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      expect(cleanedSettingsLocal.env.PORT).toBe("3000"); // Preserved
      expect(cleanedSettingsLocal.hooks).toBeUndefined(); // Removed
    });

    it('should handle missing settings files gracefully', () => {
      // Run uninstall without any settings files
      const output = execSync(`node ${cliPath} uninstall`, {
        cwd: testDir,
        encoding: 'utf8'
      });

      // Should complete without errors
      expect(output).toContain('No Claude settings files found');
      expect(output).toContain('Uninstallation complete');
    });

    it('should preserve custom hooks during uninstall', () => {
      // Create settings with mixed hooks
      fs.mkdirSync(claudeDir, { recursive: true });
      const settings = {
        hooks: {
          PreToolUse: [{
            matcher: "^custom-tool$",
            hooks: [{
              type: "command",
              command: "echo 'custom hook'"
            }]
          }, {
            matcher: "^(?!mcp__voice-hooks__).*",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/pre-tool\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }],
          Stop: [{
            matcher: "",
            hooks: [{
              type: "command",
              command: "curl -s -X POST \"http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop\" || echo '{\"decision\": \"approve\", \"reason\": \"voice-hooks not running\"}'"
            }]
          }]
        }
      };
      fs.writeFileSync(settingsLocalPath, JSON.stringify(settings, null, 2));

      // Run uninstall
      execSync(`node ${cliPath} uninstall`, { cwd: testDir });

      // Check that only custom hooks remain
      const cleanedSettings = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      expect(cleanedSettings.hooks.PreToolUse).toBeDefined();
      expect(cleanedSettings.hooks.PreToolUse.length).toBe(1);
      expect(cleanedSettings.hooks.PreToolUse[0].matcher).toBe("^custom-tool$");
      expect(cleanedSettings.hooks.Stop).toBeUndefined();
    });
  });
});