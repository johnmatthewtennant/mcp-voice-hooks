import fs from 'fs';

const DEBUG = process.argv.includes('--debug') || process.argv.includes('-d') || process.env.MCP_VOICE_HOOKS_DEBUG === 'true';
const LOG_FILE = '/tmp/mcp-voice-hooks.log';

export function debugLog(...args: any[]): void {
  if (DEBUG) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  }
}
