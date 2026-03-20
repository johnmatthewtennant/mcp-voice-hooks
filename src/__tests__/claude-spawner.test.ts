import { spawnClaudeResume, isSessionProcessRunning, killAllManagedProcesses, getManagedProcessCount } from '../claude-spawner.js';
import { type ChildProcess } from 'child_process';

// Mock child_process.spawn
jest.mock('child_process', () => {
  const EventEmitter = require('events');

  function createMockProcess(): ChildProcess {
    const proc = new EventEmitter() as any;
    proc.killed = false;
    proc.pid = Math.floor(Math.random() * 100000);
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn(() => {
      proc.killed = true;
      proc.emit('exit', null, 'SIGTERM');
    });
    return proc;
  }

  return {
    spawn: jest.fn(() => createMockProcess()),
  };
});

// Mock debug module
jest.mock('../debug.js', () => ({
  debugLog: jest.fn(),
}));

const { spawn } = require('child_process');

describe('claude-spawner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    killAllManagedProcesses();
  });

  describe('spawnClaudeResume', () => {
    it('spawns claude with correct arguments', () => {
      const result = spawnClaudeResume({
        sessionId: 'test-session-123',
        prompt: 'Hello Claude',
      });

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--resume', 'test-session-123', '--dangerously-skip-permissions', 'Hello Claude'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        }),
      );
      expect(result.sessionId).toBe('test-session-123');
      expect(result.process).toBeDefined();
      expect(result.process.pid).toBeDefined();
    });

    it('passes working directory when provided', () => {
      spawnClaudeResume({
        sessionId: 'test-session',
        prompt: 'Hello',
        cwd: '/tmp/test-project',
      });

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/tmp/test-project',
        }),
      );
    });

    it('prevents double-spawning for the same session', () => {
      const result1 = spawnClaudeResume({
        sessionId: 'test-session',
        prompt: 'First message',
      });

      const result2 = spawnClaudeResume({
        sessionId: 'test-session',
        prompt: 'Second message',
      });

      // Should only spawn once
      expect(spawn).toHaveBeenCalledTimes(1);
      // Should return the same process
      expect(result2.process).toBe(result1.process);
    });

    it('allows respawning after process exits', () => {
      const result1 = spawnClaudeResume({
        sessionId: 'test-session',
        prompt: 'First message',
      });

      // Simulate process exit
      result1.process.emit('exit', 0, null);

      const result2 = spawnClaudeResume({
        sessionId: 'test-session',
        prompt: 'Second message',
      });

      // Should spawn again
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('allows spawning different sessions concurrently', () => {
      spawnClaudeResume({ sessionId: 'session-1', prompt: 'msg1' });
      spawnClaudeResume({ sessionId: 'session-2', prompt: 'msg2' });

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(getManagedProcessCount()).toBe(2);
    });
  });

  describe('isSessionProcessRunning', () => {
    it('returns false for unknown session', () => {
      expect(isSessionProcessRunning('nonexistent')).toBe(false);
    });

    it('returns true for running session', () => {
      spawnClaudeResume({ sessionId: 'running-session', prompt: 'test' });
      expect(isSessionProcessRunning('running-session')).toBe(true);
    });

    it('returns false after process exits', () => {
      const result = spawnClaudeResume({ sessionId: 'exiting-session', prompt: 'test' });
      result.process.emit('exit', 0, null);
      expect(isSessionProcessRunning('exiting-session')).toBe(false);
    });
  });

  describe('killAllManagedProcesses', () => {
    it('kills all running processes', () => {
      const r1 = spawnClaudeResume({ sessionId: 's1', prompt: 'test' });
      const r2 = spawnClaudeResume({ sessionId: 's2', prompt: 'test' });

      killAllManagedProcesses();

      expect(r1.process.kill).toHaveBeenCalledWith('SIGTERM');
      expect(r2.process.kill).toHaveBeenCalledWith('SIGTERM');
      expect(getManagedProcessCount()).toBe(0);
    });
  });

  describe('getManagedProcessCount', () => {
    it('returns 0 when no processes', () => {
      expect(getManagedProcessCount()).toBe(0);
    });

    it('tracks process count correctly', () => {
      spawnClaudeResume({ sessionId: 's1', prompt: 'test' });
      expect(getManagedProcessCount()).toBe(1);

      spawnClaudeResume({ sessionId: 's2', prompt: 'test' });
      expect(getManagedProcessCount()).toBe(2);
    });
  });
});
