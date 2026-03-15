import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { debugLog } from './debug.js';

interface TranscriptResult {
  type: 'interim' | 'final';
  text: string;
}

/**
 * Wraps the Swift speech-recognizer binary as a child process.
 * Reads PCM16 LE 16kHz mono audio from feedAudio() and emits
 * transcript events parsed from the binary's JSON-line stdout.
 */
export class SpeechRecognizer extends EventEmitter {
  private process: ChildProcess | null = null;
  private binaryPath: string;
  private _stopped = false;

  constructor(repoRoot: string) {
    super();
    this.binaryPath = path.join(repoRoot, 'swift', 'speech-recognizer', '.build', 'release', 'speech-recognizer');
  }

  /** Check if the Swift binary exists on disk. */
  static binaryExists(repoRoot: string): boolean {
    const p = path.join(repoRoot, 'swift', 'speech-recognizer', '.build', 'release', 'speech-recognizer');
    return fs.existsSync(p);
  }

  /** Spawn the recognizer process. Safe to call multiple times (no-op if running). */
  start(): void {
    if (this.process) return;
    this._stopped = false;

    debugLog('[SpeechRecognizer] Spawning', this.binaryPath);

    this.process = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Read JSON lines from stdout
    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line: string) => {
      try {
        const result = JSON.parse(line) as TranscriptResult;
        if (result.type === 'interim' || result.type === 'final') {
          this.emit('transcript', result);
        }
      } catch (err) {
        debugLog('[SpeechRecognizer] Failed to parse stdout line:', line, err);
      }
    });

    // Log stderr for debugging
    this.process.stderr?.on('data', (data: Buffer) => {
      debugLog('[SpeechRecognizer] stderr:', data.toString().trim());
    });

    this.process.on('error', (err: Error) => {
      debugLog('[SpeechRecognizer] Process error:', err.message);
      this.emit('error', err);
      this.process = null;
    });

    this.process.on('exit', (code, signal) => {
      debugLog(`[SpeechRecognizer] Process exited: code=${code} signal=${signal}`);
      this.process = null;
      this.emit('exit', code, signal);

      // Auto-restart on crash (non-zero exit) unless intentionally stopped
      if (!this._stopped && code !== 0 && code !== null) {
        debugLog('[SpeechRecognizer] Restarting after crash...');
        setTimeout(() => {
          if (!this._stopped) this.start();
        }, 500);
      }
    });
  }

  /**
   * Feed raw PCM16 LE audio data to the recognizer.
   * Handles backpressure: drops frames if the stdin buffer is full.
   */
  feedAudio(pcmBuffer: Buffer): void {
    if (!this.process?.stdin || this.process.stdin.destroyed) return;

    const ok = this.process.stdin.write(pcmBuffer);
    if (!ok) {
      // Backpressure: stdin buffer is full, drop this frame
      debugLog('[SpeechRecognizer] Backpressure: dropping audio frame');
    }
  }

  /** Gracefully stop the recognizer by closing stdin (triggers EOF). */
  stop(): void {
    this._stopped = true;
    if (this.process?.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.end();
    }
  }

  /** Forcefully kill the recognizer process. */
  kill(): void {
    this._stopped = true;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
