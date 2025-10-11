import { removeVoiceHooks, replaceVoiceHooks, areHooksEqual, HookSettings } from '../hook-merger';

describe('Hook Management', () => {
  const voiceHooks: HookSettings = {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: 'curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop" || echo \'{"decision": "approve", "reason": "voice-hooks not running"}\'',
          },
        ],
      },
    ],
  };

  describe('removeVoiceHooks', () => {
    it('should remove hooks that use MCP_VOICE_HOOKS_PORT', () => {
      const existing: HookSettings = {
        Stop: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: 'curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop" || echo \'{"decision": "approve", "reason": "voice-hooks not running"}\'',
              },
            ],
          },
          {
            matcher: 'custom',
            hooks: [
              {
                type: 'command',
                command: 'custom-stop.sh',
              },
            ],
          },
        ],
      };

      const result = removeVoiceHooks(existing);

      expect(result.Stop).toHaveLength(1);
      expect(result.Stop[0].hooks[0].command).toBe('custom-stop.sh');
    });

    it('should remove entire hook type if all hooks are voice hooks', () => {
      const existing: HookSettings = {
        Stop: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: 'curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop" || echo \'{"decision": "approve", "reason": "voice-hooks not running"}\'',
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: 'custom',
            hooks: [
              {
                type: 'command',
                command: 'custom-pre.sh',
              },
            ],
          },
        ],
      };

      const result = removeVoiceHooks(existing);

      expect(result.Stop).toBeUndefined();
      expect(result.PreToolUse).toHaveLength(1);
    });

    it('should handle empty hooks', () => {
      const result = removeVoiceHooks({});
      expect(result).toEqual({});
    });

    it('should handle undefined hooks', () => {
      const result = removeVoiceHooks(undefined);
      expect(result).toEqual({});
    });
  });

  describe('replaceVoiceHooks', () => {
    it('should remove old voice hooks and add new ones', () => {
      const existing: HookSettings = {
        Stop: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: 'curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/old-stop" || echo \'{"decision": "approve"}\'',
              },
            ],
          },
          {
            matcher: 'custom',
            hooks: [
              {
                type: 'command',
                command: 'custom-stop.sh',
              },
            ],
          },
        ],
      };

      const result = replaceVoiceHooks(existing, voiceHooks);

      // Should have 2 Stop hooks: custom + new voice hook
      expect(result.Stop).toHaveLength(2);
      expect(result.Stop[0].hooks[0].command).toBe('custom-stop.sh');
      expect(result.Stop[1].hooks[0].command).toBe('curl -s -X POST "http://localhost:${MCP_VOICE_HOOKS_PORT:-5111}/api/hooks/stop" || echo \'{"decision": "approve", "reason": "voice-hooks not running"}\'');

      // PreToolUse hook has been removed
    });

    it('should add voice hooks when no existing hooks', () => {
      const result = replaceVoiceHooks({}, voiceHooks);
      expect(result).toEqual(voiceHooks);
    });

    it('should preserve non-voice hooks', () => {
      const existing: HookSettings = {
        Stop: [
          {
            matcher: 'custom',
            hooks: [
              {
                type: 'command',
                command: 'custom-stop-1.sh',
              },
              {
                type: 'command',
                command: 'custom-stop-2.sh',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: 'pattern',
            hooks: [
              {
                type: 'command',
                command: 'post-tool.sh',
              },
            ],
          },
        ],
      };

      const result = replaceVoiceHooks(existing, voiceHooks);

      // Should preserve custom Stop hook and add voice Stop hook
      expect(result.Stop).toHaveLength(2);
      expect(result.Stop[0].matcher).toBe('custom');
      expect(result.Stop[0].hooks).toHaveLength(2);

      // Should preserve PostToolUse
      expect(result.PostToolUse).toEqual(existing.PostToolUse);

      // PreToolUse hook has been removed
    });

    it('should not modify original objects', () => {
      const existing: HookSettings = {
        Stop: [
          {
            matcher: 'test',
            hooks: [{ type: 'command', command: 'test.sh' }],
          },
        ],
      };

      const existingCopy = JSON.parse(JSON.stringify(existing));
      const voiceHooksCopy = JSON.parse(JSON.stringify(voiceHooks));

      replaceVoiceHooks(existing, voiceHooks);

      expect(existing).toEqual(existingCopy);
      expect(voiceHooks).toEqual(voiceHooksCopy);
    });
  });

  describe('areHooksEqual', () => {
    it('should return true for identical hooks', () => {
      const hooks: HookSettings = {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'stop.sh' }],
          },
        ],
      };

      expect(areHooksEqual(hooks, hooks)).toBe(true);
    });

    it('should return true for reordered hooks within same type', () => {
      const hooks1: HookSettings = {
        Stop: [
          { matcher: 'A', hooks: [{ type: 'command', command: 'a.sh' }] },
          { matcher: 'B', hooks: [{ type: 'command', command: 'b.sh' }] },
        ],
      };

      const hooks2: HookSettings = {
        Stop: [
          { matcher: 'B', hooks: [{ type: 'command', command: 'b.sh' }] },
          { matcher: 'A', hooks: [{ type: 'command', command: 'a.sh' }] },
        ],
      };

      expect(areHooksEqual(hooks1, hooks2)).toBe(true);
    });

    it('should return true for reordered hook types', () => {
      const hooks1: HookSettings = {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'stop.sh' }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'post.sh' }] }],
      };

      const hooks2: HookSettings = {
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'post.sh' }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'stop.sh' }] }],
      };

      expect(areHooksEqual(hooks1, hooks2)).toBe(true);
    });

    it('should return false for different hooks', () => {
      const hooks1: HookSettings = {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'stop1.sh' }] }],
      };

      const hooks2: HookSettings = {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'stop2.sh' }] }],
      };

      expect(areHooksEqual(hooks1, hooks2)).toBe(false);
    });

    it('should return false for different number of hooks', () => {
      const hooks1: HookSettings = {
        Stop: [
          { matcher: 'A', hooks: [{ type: 'command', command: 'a.sh' }] },
        ],
      };

      const hooks2: HookSettings = {
        Stop: [
          { matcher: 'A', hooks: [{ type: 'command', command: 'a.sh' }] },
          { matcher: 'B', hooks: [{ type: 'command', command: 'b.sh' }] },
        ],
      };

      expect(areHooksEqual(hooks1, hooks2)).toBe(false);
    });

    it('should handle empty and undefined', () => {
      expect(areHooksEqual({}, {})).toBe(true);
      expect(areHooksEqual(undefined, undefined)).toBe(true);
      expect(areHooksEqual({}, undefined)).toBe(true);
    });
  });
});