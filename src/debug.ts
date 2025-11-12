const DEBUG = process.argv.includes('--debug') || process.argv.includes('-d');

export function debugLog(...args: any[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}