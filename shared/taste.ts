/**
 * The Taste Council contract, shared by the server (server/taste/*) and the Home page (src/home/Taste*).
 *
 * A household fact such as "Mia loves Encanto" or "Dadi is 74" becomes a taste signal. The council asks
 * Qloo (through the local `qloo mcp` server) for candidates per person, ranks the shared shortlist once
 * per person, and picks by maximin: the option whose worst per-person rank is best, so nobody is left out.
 * Keeper then removes anything that conflicts with an allergy or diet fact. Nothing here is a probability
 * about a person; Qloo results are aggregate affinities.
 */

/** What the family is choosing. Each maps to one Qloo Insights entity type. */
export type TasteOccasion = 'movie_night' | 'dinner_out' | 'playlist' | 'tv_show' | 'book_club' | 'outing';

export const OCCASION_TARGET: Record<TasteOccasion, 'movie' | 'place' | 'artist' | 'tv_show' | 'book'> = {
  movie_night: 'movie',
  dinner_out: 'place',
  playlist: 'artist',
  tv_show: 'tv_show',
  book_club: 'book',
  outing: 'place',
};

export const OCCASION_LABEL: Record<TasteOccasion, string> = {
  movie_night: 'Family movie night',
  dinner_out: 'Dinner out',
  playlist: 'Road-trip playlist',
  tv_show: 'A show to watch together',
  book_club: 'Family book club',
  outing: 'Weekend outing',
};

/** One person's taste, built from household memory. Never holds a surname, email, or id; just the first name used in memory. */
export interface TasteMember {
  who: string;
  /** Named things the person loves, as written in memory ("Encanto", "A. R. Rahman"). */
  loves: string[];
  /** Abstract likes that are concepts, not entities ("thrillers", "street food"). Sent as tags. */
  likesTags: string[];
  /** Coarse age band from a fact like "Dadi is 74". Sent to Qloo only as a demographic phrase. */
  ageBand?: '0-17' | '18-24' | '25-34' | '35-44' | '45-54' | '55+';
  /** Allergy, diet, or "avoid" facts Keeper checks picks against ("vegetarian", "peanuts", "no horror"). */
  constraints: string[];
  /** Ids of the memory facts this member was built from, for receipts. */
  factIds: string[];
}

/** One Qloo MCP call, kept for the "Under the hood" provenance view. Never contains the API key. */
export interface QlooCallRecord {
  tool: string;
  /** Arguments sent to the Qloo MCP tool. */
  args: Record<string, unknown>;
  status: 'ok' | 'empty' | 'needs_input' | 'partial' | 'degraded' | 'error';
  summary: string;
  resultCount: number;
  ms: number;
  /** The member this call was made for, when it was per person. */
  forWho?: string;
  /** How many times a rate-limited (429) or retryable answer was retried before this one. */
  retries?: number;
}

/** Where one option landed for one person. Rank is 1-based within that person's qloo_rank call. */
export interface MemberFit {
  who: string;
  /** null when Qloo did not rank the option for this person. */
  rank: number | null;
  /** Shortlist size for that call, so the UI can draw rank / of. */
  of: number;
  /** The person's loved things that were the signals for this rank. */
  because: string[];
}

export interface CouncilPick {
  /** Qloo entity id when Qloo returned one. */
  entityId?: string;
  name: string;
  /** Short Qloo metadata line: year, genre, neighbourhood, cuisine. Only what Qloo returned. */
  subtitle?: string;
  imageUrl?: string;
  /** Worst rank across members (lower is better). The maximin key. */
  worstRank: number;
  /** Mean rank across members, the tiebreaker. */
  meanRank: number;
  fits: MemberFit[];
  /** Qloo tags on the entity that explain the pick ("Animation", "Family", "Bollywood"). */
  tags: string[];
}

export interface KeeperVeto {
  name: string;
  /** The household fact that caused the veto, quoted. */
  fact: string;
  who: string;
}

export interface CouncilResult {
  occasion: TasteOccasion;
  /** Location used for places, if any ("Bengaluru"). */
  location?: string;
  members: TasteMember[];
  /** Best first. At most 5. */
  picks: CouncilPick[];
  vetoes: KeeperVeto[];
  /** One or two sentences an assistant can speak. */
  speech: string;
  calls: QlooCallRecord[];
  /** 'ok' when Qloo answered; 'degraded' when some calls failed; 'error' when Qloo was unreachable. */
  status: 'ok' | 'degraded' | 'error';
  /** Present when status is not ok. Human-readable, never contains a credential. */
  note?: string;
  startedAt: string;
  ms: number;
}

/** POST /api/taste/council body, and the `taste_council` MCP tool input. */
export interface CouncilRequest {
  occasion: TasteOccasion;
  /** First names from memory. Empty or missing means everyone with at least one taste fact. */
  who?: string[];
  location?: string;
}

/** GET /api/taste response. */
export interface TasteSnapshot {
  members: TasteMember[];
  /** Whether `qloo mcp` started and reports a usable credential. */
  qlooReady: boolean;
  /** The last few council results, newest first, so the Home page can show them after a reload. */
  recent: CouncilResult[];
}
