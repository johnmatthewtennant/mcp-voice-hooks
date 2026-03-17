/**
 * Claude CLI spawner for Phase 0: Spawn on inactive session.
 *
 * Spawns `claude -p` with `--resume` to deliver a message to an inactive
 * Claude Code session.  The spawned instance inherits existing hooks, so
 * hook-based utterance delivery and voice responses continue to work.
 *
 * This is a "fire and forget" spawn -- the server does not manage the child
 * process lifecycle beyond basic cleanup.
 */

import { spawn, type ChildProcess } from 'child_process';
import { debugLog } from './debug.js';

interface SpawnOptions {
  /** Claude session ID to resume */
  sessionId: string;
  /** Initial prompt / message to send */
  prompt: string;
  /** Working directory for the Claude process */
  cwd?: string;
  /** Callback invoked if the spawned process errors or exits early (e.g. bad cwd, missing binary) */
  onSpawnError?: (error: Error | string) => void;
}

interface SpawnResult {
  /** The spawned child process */
  process: ChildProcess;
  /** The session ID that was resumed */
  sessionId: string;
}

/**
 * Managed process tracker.  Keeps a reference so the server can clean up
 * on shutdown and prevent duplicate spawns for the same session.
 */
const managedProcesses = new Map<string, ChildProcess>();

/**
 * Spawn a Claude CLI process that resumes an existing session.
 *
 * ```
 * claude -p --resume <sessionId> --dangerously-skip-permissions "<prompt>"
 * ```
 *
 * The process runs in the background.  When it exits, the entry is removed
 * from the managed process map automatically.
 */
export function spawnClaudeResume(options: SpawnOptions): SpawnResult {
  const { sessionId, prompt, cwd, onSpawnError } = options;

  // Prevent double-spawning for the same session
  const existing = managedProcesses.get(sessionId);
  if (existing && !existing.killed) {
    debugLog(`[Spawner] Session ${sessionId} already has a running process (pid=${existing.pid}), skipping spawn`);
    return { process: existing, sessionId };
  }

  const args = [
    '-p',
    '--resume', sessionId,
    '--dangerously-skip-permissions',
    prompt,
  ];

  debugLog(`[Spawner] Spawning: claude ${args.join(' ')}`);

  const child = spawn('claude', args, {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  managedProcesses.set(sessionId, child);

  child.stdout?.on('data', (data: Buffer) => {
    debugLog(`[Spawner] [${sessionId}] stdout: ${data.toString().trim()}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    debugLog(`[Spawner] [${sessionId}] stderr: ${data.toString().trim()}`);
  });

  child.on('exit', (code, signal) => {
    debugLog(`[Spawner] [${sessionId}] exited: code=${code} signal=${signal}`);
    managedProcesses.delete(sessionId);
  });

  child.on('error', (err) => {
    debugLog(`[Spawner] [${sessionId}] error: ${err.message}`);
    managedProcesses.delete(sessionId);
    onSpawnError?.(err);
  });

  debugLog(`[Spawner] Spawned pid=${child.pid} for session=${sessionId}`);

  return { process: child, sessionId };
}

/**
 * Check if a managed Claude process is running for the given session.
 */
export function isSessionProcessRunning(sessionId: string): boolean {
  const proc = managedProcesses.get(sessionId);
  return !!proc && !proc.killed;
}

/**
 * Kill all managed processes.  Called on server shutdown.
 */
export function killAllManagedProcesses(): void {
  for (const [sessionId, proc] of managedProcesses) {
    if (!proc.killed) {
      debugLog(`[Spawner] Killing managed process: session=${sessionId} pid=${proc.pid}`);
      proc.kill('SIGTERM');
    }
  }
  managedProcesses.clear();
}

/**
 * Get the count of running managed processes.
 */
export function getManagedProcessCount(): number {
  // Clean up stale entries
  for (const [sessionId, proc] of managedProcesses) {
    if (proc.killed) {
      managedProcesses.delete(sessionId);
    }
  }
  return managedProcesses.size;
}
