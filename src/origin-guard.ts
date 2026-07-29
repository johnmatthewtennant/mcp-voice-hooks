import type { Request, Response, NextFunction } from 'express';
import os from 'os';
import { debugLog } from './debug.js';

/**
 * Origin allowlisting for the voice-hooks HTTP API.
 *
 * These endpoints are unauthenticated and consequential: POST /api/potential-utterances
 * delivers text to Claude as if the user had spoken it, in a session that can edit files
 * and run commands, and GET /api/conversation returns the transcript. Reachability is the
 * entire security boundary, so it has to be drawn deliberately.
 */

interface OriginPolicyOptions {
  httpPort: number;
  httpsPort: number;
  /** True when the server binds loopback only. */
  bindIsLoopback: boolean;
  /** Comma-separated extra origins (MCP_VOICE_HOOKS_EXTRA_ORIGINS). */
  extraOrigins?: string;
  /** Injectable for tests. */
  hostname?: string;
}

/** Origins the browser UI is legitimately served from. */
export function buildAllowedOrigins(opts: OriginPolicyOptions): Set<string> {
  const { httpPort, httpsPort, bindIsLoopback, extraOrigins, hostname = os.hostname() } = opts;

  const origins = new Set<string>([
    `http://localhost:${httpPort}`,
    `http://127.0.0.1:${httpPort}`,
    `https://localhost:${httpsPort}`,
    `https://127.0.0.1:${httpsPort}`,
  ]);

  // Cross-device access is served over HTTPS on the machine's own hostname, so those
  // origins only make sense once the user has opted out of loopback-only binding.
  if (!bindIsLoopback) {
    origins.add(`https://${hostname}:${httpsPort}`);
    origins.add(`https://${hostname}.local:${httpsPort}`);
  }

  for (const origin of extraOrigins?.split(',').map((o) => o.trim()).filter(Boolean) ?? []) {
    origins.add(origin);
  }

  return origins;
}

/**
 * Refuse cross-origin browser traffic before it reaches any route.
 *
 * This deliberately does not rely on the cors() middleware alone. CORS only hides the
 * *response* from a disallowed origin; a "simple" request (a form post, or fetch with a
 * non-preflighted content type) is still delivered and still executed. Because queueing an
 * utterance is a side effect that needs no response to be useful, a page on an unrelated
 * site could inject input into the session and simply never read the reply. Checking the
 * Origin header ourselves and refusing the request is what actually stops that.
 *
 * Requests with no Origin header pass through: those are local processes — the hooks' curl,
 * the MCP shim — not browser-initiated cross-origin calls. This also defeats DNS rebinding,
 * since a rebound page still sends its own (disallowed) origin.
 */
export function originGuard(allowedOrigins: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    if (origin !== undefined && !allowedOrigins.has(origin)) {
      debugLog(`[Security] Rejected cross-origin ${req.method} ${req.path} from ${origin}`);
      res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }

    next();
  };
}

/**
 * Whether a WebSocket upgrade should be accepted.
 *
 * WebSockets are exempt from CORS by design, and the upgrade never passes through Express
 * middleware, so the HTTP guard above does not cover them. That matters here because the
 * socket is not read-only: connecting evicts the existing audio client (the server keeps
 * one at a time), `select-session` chooses which Claude session receives input, and binary
 * frames are fed to the speech recognizer, whose transcript becomes an utterance delivered
 * to Claude. A page in the user's browser could therefore hijack the voice session, or
 * synthesise audio and have it transcribed into instructions.
 *
 * Same policy as the HTTP guard: a present-but-unlisted Origin is refused, and an absent
 * Origin is allowed for non-browser clients.
 */
export function isWebSocketOriginAllowed(
  origin: string | undefined,
  allowedOrigins: Set<string>,
): boolean {
  return origin === undefined || allowedOrigins.has(origin);
}

/** cors() origin callback sharing the same allowlist. */
export function corsOriginCheck(allowedOrigins: Set<string>) {
  return (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void): void => {
    cb(null, !origin || allowedOrigins.has(origin));
  };
}
