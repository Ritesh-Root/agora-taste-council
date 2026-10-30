import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeQloo } from './fakeQloo';
import { callQloo, createStdioQlooCaller, normalizeEnvelope, qlooChildEnv, qlooInFlight, qlooReady, setQlooCaller, setQlooRetryDelays } from './qlooClient';

let scratch = '';

afterEach(async () => {
  setQlooCaller(null);
  delete process.env.QLOO_API_KEY;
  delete process.env.QLOO_BIN;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = '';
});

describe('normalizeEnvelope', () => {
  it('keeps the harness fields and tolerates odd shapes', () => {
    expect(normalizeEnvelope({ structuredContent: { status: 'ok', summary: 's', results: [{ name: 'Coco' }], result_count: 1 } }))
      .toEqual({ status: 'ok', summary: 's', results: [{ name: 'Coco' }], result_count: 1 });
    expect(normalizeEnvelope({ structuredContent: { status: 'weird', results: { entities: [1, 2] } } }))
      .toMatchObject({ status: 'ok', results: [1, 2], result_count: 2 });
    expect(normalizeEnvelope({ content: [{ type: 'text', text: '{"status":"empty","results":[]}' }] }).status).toBe('empty');
    expect(normalizeEnvelope({ content: [{ type: 'text', text: 'not json' }], isError: true })).toMatchObject({ status: 'error', summary: 'not json' });
    expect(normalizeEnvelope(undefined).status).toBe('error');
  });

  it('reads the error and needs_input issues', () => {
    const envelope = normalizeEnvelope({
      structuredContent: {
        status: 'needs_input',
        summary: 'Choose',
        results: [],
        error: { code: 'QLOO_AUTH', layer: 'qloo', retryable: false, recovery: 'Run qloo setup' },
        resolution: { issues: [{ input: 'Coco', field: 'signals', kind: 'ambiguous', candidates: [{ id: 'u1', name: 'Coco (2017)' }, { bad: true }] }] },
      },
    });
    expect(envelope.error).toEqual({ code: 'QLOO_AUTH', recovery: 'Run qloo setup', retryable: false });
    expect(envelope.issues).toEqual([{ input: 'Coco', field: 'signals', kind: 'ambiguous', candidates: [{ id: 'u1', name: 'Coco (2017)' }] }]);
  });

  it('reads what the harness resolved each input to', () => {
    const envelope = normalizeEnvelope({
      structuredContent: {
        status: 'ok',
        results: [],
        interpretation: {
          signals: [{ input: 'Coco', entityId: 'u-movie', name: 'Coco', type: 'urn:entity:movie', match: 'exact' }, { input: 'bad' }],
          signal_tags: [{ input: 'thrillers', tagId: 'urn:tag:genre:media:thriller', name: 'Thriller' }],
        },
      },
    });
    expect(envelope.resolved).toEqual([
      { field: 'signals', input: 'Coco', id: 'u-movie', name: 'Coco', type: 'urn:entity:movie' },
      { field: 'signal_tags', input: 'thrillers', id: 'urn:tag:genre:media:thriller', name: 'Thriller' },
    ]);
  });
});

describe('callQloo', () => {
  it('returns a record, caches ok results by tool and args, and not errors', async () => {
    let n = 0;
    const fake = fakeQloo((tool) => {
      n += 1;
      return tool === 'qloo_rank' ? { status: 'error', summary: 'nope' } : { results: [{ name: `R${n}` }] };
    });
    setQlooCaller(fake);
    const first = await callQloo('qloo_recommend', { target_type: 'movie', signals: ['Coco'] }, 'Mia');
    expect(first.record).toMatchObject({ tool: 'qloo_recommend', status: 'ok', resultCount: 1, forWho: 'Mia' });
    const again = await callQloo('qloo_recommend', { signals: ['Coco'], target_type: 'movie' });
    expect(again.envelope.results).toEqual([{ name: 'R1' }]);
    expect(again.record.forWho).toBeUndefined();
    await callQloo('qloo_rank', { options: ['a'] });
    await callQloo('qloo_rank', { options: ['a'] });
    expect(fake.calls.map((call) => call.tool)).toEqual(['qloo_recommend', 'qloo_rank', 'qloo_rank']);
  });

  it('keeps one call in flight, or AGORA_QLOO_IN_FLIGHT', async () => {
    const fake = fakeQloo(async (_tool, args) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { results: [{ name: String(args.n) }] };
    });
    setQlooCaller(fake);
    await Promise.all(Array.from({ length: 7 }, (_, n) => callQloo('qloo_recommend', { n })));
    expect(fake.maxConcurrent).toBe(1);
    expect(fake.calls).toHaveLength(7);
    expect(qlooInFlight()).toBe(0);

    process.env.AGORA_QLOO_IN_FLIGHT = '2';
    try {
      const two = fakeQloo(async (_tool, args) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { results: [{ name: String(args.n) }] };
      });
      setQlooCaller(two);
      await Promise.all(Array.from({ length: 5 }, (_, n) => callQloo('qloo_recommend', { n })));
      expect(two.maxConcurrent).toBe(2);
    } finally {
      delete process.env.AGORA_QLOO_IN_FLIGHT;
    }
    expect(qlooInFlight()).toBe(0);
  });

  it('retries a rate-limited answer twice, then gives up; never a plain error', async () => {
    setQlooRetryDelays([5, 10]);
    try {
      let n = 0;
      const limited = fakeQloo(() => {
        n += 1;
        return n < 3
          ? { status: 'error', summary: 'Qloo API request failed with 429 Too Many Requests.', error: { code: 'QLOO_RATE_LIMIT', retryable: true } }
          : { results: [{ name: 'Coco' }] };
      });
      setQlooCaller(limited);
      const ok = await callQloo('qloo_recommend', { n: 'rl' }, 'Mia', Date.now() + 60_000);
      expect(ok.envelope.status).toBe('ok');
      expect(ok.record).toMatchObject({ status: 'ok', retries: 2 });
      expect(limited.calls).toHaveLength(3);

      const always = fakeQloo(() => ({ status: 'error', summary: 'x', error: { code: 'QLOO_RATE_LIMIT', retryable: true } }));
      setQlooCaller(always);
      const failed = await callQloo('qloo_recommend', { n: 'always' });
      expect(failed.envelope.status).toBe('error');
      expect(failed.record.retries).toBe(2);
      expect(always.calls).toHaveLength(3);

      const plain = fakeQloo(() => ({ status: 'error', summary: 'bad input', error: { code: 'QLOO_BAD_REQUEST', retryable: false } }));
      setQlooCaller(plain);
      const once = await callQloo('qloo_recommend', { n: 'plain' });
      expect(once.record.retries).toBeUndefined();
      expect(plain.calls).toHaveLength(1);
    } finally {
      setQlooRetryDelays(null);
    }
  });

  it('does not wait for a retry that would end past the deadline', async () => {
    const limited = fakeQloo(() => ({ status: 'error', summary: 'Qloo API request failed with 429.' }));
    setQlooCaller(limited);
    const started = Date.now();
    const result = await callQloo('qloo_rank', { n: 'late' }, 'Dadi', Date.now() + 500);
    expect(result.envelope.status).toBe('error');
    expect(limited.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('turns a throw into an error envelope without leaking the key', async () => {
    process.env.QLOO_API_KEY = 'sk-secret-123';
    setQlooCaller(fakeQloo(() => {
      throw new Error('bad key sk-secret-123');
    }));
    const { envelope, record } = await callQloo('qloo_recommend', { target_type: 'movie' });
    expect(envelope.status).toBe('error');
    expect(record.summary).not.toContain('sk-secret-123');
    expect(JSON.stringify(record)).not.toContain('sk-secret-123');
  });

  it('reports readiness from the caller', async () => {
    setQlooCaller(fakeQloo(() => ({}), 'ready'));
    await expect(qlooReady()).resolves.toBe(true);
    setQlooCaller(fakeQloo(() => ({}), 'unconfigured'));
    await expect(qlooReady()).resolves.toBe(false);
  });
});

describe('callQloo deadline', () => {
  it('skips the call once the deadline has passed, without touching Qloo', async () => {
    const fake = fakeQloo(() => ({ results: [{ name: 'Coco' }] }));
    setQlooCaller(fake);
    const late = await callQloo('qloo_recommend', { n: 1 }, 'Mia', Date.now() - 1);
    expect(late.skipped).toBe(true);
    expect(late.envelope.status).toBe('error');
    expect(fake.calls).toHaveLength(0);
    expect(qlooInFlight()).toBe(0);
    const inTime = await callQloo('qloo_recommend', { n: 1 }, 'Mia', Date.now() + 60_000);
    expect(inTime.skipped).toBeUndefined();
    expect(inTime.envelope.status).toBe('ok');
  });
});

describe('qlooChildEnv', () => {
  it('passes the Qloo settings and the basics, and nothing else of ours', () => {
    const env = qlooChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      QLOO_API_KEY: 'k',
      QLOO_TRUSTED_BASE_URL: 'https://trusted.example',
      QLOO_HOME: '/tmp/qloo',
      TASTE_RESOLVER_URL: 'https://resolver.example',
      GEMINI_API_KEY: 'gemini-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AGORA_PASSCODE: 'pass',
    });
    expect(env).toMatchObject({
      QLOO_API_KEY: 'k',
      QLOO_TRUSTED_BASE_URL: 'https://trusted.example',
      QLOO_HOME: '/tmp/qloo',
      TASTE_RESOLVER_URL: 'https://resolver.example',
    });
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('AGORA_PASSCODE');
  });
});

// ---- the real stdio caller, against tiny stand-in `qloo mcp` scripts ----

/** Each script appends its pid to pids.txt when it starts. */
const HANGS = `#!/usr/bin/env node
require('fs').appendFileSync(process.env.QLOO_HOME + '/pids.txt', process.pid + '\\n');
setInterval(() => {}, 1000);
`;

/** A minimal MCP server over newline-delimited JSON-RPC. */
const ANSWERS = `#!/usr/bin/env node
require('fs').appendFileSync(process.env.QLOO_HOME + '/pids.txt', process.pid + '\\n');
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-qloo', version: '0' } } });
    } else if (message.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [], structuredContent: { status: 'ok', results: [], adapter: { ready: true } } } });
    } else {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

async function fakeBin(source: string): Promise<void> {
  scratch = await mkdtemp(path.join(tmpdir(), 'agora-qloo-bin-'));
  const bin = path.join(scratch, 'qloo');
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  process.env.QLOO_BIN = bin;
  process.env.QLOO_HOME = scratch;
}

async function pids(): Promise<number[]> {
  const text = await readFile(path.join(scratch, 'pids.txt'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('stdio caller', () => {
  afterEach(() => {
    delete process.env.QLOO_HOME;
  });

  it('closes a child that never answers, on each attempt', async () => {
    await fakeBin(HANGS);
    setQlooCaller(createStdioQlooCaller({ connectTimeoutMs: 300 }));
    const { envelope } = await callQloo('qloo_recommend', { target_type: 'movie' });
    expect(envelope.status).toBe('error');
    expect(envelope.summary).toMatch(/timed out/);
    const started = await pids();
    expect(started).toHaveLength(2);
    expect(started.filter(alive)).toEqual([]);
  }, 20_000);

  it('only closes the shared client when the failed call used it', async () => {
    await fakeBin(ANSWERS);
    const caller = createStdioQlooCaller({ connectTimeoutMs: 5_000 });
    setQlooCaller(caller);
    await expect(qlooReady()).resolves.toBe(true);
    const [first] = await pids();
    expect(alive(first)).toBe(true);

    caller.reset({} as Client);
    await caller.callTool('qloo_capabilities', {});
    expect(await pids()).toEqual([first]);

    caller.reset();
    await caller.callTool('qloo_capabilities', {});
    const after = await pids();
    expect(after).toHaveLength(2);
    setQlooCaller(null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(after.filter(alive)).toEqual([]);
  }, 20_000);
});
