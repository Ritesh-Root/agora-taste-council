import { loadJsonFile, writeJson } from '../household/store';
import type { QlooEnvelope, QlooIssue } from './qlooClient';

/**
 * What each loved name and liked tag resolved to in Qloo, remembered for the whole process and saved
 * to taste-entities.json under AGORA_DATA_DIR.
 *
 * The harness resolves a name with an untyped Qloo search, so almost every name is ambiguous
 * ("Coco" is a film and three albums) and the first call of each person answers needs_input. The
 * council picks a candidate once (chooseEntity), remembers it here, and sends the Qloo id from then
 * on: in the retry, in that person's qloo_rank, and in every later council. A name Qloo cannot find
 * is remembered as dropped (id null), so it is not sent again.
 *
 * Keys: `entity|<name>` for signals (the harness resolves them without a type), and
 * `tag:<target type>|<name>` for tags (the harness scopes tag search to the target type).
 */

const MEMO_FILE = 'taste-entities.json';
const MEMO_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_FIELDS = ['signal_tags', 'include_tags', 'exclude_tags'] as const;

export interface MemoEntry {
  /** Qloo entity id or tag URN. null: Qloo could not resolve the name, so it is left out. */
  id: string | null;
  name?: string;
  type?: string;
}

/**
 * The demo family's favourites and tags, as chooseEntity and the harness resolved them in live Qloo
 * councils (2026-10-31, hackathon endpoint). Used only with AGORA_DEMO_SEED=1, so a fresh deploy's first
 * council does not pay the needs_input round trip. A saved taste-entities.json overrides it.
 */
const DEMO_SEED: Record<string, MemoEntry> = {
  'entity|a r rahman': { id: '2D9D42D9-94B6-43EE-BE87-0720AB1BC3EC', name: 'A. R. Rahman', type: 'urn:entity:person' },
  'entity|arijit singh': { id: '924C8504-4BD8-4615-AB2D-1C16880A8A62', name: 'Arijit Singh', type: 'urn:entity:artist' },
  'entity|coco': { id: '649672AD-38A4-42C7-BAAC-BBD2D5BEEFA0', name: 'Coco', type: 'urn:entity:movie' },
  'entity|encanto': { id: '5C6428A2-60CA-4776-8E38-5F554EE2D0D7', name: 'Encanto', type: 'urn:entity:movie' },
  'entity|interstellar': { id: '057DA9D9-399B-437E-8BCA-A80E499125EF', name: 'Interstellar', type: 'urn:entity:movie' },
  'entity|lata mangeshkar': { id: 'D32E8668-E3B1-4919-BFA5-6870900EAC80', name: 'Lata Mangeshkar', type: 'urn:entity:artist' },
  'entity|mughal e azam': { id: '23E081CF-CEFB-4E12-8337-867F25F5D1FC', name: 'Mughal-E-Azam', type: 'urn:entity:movie' },
  'entity|raj kapoor': { id: '33570164-90C4-4D2A-8A22-DD9B80114F9E', name: 'Raj Kapoor', type: 'urn:entity:person' },
  'entity|spider man into the spider verse': { id: '7CCA6DC8-1092-41E6-92CA-2C2F8AD0A822', name: 'Spider-Man: Into the Spider-Verse', type: 'urn:entity:movie' },
  'entity|taylor swift': { id: '4BBEF799-A0C4-4110-AB01-39216993C312', name: 'Taylor Swift', type: 'urn:entity:artist' },
  'tag:artist|street food': { id: null },
  'tag:artist|thrillers': { id: 'urn:tag:genre:qloo:thriller', name: 'Thriller' },
  'tag:book|street food': { id: null },
  'tag:book|thrillers': { id: 'urn:tag:genre:qloo:thrillers', name: 'Thrillers' },
  'tag:movie|street food': { id: null },
  'tag:movie|thrillers': { id: 'urn:tag:interests:qloo:thrillers', name: 'Thrillers' },
  'tag:place|street food': { id: 'urn:tag:cuisine:qloo:street_food', name: 'Street Food' },
  'tag:place|thrillers': { id: 'urn:tag:interests:qloo:cinematic_thrillers', name: 'Cinematic Thrillers' },
  'tag:tv_show|street food': { id: null },
  'tag:tv_show|thrillers': { id: 'urn:tag:interests:qloo:thrillers', name: 'Thrillers' },
};

let memo: Map<string, MemoEntry> | null = null;
let loading: Promise<void> | null = null;
let saving: Promise<void> = Promise.resolve();

export function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isQlooId(value: string): boolean {
  return UUID.test(value) || value.startsWith('urn:');
}

function entityKey(name: string): string {
  return `entity|${normalizeName(name)}`;
}

function tagKey(target: string, name: string): string {
  return `tag:${target}|${normalizeName(name)}`;
}

function isEntry(value: unknown): value is MemoEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const id = (value as Record<string, unknown>).id;
  return id === null || (typeof id === 'string' && id.length > 0 && id.length < 200);
}

function isMemoFile(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Load the saved memo once (and the demo seed when AGORA_DEMO_SEED=1). Never throws. */
export async function loadEntityMemo(): Promise<void> {
  if (memo) return;
  loading ??= (async () => {
    const next = new Map<string, MemoEntry>();
    if (process.env.AGORA_DEMO_SEED?.trim() === '1') {
      for (const [key, entry] of Object.entries(DEMO_SEED)) next.set(key, entry);
    }
    try {
      const saved = await loadJsonFile(MEMO_FILE, isMemoFile);
      if (saved && typeof saved === 'object') {
        for (const [key, entry] of Object.entries(saved as Record<string, unknown>)) {
          if (isEntry(entry)) next.set(key, { id: entry.id, ...(entry.name ? { name: String(entry.name) } : {}), ...(entry.type ? { type: String(entry.type) } : {}) });
        }
      }
    } catch {
      // A missing or unreadable file only means the names resolve again.
    }
    // Entries learned while the file was loading win over the file.
    const learned = memo as Map<string, MemoEntry> | null;
    for (const [key, entry] of learned ?? []) next.set(key, entry);
    memo = next;
  })().finally(() => {
    loading = null;
  });
  await loading;
}

/** Tests: forget everything, in memory only. */
export function resetEntityMemo(): void {
  memo = null;
  loading = null;
}

/** Tests and diagnostics: a copy of the memo. */
export function entityMemoSnapshot(): Record<string, MemoEntry> {
  return Object.fromEntries(memo ?? []);
}

function store(key: string, entry: MemoEntry): boolean {
  memo ??= new Map();
  const old = memo.get(key);
  if (old && old.id === entry.id) return false;
  memo.delete(key);
  memo.set(key, entry);
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
  return true;
}

function save(): void {
  const body = entityMemoSnapshot();
  saving = saving.then(() => writeJson(MEMO_FILE, body)).catch((error: unknown) => {
    console.error('[taste] could not save the entity memo:', error instanceof Error ? error.message : 'write failed');
  });
}

/** Tests: wait for pending saves. */
export function entityMemoSaved(): Promise<void> {
  return saving;
}

// ---- choosing among Qloo's candidates ----

/** Lower is better. Taste signals are works and artists, not albums of the same name or towns. */
const TYPE_COST: Record<string, number> = {
  artist: 0,
  movie: 0,
  tv_show: 0,
  book: 0,
  // A singer is both a person and an artist in Qloo; the artist entity carries the music taste.
  person: 0.5,
  podcast: 0.5,
  videogame: 0.5,
  author: 1,
  brand: 1.5,
  place: 2,
  album: 2.5,
};

function bareType(type: string | undefined): string {
  return (type ?? '').replace(/^urn:entity:/, '');
}

/**
 * Pick the candidate a person most likely meant: a work, artist or person over an album or a place,
 * one Qloo describes over a bare record, an exact name over a near one, then Qloo's order.
 * Localities are never taste signals. null when nothing fits.
 */
export function chooseEntity(input: string, candidates: QlooIssue['candidates']): QlooIssue['candidates'][number] | null {
  const wanted = normalizeName(input);
  let best: { candidate: QlooIssue['candidates'][number]; cost: number } | null = null;
  for (const candidate of candidates) {
    const type = bareType(candidate.type);
    if (type === 'locality') continue;
    const cost = (TYPE_COST[type] ?? 1)
      + (candidate.description ? 0 : 1)
      + (candidate.name && normalizeName(candidate.name) === wanted ? 0 : 0.5);
    if (!best || cost < best.cost) best = { candidate, cost };
  }
  return best?.candidate ?? null;
}

// ---- learning and substituting ----

function targetOf(args: Record<string, unknown>): string {
  return String(args.target_type ?? args.option_type ?? '');
}

/**
 * Remember what a result says about its inputs: the ids the harness resolved (ok results), and a
 * choice for each unresolved input (needs_input). Options are not remembered: they are ids already.
 */
export function learnFromEnvelope(args: Record<string, unknown>, envelope: QlooEnvelope): void {
  const target = targetOf(args);
  let changed = false;
  for (const resolved of envelope.resolved ?? []) {
    if (isQlooId(resolved.input)) continue;
    if (resolved.field === 'signals') {
      changed = store(entityKey(resolved.input), { id: resolved.id, ...(resolved.name ? { name: resolved.name } : {}), ...(resolved.type ? { type: resolved.type } : {}) }) || changed;
    } else if ((TAG_FIELDS as readonly string[]).includes(resolved.field)) {
      changed = store(tagKey(target, resolved.input), { id: resolved.id, ...(resolved.name ? { name: resolved.name } : {}) }) || changed;
    }
  }
  if (envelope.status === 'needs_input') {
    for (const issue of envelope.issues ?? []) {
      if (isQlooId(issue.input)) continue;
      if (issue.field === 'signals') {
        const choice = chooseEntity(issue.input, issue.candidates);
        changed = store(entityKey(issue.input), choice
          ? { id: choice.id, ...(choice.name ? { name: choice.name } : {}), ...(choice.type ? { type: choice.type } : {}) }
          : { id: null }) || changed;
      } else if (issue.field && (TAG_FIELDS as readonly string[]).includes(issue.field)) {
        const choice = issue.candidates[0];
        changed = store(tagKey(target, issue.input), choice ? { id: choice.id, ...(choice.name ? { name: choice.name } : {}) } : { id: null }) || changed;
      }
    }
  }
  if (changed) save();
}

function substituteList(values: unknown, lookup: (value: string) => MemoEntry | undefined): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const entry = isQlooId(value) ? undefined : lookup(value);
    const next = entry === undefined ? value : entry.id;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * The same arguments with every remembered name and tag replaced by its Qloo id, and remembered
 * dead ends dropped. A list left empty is removed (with its operator).
 */
export function withKnownIds(args: Record<string, unknown>): Record<string, unknown> {
  if (!memo || memo.size === 0) return args;
  const known = memo;
  const target = targetOf(args);
  const next: Record<string, unknown> = { ...args };
  const signals = substituteList(args.signals, (value) => known.get(entityKey(value)));
  if (signals) {
    if (signals.length > 0) next.signals = signals;
    else delete next.signals;
  }
  for (const field of TAG_FIELDS) {
    const tags = substituteList(args[field], (value) => known.get(tagKey(target, value)));
    if (!tags) continue;
    if (tags.length > 0) {
      next[field] = tags;
    } else {
      delete next[field];
      delete next[`${field}_operator`];
    }
  }
  return next;
}
