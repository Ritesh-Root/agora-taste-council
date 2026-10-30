import {
  OCCASION_TARGET,
  type CouncilPick,
  type CouncilRequest,
  type CouncilResult,
  type KeeperVeto,
  type MemberFit,
  type QlooCallRecord,
  type TasteMember,
  type TasteOccasion,
  type TasteSnapshot,
} from '../../shared/taste';
import { loadJsonFile, writeJson } from '../household/store';
import { learnFromEnvelope, loadEntityMemo, withKnownIds } from './entityMemo';
import { buildTasteProfile, type TasteProfile } from './profile';
import { callQloo, qlooReadiness, type QlooEnvelope } from './qlooClient';

/**
 * The Taste Council. Per person: qloo_recommend for candidates, then qloo_rank of one shared shortlist.
 * Qloo scores from separate calls are not comparable, so only each person's ordinal rank is used.
 * Pick by maximin (best worst rank, then best mean rank), then Keeper vetoes diet and "no X" conflicts.
 */

export const TASTE_OCCASIONS: readonly TasteOccasion[] = ['movie_night', 'dinner_out', 'playlist', 'tv_show', 'book_club', 'outing'];

const RECENT_FILE = 'taste-recent.json';
const RECENT_MAX = 5;
const MAX_SIGNALS = 4;
const MAX_TAGS = 3;
const RECOMMEND_LIMIT = 8;
/** With a child in the council, films, shows and books ask for more, so the adult ones can be left out. */
const RECOMMEND_LIMIT_WITH_CHILD = 12;
/** qloo_rank accepts at most 10 options. */
const SHORTLIST_MAX = 10;
const PICKS_MAX = 5;
/**
 * Past this, queued Qloo calls are skipped and the council answers with what it has. A call that
 * started just before can still take its own 20 s, which keeps the whole under the UI's 60 s.
 */
const COUNCIL_DEADLINE_MS = 40_000;

const OCCASION_PHRASE: Record<TasteOccasion, string> = {
  movie_night: 'movie night',
  dinner_out: 'dinner out',
  playlist: 'the playlist',
  tv_show: 'a show together',
  book_club: 'book club',
  outing: 'the weekend outing',
};

/** Phrases Qloo's demographic parser maps to age buckets. */
const AGE_PHRASE: Record<NonNullable<TasteMember['ageBand']>, string> = {
  '0-17': 'teens',
  '18-24': 'young adults 18-24',
  '25-34': 'adults 25-34',
  '35-44': 'adults 35-44',
  '45-54': 'adults 45-54',
  '55+': 'seniors',
};

export function demographicFor(member: TasteMember): string | undefined {
  return member.ageBand ? AGE_PHRASE[member.ageBand] : undefined;
}

// ---- places ----

/** Qloo's restaurant genre: dinner out returns places to eat. */
const DINNER_TAGS = ['urn:tag:genre:place:restaurant'];
/** Qloo place categories for a family day out (qloo_recommend takes at most 10 include tags). */
const OUTING_TAGS = [
  'urn:tag:category:place:museum',
  'urn:tag:category:place:park',
  'urn:tag:category:place:amusement_park',
  'urn:tag:category:place:tourist_attraction',
  'urn:tag:category:place:zoo',
  'urn:tag:category:place:aquarium',
  'urn:tag:category:place:science_museum',
  'urn:tag:category:place:water_park',
  'urn:tag:category:place:theme_park',
  'urn:tag:category:place:botanical_garden',
];

/**
 * Qloo matches a location string as one place name: "Bandra, Mumbai" finds nothing, while "Bandra"
 * and "Mumbai" both work. So places are filtered to the first part ("Bandra"), and the audience
 * signal uses the next part, the city ("Mumbai"). A single name is used for both.
 */
export function splitLocation(location: string): { signal: string; filter: string } {
  const parts = location.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length < 2) return { signal: location.trim(), filter: location.trim() };
  return { signal: parts[1], filter: parts[0] };
}

// ---- children ----

/** Ratings meant for adults only: MPA, US TV, Indian CBFC, and common 18 marks. */
const ADULT_RATING = /^(?:r|nc-?17|tv-?ma|a|x|xxx|ao|18\+?|r-?18|m-?18|ma-?18|nr-?18)$/i;
/** Profanity in a title, masked or not ("F*ck", "Sh*t"). Checked on names only. */
const PROFANE_TITLE = [
  /f(?:u|\*)(?:c|\*)k/i,
  /\bsh(?:i|\*|!)t/i,
  /\bb(?:i|\*)tch/i,
  /\bc(?:u|\*)nt\b/i,
  /\ba(?:ss|\*\*)hole/i,
  /\bbastard/i,
  /\bmotherf/i,
];
/** Adult content named in the title or Qloo's description. */
const ADULT_TOPIC = /\b(?:erotic\w*|porn\w*|xxx|nsfw|explicit sex\w*)\b/i;

/** Why a candidate is not for a council with a child in it, or null when it is fine. */
export function adultReason(candidate: Pick<Candidate, 'name' | 'rating' | 'text'>): 'rating' | 'title' | null {
  const rating = candidate.rating?.trim().replace(/^(?:rated|certificate)\s+/i, '');
  if (rating && ADULT_RATING.test(rating)) return 'rating';
  if (PROFANE_TITLE.some((pattern) => pattern.test(candidate.name))) return 'title';
  if (ADULT_TOPIC.test(candidate.text)) return 'title';
  return null;
}

// ---- candidates ----

interface Candidate {
  key: string;
  entityId?: string;
  name: string;
  subtitle?: string;
  imageUrl?: string;
  tags: string[];
  /** Qloo's content rating ("PG-13", "TV-MA"), when it returned one. */
  rating?: string;
  /** Name, tags, subtitle, description: what Keeper reads. */
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function imageOf(item: Record<string, unknown>, props: Record<string, unknown> | null): string | undefined {
  for (const source of [props?.image, item.image, props?.images, item.image_url, props?.image_url]) {
    const first = Array.isArray(source) ? source[0] : source;
    const url = typeof first === 'string' ? first : str(asRecord(first)?.url);
    if (url && /^https:\/\//i.test(url)) return url;
  }
  return undefined;
}

function tagsOf(item: Record<string, unknown>, props: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  for (const source of [item.tags, props?.tags, props?.genres, props?.keywords]) {
    if (!Array.isArray(source)) continue;
    for (const tag of source) {
      const name = typeof tag === 'string' ? tag : str(asRecord(tag)?.name);
      if (!name || name.startsWith('urn:') || name.length > 40) continue;
      if (!out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function subtitleOf(props: Record<string, unknown> | null): string | undefined {
  if (!props) return undefined;
  const parts: string[] = [];
  const year = str(props.release_year) ?? str(props.release_date)?.slice(0, 4);
  if (year) parts.push(year);
  const rating = str(props.content_rating);
  if (rating) parts.push(rating);
  const address = str(props.address);
  if (address) parts.push(address.split(',').slice(0, 2).join(',').trim());
  const price = typeof props.price_level === 'number' && props.price_level > 0 && props.price_level <= 4
    ? '₹'.repeat(props.price_level)
    : undefined;
  if (price) parts.push(price);
  return parts.length > 0 ? parts.join(' · ').slice(0, 120) : undefined;
}

/** One Qloo result item -> a candidate. Tolerates missing fields; null when there is no name. */
export function candidateFrom(raw: unknown): Candidate | null {
  const item = asRecord(raw);
  if (!item) return null;
  const props = asRecord(item.properties);
  const name = str(item.name) ?? str(props?.name);
  if (!name) return null;
  const entityId = str(item.entity_id) ?? str(item.id) ?? str(item.entityId);
  const tags = tagsOf(item, props);
  const subtitle = subtitleOf(props);
  const description = str(props?.short_description) ?? str(props?.description) ?? '';
  const candidate: Candidate = {
    key: entityId ? `id:${entityId}` : `name:${name.toLowerCase()}`,
    name: name.slice(0, 120),
    tags,
    text: [name, ...tags, subtitle ?? '', description].join(' • ').toLowerCase(),
  };
  if (entityId) candidate.entityId = entityId;
  if (subtitle) candidate.subtitle = subtitle;
  const rating = str(props?.content_rating);
  if (rating) candidate.rating = rating.slice(0, 20);
  const imageUrl = imageOf(item, props);
  if (imageUrl) candidate.imageUrl = imageUrl;
  return candidate;
}

/** Round-robin across people so everyone contributes, deduped by entity id (or name). */
export function roundRobin(lists: Candidate[][], max = SHORTLIST_MAX): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest && out.length < max; index += 1) {
    for (const list of lists) {
      const candidate = list[index];
      if (!candidate || seen.has(candidate.key) || names.has(candidate.name.toLowerCase())) continue;
      seen.add(candidate.key);
      names.add(candidate.name.toLowerCase());
      out.push(candidate);
      if (out.length >= max) break;
    }
  }
  return out;
}

// ---- maximin ----

export interface MemberRanking {
  who: string;
  because: string[];
  /** Candidate keys in Qloo's order, best first. null when the rank call failed or was skipped. */
  order: string[] | null;
  /** True when the person had nothing Qloo can rank with (no named favourite, no location). */
  skipped?: boolean;
}

interface Scored extends Candidate {
  worstRank: number;
  meanRank: number;
  fits: MemberFit[];
  position: number;
}

/**
 * Score each candidate. A person whose call failed is left out of the score (their fit is null).
 * An option missing from a successful ranking counts as last (rank = shortlist size) but shows null.
 */
export function scoreShortlist(shortlist: Candidate[], rankings: MemberRanking[]): Scored[] {
  const of = shortlist.length;
  const scored = shortlist.map((candidate, position) => {
    const fits: MemberFit[] = [];
    const counted: number[] = [];
    for (const ranking of rankings) {
      if (!ranking.order) {
        fits.push({ who: ranking.who, rank: null, of, because: ranking.because });
        continue;
      }
      const index = ranking.order.indexOf(candidate.key);
      const rank = index >= 0 ? index + 1 : null;
      fits.push({ who: ranking.who, rank, of, because: ranking.because });
      counted.push(rank ?? of);
    }
    const worstRank = counted.length > 0 ? Math.max(...counted) : of;
    const meanRank = counted.length > 0 ? counted.reduce((sum, rank) => sum + rank, 0) / counted.length : of;
    return { ...candidate, worstRank, meanRank: Math.round(meanRank * 100) / 100, fits, position };
  });
  scored.sort((a, b) => a.worstRank - b.worstRank || a.meanRank - b.meanRank || a.position - b.position);
  return scored;
}

// ---- Keeper ----

const DIET_WORDS: Record<string, string[]> = {
  vegetarian: ['steakhouse', 'steak house', 'steak', 'bbq', 'barbecue', 'barbeque', 'meat', 'butcher', 'churrascaria', 'smokehouse', 'chophouse', 'rodizio', 'brazilian grill'],
  vegan: ['steakhouse', 'steak house', 'steak', 'bbq', 'barbecue', 'barbeque', 'meat', 'butcher', 'churrascaria', 'smokehouse', 'chophouse', 'cheese', 'dairy', 'creamery', 'ice cream'],
  pescatarian: ['steakhouse', 'steak house', 'steak', 'bbq', 'barbecue', 'barbeque', 'butcher', 'churrascaria', 'chophouse'],
  halal: ['pork', 'bacon', 'ham', 'brewery', 'brewpub'],
  jain: ['steakhouse', 'steak', 'bbq', 'barbecue', 'meat'],
  teetotal: ['brewery', 'brewpub', 'wine bar', 'pub', 'cocktail bar'],
};

const ALLERGEN_WORDS: Record<string, string[]> = {
  peanut: ['peanut', 'peanuts', 'satay', 'groundnut'],
  nut: ['nut', 'nuts', 'peanut', 'almond', 'cashew', 'praline'],
  shellfish: ['shellfish', 'seafood', 'oyster', 'crab', 'lobster', 'shrimp', 'prawn'],
  seafood: ['seafood', 'fish', 'oyster', 'crab', 'lobster', 'shrimp', 'prawn', 'sushi'],
  fish: ['fish', 'seafood', 'sushi'],
  dairy: ['dairy', 'cheese', 'creamery', 'ice cream', 'gelato'],
  milk: ['dairy', 'cheese', 'creamery', 'ice cream', 'gelato'],
  gluten: ['bakery', 'pizza', 'pizzeria', 'pasta', 'brewery'],
  wheat: ['bakery', 'pizza', 'pizzeria', 'pasta'],
  egg: ['egg', 'eggs'],
};

/** Diets the profile parser knows that have no reliable place words: Keeper does not guess. */
const DIETS_WITHOUT_WORDS: ReadonlySet<string> = new Set(['kosher', 'coeliac', 'diabetic', 'lactose intolerant']);

/** "boxes" -> "box", "glasses" -> "glass", "zombies" -> "zombie", "horses" -> "horse". */
function singular(word: string): string {
  if (/(?:x|z|ch|sh|ss)es$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, word: string): boolean {
  return new RegExp(`(?:^|[^a-z])${escapeRegex(word.toLowerCase())}(?:s|es)?(?:[^a-z]|$)`, 'i').test(text);
}

/** Words that conflict with one constraint, for this target. Diet and allergy apply to places only. */
export function conflictWords(constraint: string, target: string): string[] {
  const value = constraint.toLowerCase().trim();
  const avoid = value.match(/^no\s+(.+)$/);
  if (avoid) return [singular(avoid[1].trim())].filter((word) => word.length > 1);
  if (target !== 'place') return [];
  if (DIET_WORDS[value]) return DIET_WORDS[value];
  if (DIETS_WITHOUT_WORDS.has(value)) return [];
  // Whole words only: "tree nuts" is a nut allergy, "coconut" and "nutmeg" are not.
  const key = Object.keys(ALLERGEN_WORDS).find((name) => singular(value) === name || value.startsWith(`${name} `) || singular(value).endsWith(` ${name}`));
  if (key) return ALLERGEN_WORDS[key];
  return [singular(value)].filter((word) => word.length > 2);
}

export function keeperCheck(
  candidates: Scored[],
  members: TasteMember[],
  target: string,
  constraintFacts: Map<string, string>,
): { kept: Scored[]; vetoes: KeeperVeto[] } {
  const kept: Scored[] = [];
  const vetoes: KeeperVeto[] = [];
  for (const candidate of candidates) {
    let veto: KeeperVeto | null = null;
    for (const member of members) {
      for (const constraint of member.constraints) {
        if (!conflictWords(constraint, target).some((word) => mentions(candidate.text, word))) continue;
        const fact = constraintFacts.get(`${member.who.toLowerCase()}|${constraint.toLowerCase()}`) ?? `${member.who}: ${constraint}`;
        veto = { name: candidate.name, fact, who: member.who };
        break;
      }
      if (veto) break;
    }
    if (veto) vetoes.push(veto);
    else kept.push(candidate);
  }
  return { kept, vetoes };
}

// ---- speech ----

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * The spoken sentence, from the winner's ranks. Only people Qloo actually ranked it for are named as
 * ranking it; anyone else is named as not ranked. With `ranked: false` (no qloo_rank call answered,
 * so the order is each person's recommendations), it says so and claims no ranks.
 */
/** A long subtitled title is spoken by its main part: "I Am Malala: The Story of ..." -> "I Am Malala". */
export function spokenName(name: string): string {
  if (name.length <= 40) return name;
  const main = name.split(/:\s/)[0]?.trim();
  return main && main.length >= 3 ? main : name;
}

export function councilSpeech(
  occasion: TasteOccasion,
  picks: CouncilPick[],
  vetoes: KeeperVeto[],
  options: { ranked?: boolean } = {},
): string {
  const phrase = OCCASION_PHRASE[occasion];
  const top = picks[0];
  if (!top) {
    return vetoes.length > 0
      ? `Keeper set aside every option Qloo found for ${phrase}, so I have no pick yet.`
      : `Qloo did not find options for ${phrase} this time.`;
  }
  const name = spokenName(top.name);
  const ranked = options.ranked === false ? [] : top.fits.filter((fit) => fit.rank !== null);
  const unranked = options.ranked === false ? [] : top.fits.filter((fit) => fit.rank === null).map((fit) => fit.who);
  const people = listNames(ranked.map((fit) => fit.who));
  const everyone = unranked.length === 0;
  const worst = Math.max(0, ...ranked.map((fit) => fit.rank ?? 0));
  let first: string;
  if (options.ranked === false) {
    first = `For ${phrase}, Qloo's suggestions point to ${name}.`;
  } else if (ranked.length === 0) {
    first = `For ${phrase}, Qloo suggests ${name}.`;
  } else if (ranked.length > 1 && everyone && worst === 1) {
    first = `For ${phrase}, ${name} is everyone's first choice: ${people} ${ranked.length === 2 ? 'both' : 'all'} rank it first.`;
  } else if (ranked.length === 1) {
    first = worst === 1
      ? `For ${phrase}, ${name} is ${people}'s top choice.`
      : `For ${phrase}, ${name} ranks ${ordinal(worst)} for ${people}.`;
  } else if (worst <= 3) {
    first = everyone
      ? `For ${phrase}, ${name} works for everyone: it ranks in the top ${worst} for ${people}.`
      : `For ${phrase}, ${name} ranks in the top ${worst} for ${people}.`;
  } else {
    first = everyone
      ? `For ${phrase}, ${name} is the fairest pick: nobody ranks it lower than ${ordinal(worst)} of ${top.fits[0]?.of ?? picks.length}.`
      : `For ${phrase}, ${name} is the fairest pick: ${people} rank it no lower than ${ordinal(worst)} of ${top.fits[0]?.of ?? picks.length}.`;
  }
  const missing = ranked.length > 0 && unranked.length > 0 ? ` Qloo has no rank from ${listNames(unranked)} for it.` : '';
  const veto = vetoes[0];
  const second = veto ? ` Keeper set aside ${spokenName(veto.name)} because ${veto.fact.replace(/[.!?]+$/, '')}.` : '';
  return `${first}${missing}${second}`;
}

// ---- recent ----

let recent: CouncilResult[] | null = null;

function isResultList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => !!asRecord(item) && typeof (item as Record<string, unknown>).occasion === 'string');
}

export async function listRecentCouncils(): Promise<CouncilResult[]> {
  if (recent) return recent.slice();
  let loaded: CouncilResult[] = [];
  try {
    const value = await loadJsonFile(RECENT_FILE, isResultList);
    if (Array.isArray(value)) loaded = (value as CouncilResult[]).slice(0, RECENT_MAX);
  } catch {
    loaded = [];
  }
  // A council that finished while the file was loading has already set the list; keep it.
  recent ??= loaded;
  return recent.slice();
}

async function remember(result: CouncilResult): Promise<void> {
  await listRecentCouncils();
  // Rebuild from the live list, not a copy from before the await, so concurrent councils all stay.
  recent = [result, ...(recent ?? [])].slice(0, RECENT_MAX);
  try {
    await writeJson(RECENT_FILE, recent);
  } catch (error) {
    console.error('[taste] could not save recent councils:', error instanceof Error ? error.message : 'write failed');
  }
}

/** Tests: forget the in-memory copy so the next read loads the file again. */
export function resetRecentCouncils(): void {
  recent = null;
}

// ---- the council ----

function cleanList(values: string[] | undefined, max: number): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0).slice(0, max);
}

/**
 * On needs_input. learnFromEnvelope has already remembered a choice for each unresolved name and tag
 * (a work or artist over an album of the same name, see chooseEntity), so withKnownIds swaps them in.
 * What is left: an option Qloo cannot resolve is dropped, and a demographic it cannot read is dropped.
 */
function repairArgs(args: Record<string, unknown>, envelope: QlooEnvelope): Record<string, unknown> | null {
  const next = withKnownIds(args);
  const issues = envelope.issues ?? [];
  for (const field of ['signals', 'signal_tags', 'exclude_tags', 'include_tags', 'options']) {
    const values = next[field];
    if (!Array.isArray(values)) continue;
    const repaired: string[] = [];
    for (const value of values as string[]) {
      const issue = issues.find((item) => item.input === value && (!item.field || item.field === field));
      if (!issue) {
        repaired.push(value);
        continue;
      }
      // Not remembered (an option, or a field the memo does not keep): first candidate, else drop.
      const candidate = issue.candidates[0]?.id;
      if (candidate && field !== 'options') repaired.push(candidate);
    }
    if (repaired.length > 0) next[field] = repaired;
    else delete next[field];
  }
  if (/demographic/i.test(envelope.summary) && next.demographic) delete next.demographic;
  return JSON.stringify(next) !== JSON.stringify(args) ? next : null;
}

/** The council's time budget. `outOfTime` is set when a call was skipped for it. */
interface Budget {
  deadline: number;
  outOfTime: boolean;
}

/**
 * One Qloo call with remembered ids swapped in first, and one repair on needs_input. Every answer
 * teaches the entity memo, so the next call (and the next council) sends ids and skips the repair.
 */
async function callWithRepair(
  tool: string,
  args: Record<string, unknown>,
  who: string,
  calls: QlooCallRecord[],
  budget: Budget,
): Promise<{ envelope: QlooEnvelope; args: Record<string, unknown> }> {
  const sent = withKnownIds(args);
  const first = await callQloo(tool, sent, who, budget.deadline);
  if (first.skipped) {
    budget.outOfTime = true;
    return { envelope: first.envelope, args: sent };
  }
  calls.push(first.record);
  learnFromEnvelope(sent, first.envelope);
  if (first.envelope.status !== 'needs_input') return { envelope: first.envelope, args: sent };
  const repaired = repairArgs(sent, first.envelope);
  if (!repaired) return { envelope: first.envelope, args: sent };
  if (tool === 'qloo_recommend' && !repaired.signals && !repaired.signal_tags && !repaired.demographic && !repaired.signal_location) {
    return { envelope: first.envelope, args: sent };
  }
  if (tool === 'qloo_rank' && (!Array.isArray(repaired.options) || repaired.options.length === 0)) {
    return { envelope: first.envelope, args: sent };
  }
  const second = await callQloo(tool, repaired, who, budget.deadline);
  if (second.skipped) {
    budget.outOfTime = true;
    return { envelope: second.envelope, args: repaired };
  }
  calls.push(second.record);
  learnFromEnvelope(repaired, second.envelope);
  return { envelope: second.envelope, args: repaired };
}

function usable(status: QlooEnvelope['status']): boolean {
  return status === 'ok' || status === 'partial' || status === 'degraded' || status === 'empty';
}

function sharedSignals(member: TasteMember, location: string | undefined, target: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const loves = cleanList(member.loves, MAX_SIGNALS);
  if (loves.length > 0) args.signals = loves;
  // Qloo needs a location with a demographic, so the audience geography is explicit.
  if (location) {
    args.signal_location = splitLocation(location).signal;
    const demographic = demographicFor(member);
    if (demographic) args.demographic = demographic;
  }
  const avoid = member.constraints
    .map((constraint) => constraint.match(/^no\s+(.+)$/i)?.[1]?.trim())
    .filter((value): value is string => !!value)
    .slice(0, 3);
  if (avoid.length > 0 && target !== 'place') args.exclude_tags = avoid;
  return args;
}

/** What qloo_recommend gets beyond the shared signals: place kind and area, and a bigger list for a child. */
function recommendFilters(occasion: TasteOccasion, location: string | undefined, withChild: boolean): Record<string, unknown> {
  const target = OCCASION_TARGET[occasion];
  const args: Record<string, unknown> = {};
  if (target === 'place') {
    if (location) args.filter_location = splitLocation(location).filter;
    if (occasion === 'dinner_out') {
      args.include_tags = DINNER_TAGS;
    } else {
      args.include_tags = OUTING_TAGS;
      args.include_tags_operator = 'union';
      args.exclude_tags = DINNER_TAGS;
    }
  }
  if (withChild && target !== 'place') args.limit = RECOMMEND_LIMIT_WITH_CHILD;
  return args;
}

function pickFrom(scored: Scored): CouncilPick {
  const pick: CouncilPick = {
    name: scored.name,
    worstRank: scored.worstRank,
    meanRank: scored.meanRank,
    fits: scored.fits,
    tags: scored.tags,
  };
  if (scored.entityId) pick.entityId = scored.entityId;
  if (scored.subtitle) pick.subtitle = scored.subtitle;
  if (scored.imageUrl) pick.imageUrl = scored.imageUrl;
  return pick;
}

function errorResult(
  base: Pick<CouncilResult, 'occasion' | 'location' | 'members' | 'startedAt'>,
  started: number,
  note: string,
  calls: QlooCallRecord[] = [],
): CouncilResult {
  const result: CouncilResult = {
    ...base,
    picks: [],
    vetoes: [],
    speech: note,
    calls,
    status: 'error',
    note,
    ms: Date.now() - started,
  };
  if (!result.location) delete result.location;
  return result;
}

export function selectMembers(all: TasteMember[], who: string[] | undefined): { members: TasteMember[]; missing: string[] } {
  const asked = cleanList(who, 8);
  if (asked.length === 0) {
    return { members: all.filter((member) => member.loves.length + member.likesTags.length > 0), missing: [] };
  }
  const wanted = new Set(asked.map((name) => name.toLowerCase()));
  const members = all.filter((member) => wanted.has(member.who.toLowerCase()));
  const found = new Set(members.map((member) => member.who.toLowerCase()));
  return { members, missing: asked.filter((name) => !found.has(name.toLowerCase())) };
}

const OUT_OF_TIME_NOTE = 'The council ran out of time, so some Qloo calls were skipped.';

export async function runCouncil(
  req: CouncilRequest,
  deps: { profile?: TasteProfile; deadlineMs?: number } = {},
): Promise<CouncilResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const occasion = req.occasion;
  const target = OCCASION_TARGET[occasion];
  const location = req.location?.trim().slice(0, 80) || process.env.AGORA_TASTE_LOCATION?.trim().slice(0, 80) || undefined;
  const profile = deps.profile ?? await buildTasteProfile();
  const { members, missing } = selectMembers(profile.members, req.who);
  const base = { occasion, members, startedAt, ...(location ? { location } : {}) };

  if (members.length === 0) {
    const note = missing.length > 0
      ? `I don't know what ${listNames(missing)} likes yet. Tell me something like "${missing[0]} loves Encanto".`
      : 'I don\'t know anyone\'s taste yet. Tell me something like "Mia loves Encanto".';
    return errorResult(base, started, note);
  }
  if (members.every((member) => member.loves.length + member.likesTags.length === 0)) {
    const names = members.map((member) => member.who);
    return errorResult(base, started, `I don't know what ${listNames(names)} likes yet. Tell me something like "${names[0]} loves Encanto".`);
  }

  const readiness = await qlooReadiness();
  if (readiness !== 'ready') {
    const note = readiness === 'unconfigured'
      ? 'Qloo is not set up on this server yet. Run qloo setup or set QLOO_API_KEY, then ask again.'
      : 'I could not reach Qloo on this server. Check that the qloo command is installed.';
    // Not saved to recent: an unconfigured server would otherwise fill the list with the same error.
    return errorResult(base, started, note);
  }

  const calls: QlooCallRecord[] = [];
  const budget: Budget = { deadline: started + (deps.deadlineMs ?? COUNCIL_DEADLINE_MS), outOfTime: false };
  await loadEntityMemo();
  const children = members.filter((member) => member.ageBand === '0-17').map((member) => member.who);
  const childSafe = children.length > 0 && target !== 'place';
  const leftOutForChildren = new Set<string>();
  /** People whose qloo_recommend answer (after one repair) was not usable. A repaired needs_input is not a failure. */
  const recommendFailed: string[] = [];

  // b. Candidates per person.
  const perMember = await Promise.all(members.map(async (member) => {
    const args: Record<string, unknown> = {
      target_type: target,
      limit: RECOMMEND_LIMIT,
      ...sharedSignals(member, location, target),
      ...recommendFilters(occasion, location, childSafe),
    };
    const tags = cleanList(member.likesTags, MAX_TAGS);
    if (tags.length > 0) {
      args.signal_tags = tags;
      args.signal_tags_operator = 'union';
    }
    if (!args.signals && !args.signal_tags && !args.signal_location) return { member, list: [] as Candidate[], ok: false };
    const { envelope } = await callWithRepair('qloo_recommend', args, member.who, calls, budget);
    if (!usable(envelope.status)) {
      recommendFailed.push(member.who);
      return { member, list: [] as Candidate[], ok: false };
    }
    let list = envelope.results.map(candidateFrom).filter((candidate): candidate is Candidate => !!candidate);
    if (childSafe) {
      list = list.filter((candidate) => {
        if (!adultReason(candidate)) return true;
        leftOutForChildren.add(candidate.key);
        return false;
      });
    }
    return { member, list, ok: true };
  }));
  const childNote = leftOutForChildren.size > 0
    ? `Left out ${leftOutForChildren.size === 1 ? 'one suggestion' : `${leftOutForChildren.size} suggestions`} rated for adults or with an explicit title, because ${listNames(children)} ${children.length === 1 ? 'is' : 'are'} under 18.`
    : undefined;

  const anyRecommend = perMember.some((entry) => entry.ok);
  if (!anyRecommend) {
    const note = budget.outOfTime
      ? 'Qloo was too slow to answer this time, so I have no picks. Try again in a minute, or with fewer people.'
      : 'Qloo did not answer for anyone this time, so I have no picks. Try again in a minute.';
    return errorResult(base, started, note, calls);
  }

  const shortlist = roundRobin(perMember.map((entry) => entry.list));
  if (shortlist.length === 0) {
    const result: CouncilResult = {
      ...base,
      picks: [],
      vetoes: [],
      speech: councilSpeech(occasion, [], []),
      calls,
      status: recommendFailed.length > 0 || budget.outOfTime ? 'degraded' : 'ok',
      note: [
        budget.outOfTime ? OUT_OF_TIME_NOTE : 'Qloo returned no candidates for these tastes.',
        childNote,
      ].filter(Boolean).join(' '),
      ms: Date.now() - started,
    };
    await remember(result);
    return result;
  }

  // c. One ranking of the shared shortlist per person.
  const options = shortlist.map((candidate) => candidate.entityId ?? candidate.name);
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const candidate of shortlist) {
    if (candidate.entityId) byId.set(candidate.entityId, candidate.key);
    byName.set(candidate.name.toLowerCase(), candidate.key);
  }
  const rankings: MemberRanking[] = await Promise.all(members.map(async (member) => {
    const because = cleanList(member.loves, MAX_SIGNALS);
    const args: Record<string, unknown> = { options, option_type: target, ...sharedSignals(member, location, target) };
    if (!args.signals && !args.signal_location) return { who: member.who, because, order: null, skipped: true };
    const { envelope } = await callWithRepair('qloo_rank', args, member.who, calls, budget);
    if (!usable(envelope.status) || envelope.results.length === 0) return { who: member.who, because, order: null };
    const order: string[] = [];
    for (const raw of envelope.results) {
      const item = asRecord(raw);
      if (!item) continue;
      const id = str(item.entity_id) ?? str(item.id);
      const name = str(item.name)?.toLowerCase();
      const key = (id && byId.get(id)) ?? (name && byName.get(name));
      if (key && !order.includes(key)) order.push(key);
    }
    return { who: member.who, because, order: order.length > 0 ? order : null };
  }));

  // If no ranking came back at all, fall back to each person's recommend order.
  const anyRanking = rankings.some((ranking) => ranking.order);
  const effective = anyRanking
    ? rankings
    : rankings.map((ranking, index) => {
      const list = perMember[index]?.list ?? [];
      return { ...ranking, order: list.length > 0 ? list.map((candidate) => candidate.key) : null };
    });

  // d + e. Maximin, then Keeper.
  const scored = scoreShortlist(shortlist, effective);
  const { kept, vetoes } = keeperCheck(scored, members, target, profile.constraintFacts);
  const picks = kept.slice(0, PICKS_MAX).map(pickFrom);

  const rankFailed = rankings.filter((ranking) => !ranking.order && !ranking.skipped).map((ranking) => ranking.who);
  const failed = recommendFailed.length > 0 || rankFailed.length > 0 || !anyRanking;
  const notes: string[] = [];
  if (budget.outOfTime) notes.push(OUT_OF_TIME_NOTE);
  if (!anyRanking) {
    notes.push('Qloo did not rank the shortlist, so picks follow each person\'s suggestions, not their ranks.');
  } else if (rankFailed.length > 0) {
    notes.push(`Qloo did not rank the shortlist for ${listNames(rankFailed)}, so the picks use only the other ranks.`);
  }
  if (recommendFailed.length > 0) notes.push(`Qloo suggested nothing for ${listNames(recommendFailed)}, so the shortlist comes from the others.`);
  const skipped = rankings.filter((ranking) => ranking.skipped).map((ranking) => ranking.who);
  if (skipped.length > 0) notes.push(`${listNames(skipped)} named no favourite title or artist, so Qloo could not rank for them.`);
  if (childNote) notes.push(childNote);
  if (missing.length > 0) notes.push(`No taste facts for ${listNames(missing)}.`);
  if (target === 'place' && !location) notes.push('No location was given, so places may be far away.');

  const result: CouncilResult = {
    ...base,
    picks,
    vetoes,
    speech: councilSpeech(occasion, picks, vetoes, { ranked: anyRanking }),
    calls,
    status: failed ? 'degraded' : 'ok',
    startedAt,
    ms: Date.now() - started,
  };
  if (notes.length > 0) result.note = notes.join(' ');
  await remember(result);
  return result;
}

export async function tasteSnapshot(): Promise<TasteSnapshot> {
  const [profile, readiness, recentResults] = await Promise.all([
    buildTasteProfile(),
    qlooReadiness(),
    listRecentCouncils(),
  ]);
  return { members: profile.members, qlooReady: readiness === 'ready', recent: recentResults };
}
