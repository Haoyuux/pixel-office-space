import type { NextFunction, Request, Response } from 'express';

/**
 * The office only serves its own UI on this machine. Browsers don't apply CORS to WebSockets and allow "simple"
 * cross-site POSTs, so every request with an Origin must come from http(s)://127.0.0.1 or localhost (any port).
 * Requests without an Origin (curl, tools/e2e.mjs, same-origin GETs) are allowed.
 * Keep these checks when real agents and diffs flow (M2).
 */
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/i;

export const originAllowed = (origin: string | undefined): boolean => origin === undefined || origin === '' || LOCAL.test(origin);

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 403 for a foreign Origin; 415 unless a mutation says Content-Type: application/json (blocks CORS "simple" requests). */
export function guardRequests(req: Request, res: Response, next: NextFunction): void {
  if (!originAllowed(req.headers.origin)) { res.status(403).json({ error: 'Cross-site request refused' }); return; }
  if (MUTATIONS.has(req.method) && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    res.status(415).json({ error: 'Content-Type must be application/json' });
    return;
  }
  next();
}
