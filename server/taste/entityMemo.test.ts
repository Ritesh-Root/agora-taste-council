import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDataDir } from '../household/store';
import {
  chooseEntity,
  entityMemoSaved,
  entityMemoSnapshot,
  learnFromEnvelope,
  loadEntityMemo,
  resetEntityMemo,
  withKnownIds,
} from './entityMemo';

const MOVIE = '649672ad-38a4-42c7-baac-bbd2d5beefa0';
const ALBUM = 'dfb3cf24-3bc9-402a-a3c5-051d76874910';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agora-memo-'));
  setDataDir(dir);
  resetEntityMemo();
});

afterEach(async () => {
  await entityMemoSaved();
  resetEntityMemo();
  await rm(dir, { recursive: true, force: true });
});

describe('chooseEntity', () => {
  // Shapes and order as the harness returned them live for the demo family.
  it('prefers the work or artist over an album, a town or a restaurant of the same name', () => {
    expect(chooseEntity('Coco', [
      { id: 'album', name: 'Coco', type: 'urn:entity:album' },
      { id: 'movie', name: 'Coco', type: 'urn:entity:movie', description: 'Coco (2017), directed by Lee Unkrich' },
      { id: 'place', name: 'CoCo', type: 'urn:entity:place', description: 'Parisian dining spot' },
    ])?.id).toBe('movie');
    expect(chooseEntity('Encanto', [
      { id: 'town', name: 'Encanto', type: 'urn:entity:locality' },
      { id: 'movie', name: 'Encanto', type: 'urn:entity:movie', description: 'Encanto (2021)' },
    ])?.id).toBe('movie');
    expect(chooseEntity('Taylor Swift', [
      { id: 'person', name: 'Taylor Swift', type: 'urn:entity:person', description: 'American singer-songwriter' },
      { id: 'artist', name: 'Taylor Swift', type: 'urn:entity:artist', description: 'An American singer-songwriter' },
      { id: 'author', name: 'Taylor Swift', type: 'urn:entity:author', description: 'singer' },
    ])?.id).toBe('artist');
  });

  it('keeps a described person over a bare film named after them, and Qloo order on a tie', () => {
    expect(chooseEntity('Raj Kapoor', [
      { id: 'actor', name: 'Raj Kapoor', type: 'urn:entity:person', description: 'Indian film actor, producer and director' },
      { id: 'director', name: 'Raj Kapoor', type: 'urn:entity:person', description: 'Indian film director and actor' },
      { id: 'restaurant', name: 'Raj Kapoor', type: 'urn:entity:place', description: 'Neighborhood restaurant' },
      { id: 'film', name: 'Raj Kapoor', type: 'urn:entity:movie' },
    ])?.id).toBe('actor');
  });

  it('never picks a town, and has nothing when only towns match', () => {
    expect(chooseEntity('Encanto', [{ id: 'town', name: 'Encanto', type: 'urn:entity:locality' }])).toBeNull();
    expect(chooseEntity('X', [])).toBeNull();
  });
});

describe('entity memo', () => {
  it('remembers a needs_input choice and swaps it in, keeping ids and unknown names as they are', async () => {
    await loadEntityMemo();
    learnFromEnvelope({ target_type: 'movie', signals: ['Coco', 'Nowhere Film'] }, {
      status: 'needs_input',
      summary: 'Choose or correct the unresolved Qloo inputs.',
      results: [],
      result_count: 0,
      issues: [
        { input: 'Coco', field: 'signals', kind: 'ambiguous', candidates: [
          { id: ALBUM, name: 'Coco', type: 'urn:entity:album' },
          { id: MOVIE, name: 'Coco', type: 'urn:entity:movie', description: 'Coco (2017)' },
        ] },
        { input: 'Nowhere Film', field: 'signals', kind: 'not_found', candidates: [] },
        { input: 'thrillers', field: 'signal_tags', kind: 'ambiguous', candidates: [{ id: 'urn:tag:genre:media:thriller', name: 'Thriller' }] },
      ],
    });
    expect(withKnownIds({ target_type: 'movie', signals: ['coco', 'Nowhere Film', 'Up', MOVIE], signal_tags: ['Thrillers'], signal_tags_operator: 'union' }))
      .toEqual({ target_type: 'movie', signals: [MOVIE, 'Up'], signal_tags: ['urn:tag:genre:media:thriller'], signal_tags_operator: 'union' });
    // Tags are scoped to the target type, as the harness resolves them.
    expect(withKnownIds({ target_type: 'book', signal_tags: ['thrillers'] })).toEqual({ target_type: 'book', signal_tags: ['thrillers'] });
    // Every name dropped: the field goes.
    expect(withKnownIds({ option_type: 'movie', options: [MOVIE], signals: ['Nowhere Film'] })).toEqual({ option_type: 'movie', options: [MOVIE] });
  });

  it('learns from what an ok result resolved', async () => {
    await loadEntityMemo();
    learnFromEnvelope({ target_type: 'artist', signals: ['Arijit Singh'] }, {
      status: 'ok',
      summary: '',
      results: [],
      result_count: 0,
      resolved: [{ field: 'signals', input: 'Arijit Singh', id: 'artist-id', type: 'urn:entity:artist' }, { field: 'options', input: 'x', id: 'y' }],
    });
    expect(entityMemoSnapshot()).toEqual({ 'entity|arijit singh': { id: 'artist-id', type: 'urn:entity:artist' } });
  });

  it('starts from the demo family\'s ids only with AGORA_DEMO_SEED=1', async () => {
    const saved = process.env.AGORA_DEMO_SEED;
    try {
      delete process.env.AGORA_DEMO_SEED;
      await loadEntityMemo();
      expect(withKnownIds({ target_type: 'movie', signals: ['Coco'] })).toEqual({ target_type: 'movie', signals: ['Coco'] });
      resetEntityMemo();
      process.env.AGORA_DEMO_SEED = '1';
      await loadEntityMemo();
      expect(withKnownIds({ target_type: 'place', signals: ['Coco', 'Taylor Swift'], signal_tags: ['street food'] })).toEqual({
        target_type: 'place',
        signals: [MOVIE.toUpperCase(), '4BBEF799-A0C4-4110-AB01-39216993C312'],
        signal_tags: ['urn:tag:cuisine:qloo:street_food'],
      });
      // A tag Qloo has nothing for (street food, for films) is left out rather than resolved again.
      expect(withKnownIds({ target_type: 'movie', signal_tags: ['street food'], signal_tags_operator: 'union' })).toEqual({ target_type: 'movie' });
    } finally {
      if (saved === undefined) delete process.env.AGORA_DEMO_SEED;
      else process.env.AGORA_DEMO_SEED = saved;
    }
  });

  it('saves to taste-entities.json and reads it back after a restart', async () => {
    await loadEntityMemo();
    learnFromEnvelope({ target_type: 'movie', signals: ['Mughal-e-Azam'] }, {
      status: 'needs_input',
      summary: '',
      results: [],
      result_count: 0,
      issues: [{ input: 'Mughal-e-Azam', field: 'signals', candidates: [{ id: 'mughal', name: 'Mughal-E-Azam', type: 'urn:entity:movie', description: '1960 film' }] }],
    });
    await entityMemoSaved();
    const saved = JSON.parse(await readFile(path.join(dir, 'taste-entities.json'), 'utf8'));
    expect(saved['entity|mughal e azam']).toMatchObject({ id: 'mughal' });
    resetEntityMemo();
    await loadEntityMemo();
    expect(withKnownIds({ signals: ['Mughal-e-Azam'] })).toEqual({ signals: ['mughal'] });
  });
});
