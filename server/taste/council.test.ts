import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '../household/memoryStore';
import { loadJsonFile, setDataDir } from '../household/store';
import {
  candidateFrom,
  conflictWords,
  councilSpeech,
  keeperCheck,
  listRecentCouncils,
  resetRecentCouncils,
  roundRobin,
  runCouncil,
  scoreShortlist,
  selectMembers,
} from './council';
import { entityMemoSaved, resetEntityMemo } from './entityMemo';
import { entity, fakeQloo } from './fakeQloo';
import { profileFromEntries } from './profile';
import { setQlooCaller } from './qlooClient';

// Pass-through, so one test can slow the recent-results load down.
vi.mock('../household/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../household/store')>();
  return { ...actual, loadJsonFile: vi.fn(actual.loadJsonFile) };
});

let dir = '';
let counter = 0;

function facts(...texts: string[]): MemoryEntry[] {
  return texts.map((text) => {
    counter += 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString();
    return { id: `f${counter}`, text, tags: [], createdAt: at, updatedAt: at, source: 'ui' as const };
  });
}

const FAMILY = profileFromEntries(facts(
  'Mia loves Encanto',
  'Mia is 9',
  'Dadi loves Raj Kapoor films',
  'Dadi is 74',
  'Arjun loves Interstellar',
  'Arjun hates horror',
));

const COCO = entity('a', 'Coco', { release_year: 2017, image: { url: 'https://img.example/coco.jpg' } });
const AWAARA = entity('d', 'Awaara', { release_year: 1951 });
const INCEPTION = entity('f', 'Inception');
const FROZEN = entity('b', 'Frozen');
const UP = entity('c', 'Up');
const SHREE = entity('e', 'Shree 420');
const HORROR = entity('g', 'Horror House');

const RECOMMEND: Record<string, unknown[]> = {
  Encanto: [COCO, FROZEN, UP],
  'Raj Kapoor': [AWAARA, COCO, SHREE],
  Interstellar: [INCEPTION, COCO, HORROR],
};

const BY_ID: Record<string, Record<string, unknown>> = Object.fromEntries(
  [COCO, AWAARA, INCEPTION, FROZEN, UP, SHREE, HORROR].map((item) => [item.entity_id as string, item]),
);

const RANK: Record<string, string[]> = {
  Encanto: ['a', 'b', 'c', 'd', 'f', 'e', 'g'],
  'Raj Kapoor': ['d', 'a', 'e', 'f', 'b', 'c', 'g'],
  Interstellar: ['f', 'a', 'd', 'b', 'c', 'e', 'g'],
};

function firstSignal(args: Record<string, unknown>): string {
  return Array.isArray(args.signals) ? String(args.signals[0]) : '';
}

function family(overrides: { rank?: (signal: string) => Record<string, unknown> | null } = {}) {
  return fakeQloo((tool, args) => {
    const signal = firstSignal(args);
    if (tool === 'qloo_recommend') return { results: RECOMMEND[signal] ?? [] };
    if (tool === 'qloo_rank') {
      const custom = overrides.rank?.(signal);
      if (custom) return custom;
      const options = args.options as string[];
      const order = (RANK[signal] ?? []).filter((id) => options.includes(id));
      return { results: order.map((id) => BY_ID[id]) };
    }
    return { status: 'error', summary: 'unexpected tool' };
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agora-taste-'));
  setDataDir(dir);
  resetRecentCouncils();
  resetEntityMemo();
  delete process.env.AGORA_TASTE_LOCATION;
  // The demo seed would swap the test family's names for real Qloo ids.
  delete process.env.AGORA_DEMO_SEED;
});

afterEach(async () => {
  setQlooCaller(null);
  resetRecentCouncils();
  await entityMemoSaved();
  resetEntityMemo();
  await rm(dir, { recursive: true, force: true });
});

describe('runCouncil', () => {
  it('picks by maximin, cites ranks, and vetoes a "no horror" conflict', async () => {
    const fake = family();
    setQlooCaller(fake);
    const result = await runCouncil({ occasion: 'movie_night' }, { profile: FAMILY });

    expect(result.status).toBe('ok');
    expect(result.members.map((member) => member.who)).toEqual(['Arjun', 'Dadi', 'Mia']);
    expect(result.picks[0].name).toBe('Coco');
    expect(result.picks[0]).toMatchObject({ entityId: 'a', worstRank: 2, subtitle: '2017', imageUrl: 'https://img.example/coco.jpg' });
    expect(result.picks[0].fits).toEqual([
      { who: 'Arjun', rank: 2, of: 7, because: ['Interstellar'] },
      { who: 'Dadi', rank: 2, of: 7, because: ['Raj Kapoor'] },
      { who: 'Mia', rank: 1, of: 7, because: ['Encanto'] },
    ]);
    expect(result.picks.length).toBeLessThanOrEqual(5);
    for (let index = 1; index < result.picks.length; index += 1) {
      const prev = result.picks[index - 1];
      const next = result.picks[index];
      expect(prev.worstRank < next.worstRank || (prev.worstRank === next.worstRank && prev.meanRank <= next.meanRank)).toBe(true);
    }
    expect(result.vetoes).toEqual([{ name: 'Horror House', fact: 'Arjun hates horror', who: 'Arjun' }]);
    expect(result.picks.some((pick) => pick.name === 'Horror House')).toBe(false);
    expect(result.speech).toBe('For movie night, Coco works for everyone: it ranks in the top 2 for Arjun, Dadi and Mia. Keeper set aside Horror House because Arjun hates horror.');
    expect(result.calls.filter((call) => call.tool === 'qloo_recommend')).toHaveLength(3);
    expect(result.calls.filter((call) => call.tool === 'qloo_rank')).toHaveLength(3);
    expect(result.calls.every((call) => call.forWho)).toBe(true);
    expect(fake.maxConcurrent).toBe(1);

    const recommend = fake.calls.find((call) => call.tool === 'qloo_recommend' && firstSignal(call.args) === 'Interstellar');
    // Mia is 9, so films ask for 12 and the adult ones are left out.
    expect(recommend?.args).toMatchObject({ target_type: 'movie', limit: 12, exclude_tags: ['horror'] });
    expect(recommend?.args).not.toHaveProperty('demographic');
    const rank = fake.calls.find((call) => call.tool === 'qloo_rank');
    expect(rank?.args).toMatchObject({ option_type: 'movie', options: ['f', 'd', 'a', 'b', 'g', 'e', 'c'] });
  });

  it('sends a demographic with a location, and filters places to it', async () => {
    const fake = family();
    setQlooCaller(fake);
    await runCouncil({ occasion: 'dinner_out', location: 'Bengaluru' }, { profile: FAMILY });
    const dadi = fake.calls.find((call) => call.tool === 'qloo_recommend' && firstSignal(call.args) === 'Raj Kapoor');
    expect(dadi?.args).toMatchObject({ target_type: 'place', demographic: 'seniors', signal_location: 'Bengaluru', filter_location: 'Bengaluru' });
    const mia = fake.calls.find((call) => call.tool === 'qloo_recommend' && firstSignal(call.args) === 'Encanto');
    expect(mia?.args).toMatchObject({ demographic: 'teens' });
  });

  it('only asks the people named, case-insensitively', async () => {
    setQlooCaller(family());
    const result = await runCouncil({ occasion: 'movie_night', who: ['mia', 'DADI'] }, { profile: FAMILY });
    expect(result.members.map((member) => member.who)).toEqual(['Dadi', 'Mia']);
    expect(result.picks[0].fits.map((fit) => fit.who)).toEqual(['Dadi', 'Mia']);
  });

  it('is degraded when one ranking fails, and leaves that person out of the score', async () => {
    setQlooCaller(family({ rank: (signal) => (signal === 'Raj Kapoor' ? { status: 'error', summary: 'boom' } : null) }));
    const result = await runCouncil({ occasion: 'movie_night' }, { profile: FAMILY });
    expect(result.status).toBe('degraded');
    expect(result.note).toBe('Qloo did not rank the shortlist for Dadi, so the picks use only the other ranks.');
    expect(result.speech).toMatch(/^For movie night, Coco ranks in the top 2 for Arjun and Mia\. Qloo has no rank from Dadi for it\./);
    const coco = result.picks.find((pick) => pick.name === 'Coco');
    expect(coco?.fits.find((fit) => fit.who === 'Dadi')?.rank).toBeNull();
    expect(coco?.worstRank).toBe(2);
  });

  it('is an error with no picks when Qloo is not configured', async () => {
    const fake = family();
    const unconfigured = { ...fake, readiness: async () => 'unconfigured' as const };
    setQlooCaller(unconfigured);
    const result = await runCouncil({ occasion: 'movie_night' }, { profile: FAMILY });
    expect(result.status).toBe('error');
    expect(result.picks).toEqual([]);
    expect(result.note).toMatch(/qloo setup|QLOO_API_KEY/);
    expect(result.speech).toBe(result.note);
    expect(fake.calls).toHaveLength(0);
  });

  it('is an error when Qloo is unreachable or every call fails', async () => {
    setQlooCaller(fakeQloo(() => ({}), 'unreachable'));
    expect((await runCouncil({ occasion: 'playlist' }, { profile: FAMILY })).note).toMatch(/could not reach Qloo/);

    setQlooCaller(fakeQloo(() => {
      throw new Error('child died');
    }));
    const result = await runCouncil({ occasion: 'playlist' }, { profile: FAMILY });
    expect(result.status).toBe('error');
    expect(result.picks).toEqual([]);
    expect(result.calls.length).toBeGreaterThan(0);
    expect(result.calls.every((call) => call.status === 'error')).toBe(true);
  });

  it('says so when nobody has taste facts', async () => {
    setQlooCaller(family());
    const result = await runCouncil({ occasion: 'movie_night' }, { profile: profileFromEntries(facts('Dadi is 74')) });
    expect(result.status).toBe('error');
    expect(result.speech).toMatch(/Mia loves Encanto/);
    const named = await runCouncil({ occasion: 'movie_night', who: ['Zed'] }, { profile: FAMILY });
    expect(named.note).toMatch(/Zed/);
  });

  it('retries a needs_input call with Qloo\'s first candidate', async () => {
    const fake = fakeQloo((tool, args) => {
      const signal = firstSignal(args);
      if (signal === 'Encanto') {
        return { status: 'needs_input', summary: 'Choose', results: [], resolution: { issues: [{ input: 'Encanto', field: 'signals', kind: 'ambiguous', candidates: [{ id: 'uuid-enc', name: 'Encanto (2021)' }] }] } };
      }
      if (tool === 'qloo_recommend') return { results: [COCO, FROZEN] };
      return { results: [COCO, FROZEN] };
    });
    setQlooCaller(fake);
    const profile = profileFromEntries(facts('Mia loves Encanto'));
    const result = await runCouncil({ occasion: 'movie_night' }, { profile });
    const statuses = result.calls.map((call) => `${call.tool}:${call.status}`);
    expect(statuses).toContain('qloo_recommend:needs_input');
    expect(fake.calls.some((call) => firstSignal(call.args) === 'uuid-enc')).toBe(true);
    expect(result.picks[0].name).toBe('Coco');
    expect(result.status).toBe('ok');
  });

  it('resolves a name once: the rank and the next council send the remembered id, with no needs_input', async () => {
    const MOVIE = '649672ad-38a4-42c7-baac-bbd2d5beefa0';
    const fake = fakeQloo((tool, args) => {
      if ((args.signals as string[] | undefined)?.includes('Coco')) {
        return { status: 'needs_input', summary: 'Choose or correct the unresolved Qloo inputs.', results: [], resolution: { issues: [{ input: 'Coco', field: 'signals', kind: 'ambiguous', candidates: [
          { id: 'dfb3cf24-3bc9-402a-a3c5-051d76874910', name: 'Coco', type: 'urn:entity:album' },
          { id: MOVIE, name: 'Coco', type: 'urn:entity:movie', description: 'Coco (2017)' },
        ] }] } };
      }
      return { results: tool === 'qloo_recommend' ? [UP, FROZEN] : [FROZEN, UP] };
    });
    setQlooCaller(fake);
    const profile = profileFromEntries(facts('Mia loves Coco'));
    const first = await runCouncil({ occasion: 'movie_night' }, { profile });
    expect(first.calls.map((call) => `${call.tool}:${call.status}`)).toEqual(['qloo_recommend:needs_input', 'qloo_recommend:ok', 'qloo_rank:ok']);
    // The film, not the album Qloo listed first.
    expect(fake.calls[1].args.signals).toEqual([MOVIE]);
    expect(fake.calls[2].args.signals).toEqual([MOVIE]);

    const again = await runCouncil({ occasion: 'tv_show' }, { profile });
    expect(again.calls.map((call) => `${call.tool}:${call.status}`)).toEqual(['qloo_recommend:ok', 'qloo_rank:ok']);
    expect(again.status).toBe('ok');

    // After a restart the saved memo still knows Coco.
    await entityMemoSaved();
    resetEntityMemo();
    const restarted = await runCouncil({ occasion: 'playlist' }, { profile });
    expect(restarted.calls.every((call) => call.status === 'ok')).toBe(true);
  });

  it('asks for restaurants near the neighbourhood for dinner, and attractions (not restaurants) for an outing', async () => {
    const fake = family();
    setQlooCaller(fake);
    await runCouncil({ occasion: 'dinner_out', location: 'Bandra, Mumbai' }, { profile: FAMILY });
    const dinner = fake.calls.find((call) => call.tool === 'qloo_recommend');
    expect(dinner?.args).toMatchObject({
      target_type: 'place',
      limit: 8,
      filter_location: 'Bandra',
      signal_location: 'Mumbai',
      include_tags: ['urn:tag:genre:place:restaurant'],
    });
    expect(fake.calls.find((call) => call.tool === 'qloo_rank')?.args).toMatchObject({ signal_location: 'Mumbai' });

    fake.calls.length = 0;
    await runCouncil({ occasion: 'outing', location: 'Mumbai' }, { profile: FAMILY });
    const outing = fake.calls.find((call) => call.tool === 'qloo_recommend');
    expect(outing?.args).toMatchObject({ filter_location: 'Mumbai', signal_location: 'Mumbai', exclude_tags: ['urn:tag:genre:place:restaurant'], include_tags_operator: 'union' });
    expect(outing?.args.include_tags).toEqual(expect.arrayContaining(['urn:tag:category:place:park', 'urn:tag:category:place:museum', 'urn:tag:category:place:amusement_park']));
    expect((outing?.args.include_tags as string[]).length).toBeLessThanOrEqual(10);
  });

  it('leaves adult-rated and explicit titles out when a child is in the council, and says so', async () => {
    const book = (id: string, name: string, properties: Record<string, unknown> = {}) => ({ ...entity(id, name, properties), type: 'urn:entity:book' });
    const results = [
      book('k1', 'The Subtle Art of Not Giving a F*ck'),
      book('k2', 'Wonder', { content_rating: 'PG' }),
      book('k3', 'Night Shift', { content_rating: 'R' }),
      book('k4', 'Matilda'),
      book('k5', 'Velvet Nights', { description: 'An erotic romance.' }),
    ];
    const fake = fakeQloo((tool, args) => {
      if (tool === 'qloo_recommend') return { results };
      const options = args.options as string[];
      return { results: results.filter((item) => options.includes(item.entity_id as string)) };
    });
    setQlooCaller(fake);
    const result = await runCouncil({ occasion: 'book_club' }, { profile: FAMILY });
    expect(result.picks.map((pick) => pick.name)).toEqual(['Wonder', 'Matilda']);
    expect(result.vetoes).toEqual([]);
    expect(result.note).toMatch(/Left out 3 suggestions rated for adults or with an explicit title, because Mia is under 18\./);
    expect(fake.calls.find((call) => call.tool === 'qloo_rank')?.args.options).toEqual(['k2', 'k4']);
    expect(fake.calls.find((call) => call.tool === 'qloo_recommend')?.args.limit).toBe(12);

    // Adults only: nothing is left out, and the list size is the usual 8.
    fake.calls.length = 0;
    const adults = await runCouncil({ occasion: 'book_club', who: ['Arjun', 'Dadi'] }, { profile: FAMILY });
    expect(adults.picks).toHaveLength(5);
    expect(adults.note).toBeUndefined();
    expect(fake.calls.find((call) => call.tool === 'qloo_recommend')?.args.limit).toBe(8);
  });

  it('leaves a person with only abstract likes out of the ranking without degrading', async () => {
    const fake = fakeQloo((tool) => ({ results: tool === 'qloo_recommend' ? [COCO, FROZEN] : [FROZEN, COCO] }));
    setQlooCaller(fake);
    const profile = profileFromEntries(facts('Mia loves Encanto', 'Rohan likes thrillers'));
    const result = await runCouncil({ occasion: 'movie_night' }, { profile });
    expect(result.status).toBe('ok');
    expect(result.note).toMatch(/Rohan named no favourite/);
    expect(fake.calls.filter((call) => call.tool === 'qloo_rank')).toHaveLength(1);
    const rohanRecommend = fake.calls.find((call) => call.tool === 'qloo_recommend' && !call.args.signals);
    expect(rohanRecommend?.args).toMatchObject({ signal_tags: ['thrillers'], signal_tags_operator: 'union' });
    expect(result.picks[0].name).toBe('Frozen');
    expect(result.speech).toBe("For movie night, Frozen is Mia's top choice. Qloo has no rank from Rohan for it.");
    expect(result.picks[0].fits).toEqual([
      { who: 'Mia', rank: 1, of: 2, because: ['Encanto'] },
      { who: 'Rohan', rank: null, of: 2, because: [] },
    ]);
  });

  it('vetoes a steakhouse for a vegetarian at dinner, quoting the fact', async () => {
    const steak = entity('s', 'Smoky BBQ Steakhouse', { address: '12 MG Road, Bengaluru, India' });
    const dosa = entity('v', 'Dosa Corner', { address: '1 Church St, Bengaluru' });
    setQlooCaller(fakeQloo((tool) => ({ results: tool === 'qloo_recommend' ? [steak, dosa] : [steak, dosa] })));
    const profile = profileFromEntries(facts('Rohan likes street food', 'Rohan is vegetarian', 'Rohan loves Arijit Singh'));
    const result = await runCouncil({ occasion: 'dinner_out', location: 'Bengaluru' }, { profile });
    expect(result.vetoes).toEqual([{ name: 'Smoky BBQ Steakhouse', fact: 'Rohan is vegetarian', who: 'Rohan' }]);
    expect(result.picks.map((pick) => pick.name)).toEqual(['Dosa Corner']);
    expect(result.picks[0].subtitle).toBe('1 Church St, Bengaluru');
    expect(result.speech).toMatch(/Keeper set aside Smoky BBQ Steakhouse because Rohan is vegetarian\./);
  });

  it('sends a vegetarian\'s diet as a Qloo tag in their own dinner calls only, so untagged places rank last for them', async () => {
    const place = (id: string, name: string) => ({ ...entity(id, name), type: 'urn:entity:place' });
    const halal = place('h', 'Hotel Halal Plates');
    const cafe = place('c', 'Green Cafe');
    const dosa = place('d', 'Dosa Corner');
    const VEG = 'urn:tag:offerings:place:vegetarian_options';
    const fake = fakeQloo((tool, args) => {
      if (tool === 'qloo_recommend') return { results: [halal, cafe, dosa] };
      const options = args.options as string[];
      // Qloo keeps only the options that list the include tag.
      const listed = Array.isArray(args.include_tags) ? [cafe, dosa] : [halal, dosa, cafe];
      return { results: listed.filter((item) => options.includes(item.entity_id as string)) };
    });
    setQlooCaller(fake);
    const profile = profileFromEntries(facts('Arjun loves Interstellar', 'Arjun is vegetarian', 'Dadi loves Raj Kapoor films'));
    const result = await runCouncil({ occasion: 'dinner_out', location: 'Bandra, Mumbai' }, { profile });

    const recommend = (who: string) => fake.calls.find((call) => call.tool === 'qloo_recommend' && firstSignal(call.args) === who)?.args;
    const rank = (who: string) => fake.calls.find((call) => call.tool === 'qloo_rank' && firstSignal(call.args) === who)?.args;
    expect(recommend('Interstellar')).toMatchObject({ include_tags: ['urn:tag:genre:place:restaurant', VEG], include_tags_operator: 'intersection' });
    expect(recommend('Raj Kapoor')?.include_tags).toEqual(['urn:tag:genre:place:restaurant']);
    expect(recommend('Raj Kapoor')?.include_tags_operator).toBeUndefined();
    expect(rank('Interstellar')?.include_tags).toEqual([VEG]);
    expect(rank('Raj Kapoor')?.include_tags).toBeUndefined();

    // Dadi ranks the halal place first, but it is missing from Arjun's diet-filtered rank: last for him.
    const halalPick = result.picks.find((pick) => pick.name === 'Hotel Halal Plates');
    expect(halalPick?.fits.find((fit) => fit.who === 'Arjun')?.rank).toBeNull();
    expect(halalPick?.worstRank).toBe(3);
    expect(result.picks[0].name).toBe('Dosa Corner');
    expect(result.vetoes).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.note).toMatch(/Arjun's ranks count only places Qloo lists with vegetarian options/);

    // Films are not filtered by diet.
    fake.calls.length = 0;
    await runCouncil({ occasion: 'movie_night', location: 'Mumbai' }, { profile });
    expect(fake.calls.every((call) => !call.args.include_tags)).toBe(true);
  });

  it('ranks without the diet tag when no option lists it, and says so', async () => {
    const place = (id: string, name: string) => ({ ...entity(id, name), type: 'urn:entity:place' });
    const options = [place('a', 'Bombay Canteen'), place('b', 'Pali Village Cafe')];
    const fake = fakeQloo((tool, args) => {
      if (tool === 'qloo_recommend') return { results: options };
      return Array.isArray(args.include_tags) ? { status: 'empty', results: [] } : { results: options };
    });
    setQlooCaller(fake);
    const profile = profileFromEntries(facts('Arjun loves Interstellar', 'Arjun is a vegan'));
    const result = await runCouncil({ occasion: 'dinner_out', location: 'Mumbai' }, { profile });
    const ranks = fake.calls.filter((call) => call.tool === 'qloo_rank');
    expect(ranks.map((call) => call.args.include_tags)).toEqual([['urn:tag:offerings:place:vegan_options'], undefined]);
    expect(result.picks[0].fits[0].rank).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.note).toMatch(/Qloo lists none of these places with vegan options, so Arjun's ranks ignore diet\./);
  });

  it('keeps the last results across a reload, newest first, errors left out', async () => {
    setQlooCaller(family());
    await runCouncil({ occasion: 'movie_night' }, { profile: FAMILY });
    await runCouncil({ occasion: 'tv_show' }, { profile: FAMILY });
    setQlooCaller(fakeQloo(() => ({}), 'unconfigured'));
    await runCouncil({ occasion: 'book_club' }, { profile: FAMILY });
    resetRecentCouncils();
    const recent = await listRecentCouncils();
    expect(recent.map((item) => item.occasion)).toEqual(['tv_show', 'movie_night']);
  });

  it('keeps both of two councils that finish at the same time', async () => {
    setQlooCaller(family());
    // Both councils reach the recent list while its file is still loading.
    const actual = (await vi.importActual<typeof import('../household/store')>('../household/store')).loadJsonFile;
    vi.mocked(loadJsonFile).mockImplementation(async (...args) => {
      const value = await actual(...args);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return value;
    });
    try {
      await Promise.all([
        runCouncil({ occasion: 'movie_night' }, { profile: FAMILY }),
        runCouncil({ occasion: 'tv_show' }, { profile: FAMILY }),
      ]);
    } finally {
      vi.mocked(loadJsonFile).mockImplementation(actual);
    }
    expect((await listRecentCouncils()).map((item) => item.occasion).sort()).toEqual(['movie_night', 'tv_show']);
    resetRecentCouncils();
    expect((await listRecentCouncils()).map((item) => item.occasion).sort()).toEqual(['movie_night', 'tv_show']);
  });

  it('stops calling Qloo past its deadline and answers with what it has, degraded', async () => {
    const slow = family();
    const handle = slow.callTool.bind(slow);
    slow.callTool = async (tool, args) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return handle(tool, args);
    };
    setQlooCaller(slow);
    // One slot: the first recommend finishes at ~250 ms, past the 150 ms deadline, so the other
    // recommends and every rank are skipped.
    const result = await runCouncil({ occasion: 'movie_night' }, { profile: FAMILY, deadlineMs: 150 });
    expect(result.status).toBe('degraded');
    expect(result.note).toMatch(/ran out of time/);
    expect(result.picks.length).toBeGreaterThan(0);
    expect(slow.calls.filter((call) => call.tool === 'qloo_recommend')).toHaveLength(1);
    expect(slow.calls.filter((call) => call.tool === 'qloo_rank')).toHaveLength(0);
    expect(result.calls).toHaveLength(1);
    // Nobody was ranked, so the speech claims no ranks.
    expect(result.speech).toMatch(/Qloo's suggestions point to/);
  });

  it('is an error that says so when the deadline passes before any answer', async () => {
    const fake = family();
    setQlooCaller(fake);
    const result = await runCouncil({ occasion: 'movie_night' }, { profile: FAMILY, deadlineMs: 0 });
    expect(result.status).toBe('error');
    expect(result.note).toMatch(/too slow/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('maximin helpers', () => {
  const cands = ['x', 'y', 'z'].map((id) => candidateFrom(entity(id, id.toUpperCase()))!);

  it('ranks a missing option last for that person but shows it as null', () => {
    const scored = scoreShortlist(cands, [
      { who: 'A', because: [], order: ['id:x', 'id:y'] },
      { who: 'B', because: [], order: ['id:y', 'id:x', 'id:z'] },
    ]);
    expect(scored.map((item) => item.name)).toEqual(['X', 'Y', 'Z']);
    const z = scored.find((item) => item.name === 'Z')!;
    expect(z.fits[0]).toEqual({ who: 'A', rank: null, of: 3, because: [] });
    expect(z.worstRank).toBe(3);
  });

  it('breaks a worst-rank tie by mean rank, then shortlist order', () => {
    const scored = scoreShortlist(cands, [
      { who: 'A', because: [], order: ['id:x', 'id:z', 'id:y'] },
      { who: 'B', because: [], order: ['id:z', 'id:y', 'id:x'] },
    ]);
    // x: 1,3 -> worst 3 mean 2; y: 3,2 -> worst 3 mean 2.5; z: 2,1 -> worst 2
    expect(scored.map((item) => item.name)).toEqual(['Z', 'X', 'Y']);
  });

  it('round-robins so everyone contributes, deduped', () => {
    const [x, y, z] = cands;
    expect(roundRobin([[x, y], [x, z], [z]], 10).map((item) => item.name)).toEqual(['X', 'Z', 'Y']);
    expect(roundRobin([[x, y, z]], 2)).toHaveLength(2);
  });

  it('tolerates odd Qloo items', () => {
    expect(candidateFrom(null)).toBeNull();
    expect(candidateFrom({ id: 'q' })).toBeNull();
    expect(candidateFrom({ id: 'q', name: 'Q', tags: [{ name: 'Animation' }, 'Family', { id: 'urn:tag:x' }], properties: { image: 'http://insecure' } }))
      .toMatchObject({ entityId: 'q', name: 'Q', tags: ['Animation', 'Family'] });
    expect(candidateFrom({ name: 'Only name' })).toMatchObject({ key: 'name:only name' });
  });

  it('applies diet words to places only, "no X" everywhere', () => {
    expect(conflictWords('vegetarian', 'movie')).toEqual([]);
    expect(conflictWords('vegetarian', 'place')).toContain('steakhouse');
    expect(conflictWords('peanuts', 'place')).toContain('satay');
    expect(conflictWords('no horror', 'movie')).toEqual(['horror']);
  });

  it('vetoes clearly meat-centric places for a vegetarian, not mixed restaurants', () => {
    const place = (id: string, name: string, description?: string) => candidateFrom(entity(id, name, description ? { description } : {}))!;
    const shortlist = scoreShortlist([
      place('1', 'Bade Miya', 'Late-night stall known for seekh kebabs and rolls.'),
      place('2', 'Chicken Story'),
      place('3', 'Gajalee', 'Coastal seafood restaurant serving Malvani curries.'),
      place('4', 'Punjab Grill House'),
      place('5', 'Copper Chimney', 'North Indian restaurant serving butter chicken, dal makhani and paneer tikka.'),
      place('6', 'Khow Chow', 'Upscale Pan-Asian spot offering small plates and Halal-friendly vegetarian options.'),
      place('7', 'Hotel Shahnaz', 'Casual Indian eatery known for halal dishes and small plates.'),
      place('8', 'Goldfish Bistro'),
    ], []);
    const profile = profileFromEntries(facts('Arjun is vegetarian'));
    const { kept, vetoes } = keeperCheck(shortlist, profile.members, 'place', profile.constraintFacts);
    expect(vetoes.map((veto) => veto.name)).toEqual(['Bade Miya', 'Chicken Story', 'Gajalee', 'Punjab Grill House']);
    expect(vetoes.every((veto) => veto.fact === 'Arjun is vegetarian')).toBe(true);
    expect(kept.map((item) => item.name)).toEqual(['Copper Chimney', 'Khow Chow', 'Hotel Shahnaz', 'Goldfish Bistro']);
    // Name-only words never apply to films.
    expect(keeperCheck(scoreShortlist([place('9', 'Chicken Run')], []), profile.members, 'movie', profile.constraintFacts).vetoes).toEqual([]);
  });

  it('does not turn a diet with no place words into a word to veto', () => {
    for (const diet of ['kosher', 'coeliac', 'diabetic', 'lactose intolerant']) expect(conflictWords(diet, 'place')).toEqual([]);
    const deli = scoreShortlist([candidateFrom(entity('k', 'Kosher Deli'))!], []);
    const profile = profileFromEntries(facts('Leah keeps kosher'));
    expect(profile.members[0].constraints).toEqual(['kosher']);
    const { kept, vetoes } = keeperCheck(deli, profile.members, 'place', profile.constraintFacts);
    expect(vetoes).toEqual([]);
    expect(kept.map((item) => item.name)).toEqual(['Kosher Deli']);
  });

  it('makes "no X" singular without cutting the word', () => {
    expect(conflictWords('no zombies', 'movie')).toEqual(['zombie']);
    expect(conflictWords('no horses', 'movie')).toEqual(['horse']);
    expect(conflictWords('no musicals', 'movie')).toEqual(['musical']);
    expect(conflictWords('no peaches', 'place')).toEqual(['peach']);
    expect(conflictWords('no boxes', 'movie')).toEqual(['box']);
    expect(conflictWords('no glasses', 'movie')).toEqual(['glass']);
    const films = scoreShortlist(['Zombieland', 'The Zombie Diaries', 'Up'].map((name, index) => candidateFrom(entity(String(index), name))!), []);
    const member = profileFromEntries(facts('Arjun hates zombies')).members;
    expect(keeperCheck(films, member, 'movie', new Map()).vetoes.map((veto) => veto.name)).toEqual(['The Zombie Diaries']);
  });

  it('maps nut allergies to nuts, but not coconut, nutmeg or butternut', () => {
    expect(conflictWords('tree nuts', 'place')).toContain('cashew');
    expect(conflictWords('nuts', 'place')).toContain('almond');
    expect(conflictWords('peanuts', 'place')).toContain('satay');
    expect(conflictWords('coconut', 'place')).toEqual(['coconut']);
    expect(conflictWords('nutmeg', 'place')).toEqual(['nutmeg']);
    expect(conflictWords('butternut squash', 'place')).toEqual(['butternut squash']);
  });

  it('selects members with a taste when nobody is named', () => {
    const profile = profileFromEntries(facts('Mia loves Coco', 'Dadi is 74'));
    expect(selectMembers(profile.members, undefined).members.map((member) => member.who)).toEqual(['Mia']);
    expect(selectMembers(profile.members, ['dadi']).members.map((member) => member.who)).toEqual(['Dadi']);
  });

  it('speaks the fairest pick when nobody is in the top 3', () => {
    const fit = (who: string, rank: number) => ({ who, rank, of: 10, because: [] });
    const pick = { name: 'Up', worstRank: 6, meanRank: 4, tags: [], fits: [fit('A', 2), fit('B', 6)] };
    expect(councilSpeech('book_club', [pick], [])).toBe('For book club, Up is the fairest pick: nobody ranks it lower than 6th of 10.');
    expect(councilSpeech('outing', [], [{ name: 'X', fact: 'Mia is allergic to peanuts', who: 'Mia' }])).toMatch(/Keeper set aside every option/);
  });

  it('never says someone ranked a pick they did not, and claims no ranks without rankings', () => {
    const fit = (who: string, rank: number | null) => ({ who, rank, of: 10, because: [] });
    const pick = { name: 'Up', worstRank: 10, meanRank: 4, tags: [], fits: [fit('Arjun', 2), fit('Mia', 1), fit('Dadi', null)] };
    const speech = councilSpeech('movie_night', [pick], []);
    expect(speech).toBe('For movie night, Up ranks in the top 2 for Arjun and Mia. Qloo has no rank from Dadi for it.');
    expect(speech).not.toMatch(/everyone|Dadi (?:and|rank)/);
    expect(councilSpeech('movie_night', [pick], [], { ranked: false })).toBe("For movie night, Qloo's suggestions point to Up.");
    const late = { ...pick, fits: [fit('Arjun', 6), fit('Dadi', null)] };
    expect(councilSpeech('tv_show', [late], [])).toBe('For a show together, Up ranks 6th for Arjun. Qloo has no rank from Dadi for it.');
    const malala = { ...pick, name: 'I Am Malala: The Story of the Girl Who Stood Up for Education', fits: [fit('Mia', 1)] };
    expect(councilSpeech('book_club', [malala], [])).toBe("For book club, I Am Malala is Mia's top choice.");
  });
});
