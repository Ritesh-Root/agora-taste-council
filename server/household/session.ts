import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Household session cookie. Set only when AGORA_HOUSEHOLD_PASSCODE is set.
 * The value is HMAC-SHA256, `base64url(payload).base64url(sig)`.
 * Nothing here logs a passcode or the signing secret.
 */

const COOKIE = 'agora_household';
const MAX_AGE_SECONDS = 12 * 60 * 60;
const FAIL_DELAY_MS = 250;
const MISS_LIMIT = 5;
const BLOCK_MS = 15 * 60 * 1000;

interface Miss {
  count: number;
  blockedUntil: number;
}

const misses = new Map<string, Miss>();
let passcodeNow = (): number => Date.now();

interface SessionPayload {
  exp: number;
  purpose: 'household';
}

function secret(): string {
  return process.env.AGORA_TOKEN_SECRET ?? '';
}

export function householdLockEnabled(): boolean {
  return Boolean(process.env.AGORA_HOUSEHOLD_PASSCODE?.trim());
}

/** Loopback only. Mapped IPv4 (`::ffff:127.0.0.1`) counts as loopback. */
export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

/** True when the TCP peer is loopback. A missing address is not loopback. */
export function requestFromLoopback(req: IncomingMessage): boolean {
  const remote = req.socket?.remoteAddress;
  if (!remote) return false;
  return isLoopbackAddress(remote);
}

export function setPasscodeClock(next: (() => number) | null): void {
  passcodeNow = next ?? (() => Date.now());
}

export function resetPasscodeLimiter(): void {
  misses.clear();
  passcodeNow = () => Date.now();
}

function clientAddress(raw: string): string {
  return raw.trim().toLowerCase().replace(/^::ffff:/, '');
}

/**
 * Limiter key. Behind `AGORA_TRUST_PROXY=1` this is the first `X-Forwarded-For`
 * address, so one person's guesses do not lock everyone who shares the proxy.
 * Without that setting the header is ignored and the TCP peer is the key.
 */
export function passcodeClientKey(req: IncomingMessage): string {
  if (process.env.AGORA_TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = header?.split(',')[0];
    if (first?.trim()) return clientAddress(first);
  }
  return clientAddress(req.socket?.remoteAddress ?? 'unknown');
}

/** True while this address is inside the 15 minute lockout. */
export function passcodeBlocked(key: string, now = passcodeNow()): boolean {
  const item = misses.get(key);
  if (!item || item.blockedUntil <= 0) return false;
  if (item.blockedUntil > now) return true;
  misses.delete(key);
  return false;
}

/**
 * Counts one wrong passcode. The fifth miss blocks the address.
 * Returns true when the address is now blocked.
 */
export function recordPasscodeMiss(key: string, now = passcodeNow()): boolean {
  if (passcodeBlocked(key, now)) return true;
  const item = misses.get(key) ?? { count: 0, blockedUntil: 0 };
  item.count += 1;
  if (item.count >= MISS_LIMIT) {
    item.blockedUntil = now + BLOCK_MS;
  }
  misses.set(key, item);
  return item.blockedUntil > now;
}

export function clearPasscodeMisses(key: string): void {
  misses.delete(key);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify({ exp: payload.exp, purpose: payload.purpose })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** True when the cookie is signed by this process and has not expired. */
export function verifySessionToken(token: string, now = Date.now()): boolean {
  if (!secret() || token.length > 4096) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const item = parsed as { exp?: unknown; purpose?: unknown };
  return item.purpose === 'household' && typeof item.exp === 'number' && item.exp > now;
}

function readCookie(header: string | undefined): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

export function householdSessionActive(req: IncomingMessage, now = Date.now()): boolean {
  if (!householdLockEnabled()) return true;
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header[0] : header;
  return verifySessionToken(readCookie(raw), now);
}

function requestIsHttps(req: IncomingMessage): boolean {
  if (process.env.AGORA_TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-proto'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (raw?.split(',')[0]?.trim() === 'https') return true;
  }
  return (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
}

function cookieHeader(value: string, req: IncomingMessage, maxAge: number): string {
  const parts = [
    `${COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function sendJson(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
  if (res.headersSent || res.writableEnded) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET, POST, and DELETE /api/session. */
/**
 * A public demo (fictional household) may publish its passcode on the lock screen so judges can walk in.
 * Only when AGORA_DEMO_PUBLIC_PASSCODE=1; a real household never sends it.
 */
export function demoPasscode(): string | undefined {
  if (process.env.AGORA_DEMO_PUBLIC_PASSCODE !== '1') return undefined;
  return process.env.AGORA_HOUSEHOLD_PASSCODE?.trim() || undefined;
}

export async function handleSession(req: IncomingMessage, res: ServerResponse, passcode: string | null): Promise<void> {
  const method = req.method ?? 'GET';
  const required = householdLockEnabled();
  if (method === 'GET') {
    const demo = required ? demoPasscode() : undefined;
    sendJson(res, 200, { required, active: required ? householdSessionActive(req) : false, ...(demo ? { demoPasscode: demo } : {}) });
    return;
  }
  if (method === 'DELETE') {
    sendJson(res, 200, { required, active: false }, cookieHeader('', req, 0));
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!required) {
    sendJson(res, 200, { required: false, active: false });
    return;
  }
  if (!secret()) {
    sendJson(res, 503, { error: 'session_unconfigured' });
    return;
  }
  const expected = process.env.AGORA_HOUSEHOLD_PASSCODE ?? '';
  const given = passcode ?? '';
  const key = passcodeClientKey(req);
  if (passcodeBlocked(key)) {
    sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    return;
  }
  if (!safeEqual(given, expected)) {
    if (recordPasscodeMiss(key)) {
      sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      return;
    }
    await delay(FAIL_DELAY_MS);
    sendJson(res, 401, { error: 'invalid_passcode' });
    return;
  }
  clearPasscodeMisses(key);
  const token = sign({ exp: Date.now() + MAX_AGE_SECONDS * 1000, purpose: 'household' });
  sendJson(res, 200, { required: true, active: true }, cookieHeader(token, req, MAX_AGE_SECONDS));
}
