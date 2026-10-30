import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoPasscode, recordPasscodeMiss, resetPasscodeLimiter, setPasscodeClock, verifySessionToken } from './session';
import { setDataDir, writeText } from './store';
import { handleApiRoutes } from '../routes';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

let dir = '';
const saved: Record<string, string | undefined> = {};

function remember(name: string): void {
  saved[name] = process.env[name];
}

beforeEach(async () => {
  remember('AGORA_HOUSEHOLD_PASSCODE');
  remember('AGORA_TOKEN_SECRET');
  remember('AGORA_TRUST_PROXY');
  remember('AGORA_DEMO_PUBLIC_PASSCODE');
  process.env.AGORA_HOUSEHOLD_PASSCODE = 'home-pass';
  process.env.AGORA_TOKEN_SECRET = 'session-secret';
  delete process.env.AGORA_TRUST_PROXY;
  resetPasscodeLimiter();
  dir = await mkdtemp(path.join(tmpdir(), 'agora-session-'));
  setDataDir(dir);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

function call(
  method: string,
  url: string,
  headers: Record<string, string>,
  json?: unknown,
  remoteAddress = '127.0.0.1',
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.resume = () => req;
  req.socket = { remoteAddress } as IncomingMessage['socket'];
  const res = new EventEmitter() as ServerResponse & { statusCode: number; body: string; headers: Record<string, string> };
  res.statusCode = 0;
  res.body = '';
  res.headers = {};
  res.writeHead = ((status: number, extra?: Record<string, string>) => {
    res.statusCode = status;
    res.headers = extra ?? {};
    return res;
  }) as ServerResponse['writeHead'];
  res.end = ((body?: string) => {
    res.body = body ?? '';
    res.emit('done');
    return res;
  }) as ServerResponse['end'];
  const handled = handleApiRoutes(req, res);
  if (!handled) return Promise.resolve({ status: 0, body: '', headers: {} });
  if (json !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(json)));
    req.emit('end');
  }
  return new Promise((resolve) => {
    const finish = () => resolve({ status: res.statusCode, body: res.body, headers: res.headers });
    if (res.body || res.statusCode) {
      finish();
      return;
    }
    res.once('done', finish);
  });
}

function cookieFrom(headers: Record<string, string>): string {
  const match = /^agora_household=([^;]*)/.exec(headers['Set-Cookie'] ?? '');
  return match?.[1] ?? '';
}

describe('household session', () => {
  it('publishes the passcode only for a public demo', () => {
    delete process.env.AGORA_DEMO_PUBLIC_PASSCODE;
    expect(demoPasscode()).toBeUndefined();
    process.env.AGORA_DEMO_PUBLIC_PASSCODE = '1';
    expect(demoPasscode()).toBe('home-pass');
    delete process.env.AGORA_HOUSEHOLD_PASSCODE;
    expect(demoPasscode()).toBeUndefined();
  });

  it('signs a cookie that verifies, and rejects a tampered one', async () => {
    const result = await call('POST', '/api/session', { host: 'localhost:3000', 'content-type': 'application/json' }, { passcode: 'home-pass' });
    expect(result.status).toBe(200);
    const token = cookieFrom(result.headers);
    expect(token).not.toBe('');
    expect(result.headers['Set-Cookie']).toContain('HttpOnly');
    expect(result.headers['Set-Cookie']).toContain('SameSite=Strict');
    expect(result.headers['Set-Cookie']).toContain('Path=/');
    expect(result.headers['Set-Cookie']).not.toContain('Secure');
    expect(verifySessionToken(token)).toBe(true);
    expect(verifySessionToken(`${token}x`)).toBe(false);
  });

  it('locks household routes until the cookie is presented', async () => {
    const locked = await call('GET', '/api/household', { host: 'localhost:3000' });
    expect(locked.status).toBe(401);
    expect(JSON.parse(locked.body)).toEqual({ error: 'household_locked' });

    const session = await call('GET', '/api/session', { host: 'localhost:3000' });
    expect(JSON.parse(session.body)).toEqual({ required: true, active: false });

    const posted = await call('POST', '/api/session', { host: 'localhost:3000', 'content-type': 'application/json' }, { passcode: 'home-pass' });
    const token = cookieFrom(posted.headers);
    const open = await call('GET', '/api/household', { host: 'localhost:3000', cookie: `agora_household=${token}` });
    expect(open.status).toBe(200);

    const active = await call('GET', '/api/session', { host: 'localhost:3000', cookie: `agora_household=${token}` });
    expect(JSON.parse(active.body)).toEqual({ required: true, active: true });

    const cleared = await call('DELETE', '/api/session', { host: 'localhost:3000', cookie: `agora_household=${token}` });
    expect(cleared.status).toBe(200);
    expect(cleared.headers['Set-Cookie']).toContain('Max-Age=0');
    const again = await call('GET', '/api/memory', { host: 'localhost:3000' });
    expect(again.status).toBe(401);
  });

  it('waits before rejecting a wrong passcode', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const pending = call('POST', '/api/session', { host: 'localhost:3000', 'content-type': 'application/json' }, { passcode: 'nope' }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body)).toEqual({ error: 'invalid_passcode' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the routes open on loopback when no passcode is configured', async () => {
    delete process.env.AGORA_HOUSEHOLD_PASSCODE;
    const household = await call('GET', '/api/household', { host: 'localhost:3000' });
    expect(household.status).toBe(200);
    const remote = await call('GET', '/api/household', { host: 'localhost:3000' }, undefined, '192.168.1.20');
    expect(remote.status).toBe(403);
    expect(JSON.parse(remote.body).error).toContain('AGORA_HOUSEHOLD_PASSCODE');
    const session = await call('GET', '/api/session', { host: 'localhost:3000' });
    expect(JSON.parse(session.body)).toEqual({ required: false, active: false });
    await writeText(`runs/${RUN_ID}.md`, '# Dinner\n');
    const document = await call('GET', `/api/runs/${RUN_ID}/document`, { host: 'localhost:3000' });
    expect(document.status).toBe(200);
    expect(document.body).toBe('# Dinner\n');
    expect(document.headers['Content-Type']).toContain('text/markdown');
  });

  it('blocks the shared passcode limiter after five misses', async () => {
    for (let i = 0; i < 4; i += 1) recordPasscodeMiss('127.0.0.1');
    const blocked = await call('POST', '/api/session', { host: 'localhost:3000', 'content-type': 'application/json' }, { passcode: 'nope' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toContain('Too many attempts');
    setPasscodeClock(() => Date.now() + 15 * 60 * 1000 + 1000);
    const again = await call('POST', '/api/session', { host: 'localhost:3000', 'content-type': 'application/json' }, { passcode: 'nope' });
    expect(again.status).toBe(401);
  });

  it('keys the limiter on the first forwarded address only when the proxy is trusted', async () => {
    for (let i = 0; i < 4; i += 1) recordPasscodeMiss('10.0.0.8');
    const ignored = await call('POST', '/api/session', {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9',
    }, { passcode: 'nope' }, '10.0.0.8');
    expect(ignored.status).toBe(429);

    resetPasscodeLimiter();
    process.env.AGORA_TRUST_PROXY = '1';
    for (let i = 0; i < 4; i += 1) recordPasscodeMiss('203.0.113.9');
    const blocked = await call('POST', '/api/session', {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9, 10.0.0.8',
    }, { passcode: 'nope' }, '10.0.0.8');
    expect(blocked.status).toBe(429);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const other = call('POST', '/api/session', {
        host: 'localhost:3000',
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.4',
      }, { passcode: 'nope' }, '10.0.0.8');
      await vi.advanceTimersByTimeAsync(250);
      const result = await other;
      expect(result.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the cookie Secure only when AGORA_TRUST_PROXY trusts the forwarded proto', async () => {
    const plain = await call('POST', '/api/session', {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
    }, { passcode: 'home-pass' });
    expect(plain.headers['Set-Cookie']).not.toContain('Secure');
    process.env.AGORA_TRUST_PROXY = '1';
    const trusted = await call('POST', '/api/session', {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
    }, { passcode: 'home-pass' });
    expect(trusted.headers['Set-Cookie']).toContain('Secure');
  });

  it('locks the run document with the other household routes', async () => {
    await writeText(`runs/${RUN_ID}.md`, '# Dinner\n');
    const locked = await call('GET', `/api/runs/${RUN_ID}/document`, { host: 'localhost:3000' });
    expect(locked.status).toBe(401);
  });
});
