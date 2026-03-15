import { SpeechRecognizer } from '../speech-recognition.js';
import path from 'path';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Mock child_process.spawn
jest.mock('child_process', () => {
  const actualModule = jest.requireActual('child_process');
  return {
    ...actualModule,
    spawn: jest.fn(),
  };
});

// Mock fs for binaryExists checks
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    existsSync: jest.fn(),
  };
});

import { spawn } from 'child_process';
import fs from 'fs';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdin = {
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
    destroyed: false,
  };
  // Use a real Readable stream so readline.createInterface works
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.killed = false;
  proc.kill = jest.fn(() => { proc.killed = true; });
  return proc;
}

describe('SpeechRecognizer', () => {
  const repoRoot = '/fake/repo';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('binaryExists', () => {
    it('returns true when binary file exists', () => {
      mockExistsSync.mockReturnValue(true);
      expect(SpeechRecognizer.binaryExists(repoRoot)).toBe(true);
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(repoRoot, 'swift', 'speech-recognizer', '.build', 'release', 'speech-recognizer')
      );
    });

    it('returns false when binary file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(SpeechRecognizer.binaryExists(repoRoot)).toBe(false);
    });
  });

  describe('start', () => {
    it('spawns the speech-recognizer binary', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        path.join(repoRoot, 'swift', 'speech-recognizer', '.build', 'release', 'speech-recognizer'),
        [],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
    });

    it('is a no-op if already running', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();
      recognizer.start(); // second call

      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('reports isRunning correctly', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      expect(recognizer.isRunning).toBe(false);

      recognizer.start();
      expect(recognizer.isRunning).toBe(true);
    });
  });

  describe('feedAudio', () => {
    it('writes buffer to stdin', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();

      const buf = Buffer.alloc(640);
      recognizer.feedAudio(buf);

      expect(proc.stdin.write).toHaveBeenCalledWith(buf);
    });

    it('handles backpressure by dropping frames', () => {
      const proc = createMockProcess();
      proc.stdin.write.mockReturnValue(false); // simulate backpressure
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();

      const buf = Buffer.alloc(640);
      // Should not throw
      recognizer.feedAudio(buf);

      expect(proc.stdin.write).toHaveBeenCalledWith(buf);
    });

    it('is a no-op when process is not running', () => {
      const recognizer = new SpeechRecognizer(repoRoot);
      // Should not throw
      recognizer.feedAudio(Buffer.alloc(640));
    });
  });

  describe('stop', () => {
    it('closes stdin to trigger graceful shutdown', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();
      recognizer.stop();

      expect(proc.stdin.end).toHaveBeenCalled();
    });
  });

  describe('kill', () => {
    it('forcefully kills the process', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();
      recognizer.kill();

      expect(proc.kill).toHaveBeenCalled();
      expect(recognizer.isRunning).toBe(false);
    });
  });

  describe('transcript events', () => {
    it('emits transcript event for interim results', (done) => {
      jest.useRealTimers();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.on('transcript', (result) => {
        expect(result.type).toBe('interim');
        expect(result.text).toBe('hello');
        done();
      });

      recognizer.start();

      // Simulate stdout JSON line
      proc.stdout.emit('data', Buffer.from('{"type":"interim","text":"hello"}\n'));
    });

    it('emits transcript event for final results', (done) => {
      jest.useRealTimers();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.on('transcript', (result) => {
        expect(result.type).toBe('final');
        expect(result.text).toBe('hello world');
        done();
      });

      recognizer.start();

      proc.stdout.emit('data', Buffer.from('{"type":"final","text":"hello world"}\n'));
    });
  });

  describe('error handling', () => {
    it('emits error event on process error', (done) => {
      jest.useRealTimers();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.on('error', (err) => {
        expect(err.message).toBe('spawn error');
        done();
      });

      recognizer.start();
      proc.emit('error', new Error('spawn error'));
    });

    it('emits exit event when process exits', (done) => {
      jest.useRealTimers();
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.on('exit', (code, signal) => {
        expect(code).toBe(0);
        expect(signal).toBe(null);
        done();
      });

      recognizer.start();
      proc.emit('exit', 0, null);
    });

    it('auto-restarts on crash (non-zero exit) unless stopped', () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();

      // Simulate crash
      proc1.emit('exit', 1, null);

      // Advance timers to trigger restart
      jest.advanceTimersByTime(600);

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('does not auto-restart when intentionally stopped', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();
      recognizer.stop();

      // Simulate exit after stop
      proc.emit('exit', 1, null);

      jest.advanceTimersByTime(600);

      // Should not restart
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('does not auto-restart on clean exit (code 0)', () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const recognizer = new SpeechRecognizer(repoRoot);
      recognizer.start();

      proc.emit('exit', 0, null);

      jest.advanceTimersByTime(600);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });
});
