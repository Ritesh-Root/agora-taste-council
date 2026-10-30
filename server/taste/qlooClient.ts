import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { QlooCallRecord } from '../../shared/taste';

/**
 * One process-wide MCP client for the official Qloo MCP server (`qloo mcp` over stdio).
 * The child gets the SDK's minimal environment plus the Qloo settings (qlooChildEnv), never the
 * rest of ours. The key never leaves the child and is never logged or returned here.
 *
 * Every call goes through a small LRU cache (30 min) and a one-slot semaphore (AGORA_QLOO_IN_FLIGHT),
 * so a council of four people cannot burst the Qloo rate limit. The harness resolves every name and
 * id in a call with its own parallel Qloo requests, so one call is already a small burst. A
 * rate-limited (429) or other retryable answer is retried twice, 1.5 s then 4 s later, within the
 * caller's deadline.
 */

export type QlooStatus = QlooCallRecord['status'];

export interface QlooIssue {
  input: string;
  field?: string;
  kind?: string;
  /** The resolver's scope for this input (a Qloo entity type), when the harness gave one. */
  scope?: string;
  candidates: { id: string; name?: string; type?: string; description?: string }[];
}

/** One input the harness resolved, from `interpretation` on a successful result. */
export interface QlooResolved {
  field: string;
  input: string;
  id: string;
  name?: string;
  type?: string;
}

/** The harness result envelope, normalized. */
export interface QlooEnvelope {
  status: QlooStatus;
  summary: string;
  results: unknown[];
  result_count: number;
  error?: { code?: string; recovery?: string; retryable?: boolean };
  /** Unresolved inputs from a needs_input result. */
  issues?: QlooIssue[];
  /** Inputs the harness resolved to Qloo ids, from a successful result. */
  resolved?: QlooResolved[];
}

/** Raw tool result, as the MCP client returns it. */
export interface QlooRawResult {
  structuredContent?: unknown;
  content?: unknown;
  isError?: boolean;
}

export type QlooReadiness = 'ready' | 'unconfigured' | 'unreachable';

/** What the council needs from Qloo. Swap it in tests with setQlooCaller(). */
export interface QlooCaller {
  callTool(tool: string, args: Record<string, unknown>): Promise<QlooRawResult>;
  readiness(): Promise<QlooReadiness>;
  /** Drop the connection so the next call starts a fresh child (picks up a new credential). */
  reset?(): void;
}

const STATUSES: ReadonlySet<string> = new Set(['ok', 'empty', 'needs_input', 'partial', 'degraded', 'error']);
const CALL_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 8_000;
/** For the qloo_capabilities call itself, after the child is up (the connect has its own timeout). */
const READY_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 200;
const DEFAULT_IN_FLIGHT = 1;
/** Waits before the first and second retry of a rate-limited or otherwise retryable call. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000];
let retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

/** Tests: shorter retry waits. null restores the defaults. */
export function setQlooRetryDelays(delays: readonly number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

function maxInFlight(): number {
  const value = Number.parseInt(process.env.AGORA_QLOO_IN_FLIGHT ?? '', 10);
  return Number.isFinite(value) && value >= 1 && value <= 4 ? value : DEFAULT_IN_FLIGHT;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * What `qloo mcp` reads: its QLOO_* settings (QLOO_API_KEY, QLOO_BASE_URL, QLOO_TRUSTED_BASE_URL,
 * QLOO_HOME, QLOO_TRUSTED_TASTE_RESOLVER_URL, ...) and the taste resolver's. Everything else of
 * ours (other API keys, cloud credentials) stays out of the child.
 */
const CHILD_ENV = new Set(['TASTE_RESOLVER_URL', 'TASTE_RESOLVER_API_KEY', 'NODE_EXTRA_CA_CERTS', 'TMPDIR', 'LANG']);

export function qlooChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && (key.startsWith('QLOO_') || CHILD_ENV.has(key))) env[key] = value;
  }
  return env;
}

/** The real caller: spawns `qloo mcp` lazily and reconnects once if the child died. */
class StdioQlooCaller implements QlooCaller {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS) {}

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    const command = process.env.QLOO_BIN?.trim() || 'qloo';
    const attempt = (async () => {
      const transport = new StdioClientTransport({ command, args: ['mcp'], env: qlooChildEnv(), stderr: 'ignore' });
      const client = new Client({ name: 'agora-plus-taste', version: '0.1.0' });
      transport.onclose = () => {
        if (this.client === client) this.client = null;
      };
      try {
        await withTimeout(client.connect(transport), this.connectTimeoutMs, 'Starting qloo mcp');
      } catch (error) {
        // A child that started but never answered would otherwise be orphaned.
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        throw error;
      }
      this.client = client;
      return client;
    })();
    this.connecting = attempt;
    return attempt.finally(() => {
      this.connecting = null;
    });
  }

  /**
   * Close the shared client. With `expected`, only when it is still the shared one, so a call
   * that failed on an old child does not kill a newer child other calls are using.
   */
  reset(expected?: Client): void {
    const client = this.client;
    if (!client || (expected && client !== expected)) return;
    this.client = null;
    void client.close().catch(() => undefined);
  }

  callTool(tool: string, args: Record<string, unknown>): Promise<QlooRawResult> {
    return this.call(tool, args, CALL_TIMEOUT_MS);
  }

  private async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<QlooRawResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let client: Client;
      try {
        client = await this.connect();
      } catch (error) {
        // connect() already closed the child it started.
        if (attempt === 0) continue;
        throw error;
      }
      try {
        const result = await withTimeout(client.callTool({ name: tool, arguments: args }), timeoutMs, tool);
        return result as QlooRawResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const closed = this.client !== client || /closed|not connected|EPIPE|ECONNRESET/i.test(message);
        if (closed && attempt === 0) {
          this.reset(client);
          continue;
        }
        if (/timed out/.test(message)) this.reset(client);
        throw error;
      }
    }
    throw new Error('qloo mcp could not be reached');
  }

  async readiness(): Promise<QlooReadiness> {
    try {
      // Not wrapped in another timeout: a slow but successful start must not read as unreachable.
      // The connect and the call each have their own.
      const raw = await this.call('qloo_capabilities', {}, READY_TIMEOUT_MS);
      const adapter = asRecord(asRecord(raw.structuredContent)?.adapter);
      if (adapter?.ready === true) return 'ready';
      // The child reads the credential at start. Drop it so a later `qloo setup` takes effect.
      this.reset();
      return 'unconfigured';
    } catch {
      return 'unreachable';
    }
  }
}

/** Tests: the real stdio caller with a shorter start timeout. */
export function createStdioQlooCaller(options: { connectTimeoutMs?: number } = {}): QlooCaller & { reset(expected?: Client): void } {
  return new StdioQlooCaller(options.connectTimeoutMs);
}

let caller: QlooCaller | null = null;

function currentCaller(): QlooCaller {
  if (!caller) caller = new StdioQlooCaller();
  return caller;
}

/** Tests pass a fake. null restores the real `qloo mcp` child on next use. */
export function setQlooCaller(next: QlooCaller | null): void {
  caller?.reset?.();
  caller = next;
  clearQlooCache();
}

// ---- cache ----

const cache = new Map<string, { at: number; envelope: QlooEnvelope }>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function clearQlooCache(): void {
  cache.clear();
}

function cacheGet(key: string): QlooEnvelope | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.envelope;
}

function cachePut(key: string, envelope: QlooEnvelope): void {
  cache.set(key, { at: Date.now(), envelope });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---- semaphore ----

let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (inFlight < maxInFlight()) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}

/** For tests: how many calls hold a slot right now. */
export function qlooInFlight(): number {
  return inFlight;
}

// ---- normalization ----

function parseText(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === 'text' && typeof record.text === 'string') {
      try {
        return JSON.parse(record.text);
      } catch {
        return { status: 'error', summary: record.text.slice(0, 200) };
      }
    }
  }
  return undefined;
}

function issuesOf(structured: Record<string, unknown>): QlooIssue[] {
  const resolution = asRecord(structured.resolution);
  const raw = Array.isArray(resolution?.issues) ? resolution.issues : [];
  const issues: QlooIssue[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record || typeof record.input !== 'string') continue;
    const candidates = (Array.isArray(record.candidates) ? record.candidates : [])
      .map((candidate) => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => !!candidate && typeof candidate.id === 'string')
      .map((candidate) => ({
        id: candidate.id as string,
        ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
        ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
        ...(typeof candidate.description === 'string' ? { description: candidate.description.slice(0, 200) } : {}),
      }));
    issues.push({
      input: record.input,
      ...(typeof record.field === 'string' ? { field: record.field } : {}),
      ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
      ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
      candidates,
    });
  }
  return issues;
}

/** What the harness resolved each name or tag to, from `interpretation` (entities: entityId, tags: tagId). */
function resolvedOf(structured: Record<string, unknown>): QlooResolved[] {
  const interpretation = asRecord(structured.interpretation);
  if (!interpretation) return [];
  const out: QlooResolved[] = [];
  for (const field of ['signals', 'signal_tags', 'include_tags', 'exclude_tags', 'options']) {
    const list = interpretation[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = asRecord(item);
      const id = record?.entityId ?? record?.tagId;
      if (!record || typeof record.input !== 'string' || typeof id !== 'string' || !id) continue;
      out.push({
        field,
        input: record.input,
        id,
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.type === 'string' ? { type: record.type } : {}),
      });
    }
  }
  return out;
}

/** Turn whatever `qloo mcp` returned into the harness envelope. Never throws. */
export function normalizeEnvelope(raw: QlooRawResult | null | undefined): QlooEnvelope {
  const structured = asRecord(raw?.structuredContent) ?? asRecord(parseText(raw?.content));
  if (!structured) {
    return {
      status: 'error',
      summary: raw?.isError ? 'Qloo returned an error.' : 'Qloo returned no structured result.',
      results: [],
      result_count: 0,
    };
  }
  const status: QlooStatus = typeof structured.status === 'string' && STATUSES.has(structured.status)
    ? (structured.status as QlooStatus)
    : raw?.isError ? 'error' : 'ok';
  let results: unknown[] = [];
  if (Array.isArray(structured.results)) {
    results = structured.results;
  } else {
    const nested = asRecord(structured.results);
    const firstArray = nested ? Object.values(nested).find(Array.isArray) : undefined;
    if (firstArray) results = firstArray as unknown[];
  }
  const errorRecord = asRecord(structured.error);
  const envelope: QlooEnvelope = {
    status,
    summary: typeof structured.summary === 'string' ? structured.summary.slice(0, 300) : '',
    results,
    result_count: typeof structured.result_count === 'number' ? structured.result_count : results.length,
  };
  if (errorRecord) {
    envelope.error = {
      ...(typeof errorRecord.code === 'string' ? { code: errorRecord.code } : {}),
      ...(typeof errorRecord.recovery === 'string' ? { recovery: errorRecord.recovery.slice(0, 200) } : {}),
      ...(typeof errorRecord.retryable === 'boolean' ? { retryable: errorRecord.retryable } : {}),
    };
  }
  const issues = issuesOf(structured);
  if (issues.length > 0) envelope.issues = issues;
  const resolved = resolvedOf(structured);
  if (resolved.length > 0) envelope.resolved = resolved;
  return envelope;
}

function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Qloo call failed';
  // Belt and braces: the key is never in our messages, but never echo anything key-shaped.
  const key = process.env.QLOO_API_KEY;
  const scrubbed = key ? text.split(key).join('[redacted]') : text;
  return scrubbed.slice(0, 200);
}

/** A rate limit (429) or a harness error it marks retryable. Not our own 20 s timeout: no time for it. */
export function isRetryable(envelope: QlooEnvelope): boolean {
  if (envelope.status !== 'error') return false;
  if (envelope.error?.code === 'QLOO_RATE_LIMIT') return true;
  if (/\b429\b|rate.?limit/i.test(envelope.summary)) return true;
  if (/timed out after/i.test(envelope.summary)) return false;
  return envelope.error?.retryable === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call one Qloo MCP tool. Cached for 30 minutes per tool+args (ok and empty results only),
 * one in flight by default, 20 s each. Errors come back as an error envelope, never a throw.
 * A retryable error (429) is retried up to twice, holding the slot so other calls back off too,
 * but only when the wait still ends before `deadline`. With a `deadline` (epoch ms) that has
 * passed by the time a slot frees, no call is made: the envelope is an error and `skipped` is true.
 */
export async function callQloo(
  tool: string,
  args: Record<string, unknown>,
  forWho?: string,
  deadline?: number,
): Promise<{ envelope: QlooEnvelope; record: QlooCallRecord; skipped?: true }> {
  const key = `${tool}:${stableStringify(args)}`;
  const started = Date.now();
  let envelope = cacheGet(key);
  let skipped = false;
  let retries = 0;
  if (!envelope) {
    await acquire();
    try {
      if (deadline !== undefined && Date.now() >= deadline) {
        skipped = true;
        envelope = { status: 'error', summary: 'Skipped: out of time.', results: [], result_count: 0 };
      } else {
        for (let attempt = 0; ; attempt += 1) {
          try {
            envelope = normalizeEnvelope(await currentCaller().callTool(tool, args));
          } catch (error) {
            envelope = { status: 'error', summary: safeMessage(error), results: [], result_count: 0 };
          }
          const wait = retryDelaysMs[attempt];
          if (wait === undefined || !isRetryable(envelope)) break;
          if (deadline !== undefined && Date.now() + wait >= deadline) break;
          console.warn(`[taste] ${tool} for ${forWho ?? 'council'}: ${envelope.error?.code ?? 'retryable error'}, retrying in ${wait} ms`);
          await sleep(wait);
          retries += 1;
        }
      }
    } finally {
      release();
    }
    if (envelope.status === 'ok' || envelope.status === 'empty') cachePut(key, envelope);
  }
  const record: QlooCallRecord = {
    tool,
    args,
    status: envelope.status,
    summary: envelope.summary || `${envelope.result_count} result${envelope.result_count === 1 ? '' : 's'}`,
    resultCount: envelope.result_count,
    ms: Date.now() - started,
  };
  if (forWho) record.forWho = forWho;
  if (retries > 0) record.retries = retries;
  return skipped ? { envelope, record, skipped: true } : { envelope, record };
}

/** Whether `qloo mcp` started and has a credential, with the reason when it is not. */
export async function qlooReadiness(): Promise<QlooReadiness> {
  try {
    return await currentCaller().readiness();
  } catch {
    return 'unreachable';
  }
}

/** True when `qloo mcp` started and reports a usable credential. Makes no Qloo API call. */
export async function qlooReady(): Promise<boolean> {
  return (await qlooReadiness()) === 'ready';
}
