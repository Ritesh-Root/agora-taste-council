# The Taste Council and Qloo

How AGORA+ uses Qloo to pick something a whole family will share. This is the technical companion to the [README](../README.md). Every behaviour below is in the code linked next to it.

| File | What it holds |
| --- | --- |
| [shared/taste.ts](../shared/taste.ts) | The contract: occasions, members, picks, call records, results. |
| [server/taste/profile.ts](../server/taste/profile.ts) | Household facts to per-person taste. No model. |
| [server/taste/qlooClient.ts](../server/taste/qlooClient.ts) | The `qloo mcp` child process, cache, one-call-at-a-time limit, 429 retries, result normalisation. |
| [server/taste/entityMemo.ts](../server/taste/entityMemo.ts) | What each favourite and tag resolved to in Qloo, remembered in `taste-entities.json`. |
| [server/taste/council.ts](../server/taste/council.ts) | Candidates, place and diet tags, kid-safety filter, shortlist, ranks, maximin, Keeper, speech. |
| [server/taste/demoSeed.ts](../server/taste/demoSeed.ts) | The fictional demo family. |
| [server/mcp/server.ts](../server/mcp/server.ts) | The `taste_council` and `taste_profile` MCP tools. |
| [server/routes.ts](../server/routes.ts) | `GET /api/taste` and `POST /api/taste/council`. |
| [src/home/TasteCard.tsx](../src/home/TasteCard.tsx), [src/home/TasteSheet.tsx](../src/home/TasteSheet.tsx) | The Home card and the result sheet. |
| [server/llm/vertexProvider.ts](../server/llm/vertexProvider.ts) | Gemini on Vertex AI as the server model. |

## Entry points

- **Home page.** The Taste Council card posts `{ occasion, who?, location? }` to `POST /api/taste/council` and shows the result. `GET /api/taste` returns the members, whether Qloo is ready, and the last few results.
- **MCP.** `taste_council` takes the same three inputs. `taste_profile` lists what the household knows about each person's taste and does not call Qloo. The server's instructions tell any connected agent to call `taste_council` for "what should the family watch, eat, listen to, read, or do together". The tool reference is [skills/agora-household/references/TOOLS.md](../skills/agora-household/references/TOOLS.md).
- **Voice assistant.** The assistant on Home lists tools from the real `/mcp` endpoint, so the server model (Gemini on Vertex AI with `AGORA_SERVER_LLM=vertex`) can call `taste_council` like any other client.

Occasions map to one Qloo entity type each:

| Occasion | Qloo type | Location |
| --- | --- | --- |
| `movie_night` | `movie` | optional |
| `tv_show` | `tv_show` | optional |
| `playlist` | `artist` | optional |
| `book_club` | `book` | optional |
| `dinner_out` | `place` | needed for nearby results |
| `outing` | `place` | needed for nearby results |

## The algorithm

### 1. Facts become a taste profile

[profile.ts](../server/taste/profile.ts) reads every memory fact with plain English patterns. No model is involved. For each person:

- **Loves**: named things after "loves", "likes", "is a fan of", "'s favourite film is", and similar. A capitalised, quoted, or numbered item counts as named. A trailing "films", "songs", "books" is dropped, so "Raj Kapoor films" becomes `Raj Kapoor`.
- **Likes as tags**: lowercase concepts after the same verbs, such as `thrillers` or `street food`.
- **Age band**: from "is 74", "is 9 years old", "turned 16". Stored only as a band: `0-17`, `18-24`, `25-34`, `35-44`, `45-54`, `55+`.
- **Constraints**: allergies ("is allergic to peanuts"), diets ("is vegetarian"), and avoid facts ("hates horror" becomes `no horror`). The fact text is kept locally so Keeper can quote it.

### 2. Candidates per person

One `qloo_recommend` call per person (queued one at a time, see [rate limits](#caching-rate-limits-and-the-entity-memo)). Up to 4 loves go in as `signals`, up to 3 tag likes as `signal_tags` with `signal_tags_operator: "union"`, and `limit` is 8 (12 for films, shows, music and books when someone is under 18, so the adult ones can be left out).

When a location is known (from the request, or `AGORA_TASTE_LOCATION`), the call also carries `signal_location` and the person's age band as a `demographic` phrase. Qloo needs a location alongside a demographic, so without a location no age signal is sent. Places also get `filter_location`, so results are in that area.

**Location is split at the first comma** (`splitLocation`). Qloo matches a location string as one place name: "Bandra, Mumbai" finds nothing, while "Bandra" and "Mumbai" both work. So "Bandra, Mumbai" filters places to `Bandra` and sends `Mumbai` as the audience `signal_location`. A single name such as "Mumbai" is used for both.

**Places get a kind.** Dinner out sends `include_tags: ["urn:tag:genre:place:restaurant"]`, Qloo's restaurant genre. An outing sends ten place categories (museum, park, amusement park, tourist attraction, zoo, aquarium, science museum, water park, theme park, botanical garden) with `include_tags_operator: "union"`, and excludes the restaurant genre.

**Diet is a Qloo signal at dinner.** A person whose constraints include `vegetarian`, `jain` or `vegan` gets Qloo's place offering tag in their own calls, and nobody else's: `urn:tag:offerings:place:vegetarian_options` (vegetarian and jain) or `urn:tag:offerings:place:vegan_options` (vegan). In `qloo_recommend` it joins the restaurant genre with `include_tags_operator: "intersection"`, so that person's candidates are restaurants Qloo lists with those options. The tags were found with `qloo tags --type offerings:place`; they are sent as URNs, so they never need resolving. Qloo's "Jain vegetarian food" tag exists but is rare, so jain uses the vegetarian tag. Halal, kosher and the other diets have no verified tag and are left to Keeper.

| Age band | Phrase sent to Qloo |
| --- | --- |
| `0-17` | `teens` |
| `18-24` | `young adults 18-24` |
| `25-34` | `adults 25-34` |
| `35-44` | `adults 35-44` |
| `45-54` | `adults 45-54` |
| `55+` | `seniors` |

An avoid fact ("no horror") becomes `exclude_tags` for films, shows, music and books. It is not sent for places. A person with no loves, no tag likes, and no location is not asked.

**Children.** When anyone in the council is under 18, films, shows, artists and books Qloo rates for adults (R, NC-17, TV-MA, A, 18 and similar), or with a profane or explicit title or description, are left out before the shortlist. The result's note says how many and why, for example "Left out 12 suggestions rated for adults or with an explicit title, because Mia and Rohan are under 18." Places are not filtered this way.

### 3. One shared shortlist

Each person's candidates are interleaved round-robin (first from each person, then second from each person, and so on) and deduplicated by Qloo entity id, then by name. The list stops at 10 options, because `qloo_rank` accepts at most 10. Round-robin means the shortlist is not dominated by whoever had the most results.

### 4. Rank the same list for each person

One `qloo_rank` call per person, with the same `options` (the Qloo entity ids), `option_type`, and that person's `signals`, `signal_location` and `demographic`. `qloo_rank` has no tag-signal field, so tag likes are not used here.

At dinner, a vegetarian, jain or vegan person's rank also carries the diet tag as `include_tags`. Qloo then ranks only the options it lists with those options, and the rest count as last for that person (shown as "Not ranked"). The note says so: "Arjun's ranks count only places Qloo lists with vegetarian options; the others rank last for Arjun." If no option on the shortlist has the tag, the rank is asked again without it, and the note says the person's ranks ignore diet.

Qloo's own tool description says scores from separate calls are not comparable. So the council throws scores away and keeps only each person's order: their 1st, 2nd, ... 10th.

- An option a person's call did not return counts as last (rank = shortlist size) in the score, and shows as "Not ranked".
- A person whose call failed is left out of the score, and the result is marked `degraded`.
- A person with no named favourite and no location cannot be ranked. They are listed in the note, and the result is not marked degraded for that.
- If no rank call came back at all, each person's `qloo_recommend` order is used instead, and the note says so.

### 5. Maximin

For each option: `worstRank` is the highest (worst) rank any person gave it, and `meanRank` is the average. Sort by `worstRank`, then `meanRank`, then shortlist order. The first is the winner. Up to 5 picks are returned.

### 6. Keeper

Keeper is code here, not a model: a keyword check. It reads each candidate's name, Qloo tags, subtitle and description (for places the harness returns a description, not Qloo's full tag list), and removes the candidate if it mentions a word that clashes with someone's constraint:

- `no X` applies to every occasion: "no horror" removes anything mentioning horror.
- Diets and allergies apply to places only. `vegetarian`, `jain` and `vegan` watch for clearly meat-centric words: steakhouse, bbq, barbecue, meat, butcher, churrascaria, grill house, kebab, seafood, fried chicken, mutton and similar. In the place's name only, chicken, fish, prawn, crab and lobster also count ("Chicken Story" is vetoed; a menu with butter chicken is not). The list is narrow on purpose: vegetarians eat at mixed restaurants, and "halal" alone is not a veto (Qloo describes a Pan-Asian place in Khar as having "Halal-friendly vegetarian options"). A peanut allergy watches for peanut, satay, groundnut. The full lists are `MEAT_PLACE_WORDS`, `DIET_WORDS`, `DIET_NAME_WORDS` and `ALLERGEN_WORDS` in [council.ts](../server/taste/council.ts).

Each veto records the option, the person, and the quoted fact. The first veto is added to the spoken sentence.

### 7. Speech and receipts

The spoken sentence is built from the winner's ranks, by code. For example: "For movie night, X works for everyone: it ranks in the top 3 for Arjun, Dadi, Mia and Rohan." It names only the people Qloo actually ranked the winner for; anyone whose rank is missing is named separately ("Qloo has no rank from Dadi for it"), and "everyone" is said only when nobody is missing. When no rank call answered, it says the pick follows Qloo's suggestions and claims no ranks. A long subtitled title is spoken by its main part ("I Am Malala"). The result also carries every Qloo call (tool, arguments, status, summary, result count, ms, and who it was for), a status (`ok`, `degraded`, `error`), and a note when something was missing. The last 5 results are saved to `taste-recent.json` under `AGORA_DATA_DIR`. A "Qloo is not set up" error is not saved, so it cannot fill the list.

## Worked example: the demo family

With `AGORA_DEMO_SEED=1` and empty memory, the server writes these fictional facts at startup:

| Person | Facts |
| --- | --- |
| Mia | "Mia is 9 years old", "Mia loves Encanto, Coco and Taylor Swift", "Mia is allergic to peanuts" |
| Arjun | "Arjun is 41", "Arjun loves A. R. Rahman and Interstellar", "Arjun likes thrillers", "Arjun is vegetarian" |
| Dadi | "Dadi is 74", "Dadi loves Raj Kapoor films, Lata Mangeshkar and Mughal-e-Azam" |
| Rohan | "Rohan is 16", "Rohan loves Spider-Man: Into the Spider-Verse and Arijit Singh", "Rohan likes street food" |

It also adds the task "Pick a film for Saturday family movie night".

The profile parser turns these into:

| Person | Loves (signals) | Tags | Age band | Constraints |
| --- | --- | --- | --- | --- |
| Arjun | A. R. Rahman, Interstellar | thrillers | 35-44 | vegetarian |
| Dadi | Raj Kapoor, Lata Mangeshkar, Mughal-e-Azam | | 55+ | |
| Mia | Encanto, Coco, Taylor Swift | | 0-17 | peanuts |
| Rohan | Spider-Man: Into the Spider-Verse, Arijit Singh | street food | 0-17 | |

Note how mixed the signals are: a composer, a singer, a pop star, an actor-director, and films. For movie night, every one of them is a signal for ranking films. That is the cross-domain part Qloo provides.

**Movie night, location Bengaluru.** The council makes 4 `qloo_recommend` calls, builds a shortlist of up to 10 films, then makes 4 `qloo_rank` calls over that shortlist: 8 calls when nothing needs a retry.

The ranks below are made up to show the arithmetic. They are not a recorded Qloo response. Suppose the shortlist has six films, A to F:

| Film | Arjun | Dadi | Mia | Rohan | Worst | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 5 | 6 | 3 | 6 | 3.75 |
| **B** | 3 | 2 | 3 | 2 | **3** | 2.5 |
| C | 2 | 4 | 2 | 1 | 4 | 2.25 |
| D | 5 | 1 | 5 | 6 | 6 | 4.25 |
| E | 4 | 3 | 1 | 4 | 4 | 3.0 |
| F | 6 | 6 | 4 | 5 | 6 | 5.25 |

- Maximin picks **B**: nobody ranks it below 3rd.
- C has the best mean (2.25), but Dadi ranks it 4th. A mean-based pick would choose C.
- C and E tie on worst rank (4). C wins the tie on mean rank, so the order is B, C, E, A, D.
- A is Arjun's favourite and Mia's last choice. Maximin keeps it out of the top three.
- Spoken: "For movie night, B works for everyone: it ranks in the top 3 for Arjun, Dadi, Mia and Rohan."
- Nobody in the demo family has a "no X" fact, so Keeper vetoes nothing for films.

**Dinner out, location "Bandra, Mumbai".** The same steps with `target_type: "place"`, `filter_location: "Bandra"`, `signal_location: "Mumbai"` and the restaurant genre. Arjun's two calls also carry the vegetarian offering tag. If a candidate's name or description is clearly meat-centric ("kebab", "steakhouse", "fried chicken"), Keeper removes it and quotes "Arjun is vegetarian". If one mentions "satay" or "peanut", it quotes "Mia is allergic to peanuts". The spoken sentence then ends with, for example, "Keeper set aside X because Arjun is vegetarian."

Measured locally against the hackathon endpoint on 31 Oct 2026 (`AGORA_DEMO_SEED=1`, 8 calls each, 0 `needs_input`), before and after the diet signal:

| | Pick | Arjun | Dadi | Mia | Rohan | Keeper |
| --- | --- | --- | --- | --- | --- | --- |
| Before | 1. Hotel Shahnaz | 7 | 2 | 5 | 5 | nothing removed |
| | 2. Oriental Residency | 5 | 8 | 4 | 2 | |
| | 3. Mad Over Donuts | 8 | 7 | 1 | 4 | |
| After | 1. Caravan Serai Bandra | 5 | 5 | 3 | 1 | removed IMBISS Meating Joint and KFC: "Arjun is vegetarian" |
| | 2. Me Time Art Cafe | 1 | 4 | 8 | 9 | |
| | 3. Mad Over Donuts | not ranked | 7 | 1 | 5 | |

Hotel Shahnaz (Qloo: "Casual Indian eatery known for halal dishes and small plates", specialty kheema pav) is not vetoed by Keeper, because that description does not say meat outright. It drops to 4th because Qloo does not list it with vegetarian options, so it ranks last for Arjun. Ranks are of 10; Arjun's diet-filtered rank returned 6 of the 10.

## Request to result, redacted

These are the shapes the council sends to `qloo mcp`, taken from [council.ts](../server/taste/council.ts). Entity ids are replaced with placeholders. No key appears anywhere in a request or a call record; the `qloo mcp` child holds it.

`qloo_recommend` for Arjun, movie night, location Bengaluru:

```json
{
  "target_type": "movie",
  "limit": 8,
  "signals": ["A. R. Rahman", "Interstellar"],
  "signal_location": "Bengaluru",
  "demographic": "adults 35-44",
  "signal_tags": ["thrillers"],
  "signal_tags_operator": "union"
}
```

`qloo_recommend` for Arjun, dinner out, location "Bandra, Mumbai" (names shown before the entity memo swaps in their Qloo ids):

```json
{
  "target_type": "place",
  "limit": 8,
  "signals": ["A. R. Rahman", "Interstellar"],
  "signal_location": "Mumbai",
  "demographic": "adults 35-44",
  "filter_location": "Bandra",
  "include_tags": ["urn:tag:genre:place:restaurant", "urn:tag:offerings:place:vegetarian_options"],
  "include_tags_operator": "intersection",
  "signal_tags": ["thrillers"],
  "signal_tags_operator": "union"
}
```

Rohan's dinner call is the same shape with his signals, `"demographic": "teens"`, `"signal_tags": ["street food"]`, and only the restaurant genre in `include_tags`.

`qloo_rank` for Dadi, movie night, over the shared shortlist:

```json
{
  "options": ["<qloo-entity-id-1>", "<qloo-entity-id-2>", "...", "<qloo-entity-id-10>"],
  "option_type": "movie",
  "signals": ["Raj Kapoor", "Lata Mangeshkar", "Mughal-e-Azam"],
  "signal_location": "Bengaluru",
  "demographic": "seniors"
}
```

Why these choices:

- **Named things go in `signals`, concepts in `signal_tags`.** The harness resolves names such as "Encanto" to Qloo entities itself. Concepts like "thrillers" are tags, not entities.
- **Options are entity ids, not names.** The shortlist came from Qloo, so its ids resolve without ambiguity in `qloo_rank`.
- **Demographic only with a location.** Qloo needs both to describe an audience.
- **Union for tags.** A person who likes "thrillers" and "sci-fi" wants either, not only items tagged with both.

The harness returns an envelope. The fields the council reads are:

```json
{
  "status": "ok",
  "summary": "…",
  "result_count": 8,
  "results": [
    {
      "entity_id": "<qloo-entity-id>",
      "name": "<title>",
      "tags": ["<genre>", "…"],
      "properties": {
        "release_year": 2021,
        "content_rating": "<rating>",
        "image": { "url": "https://…" },
        "short_description": "…"
      }
    }
  ]
}
```

A pick shows only what Qloo returned: year, rating, an address and price level for places, up to 6 tags, and an https image.

## Ambiguity: `needs_input`

When the harness cannot resolve an input to one entity, it returns `status: "needs_input"` with the candidates it found:

```json
{
  "status": "needs_input",
  "summary": "…",
  "resolution": {
    "issues": [
      { "input": "Coco", "field": "signals", "candidates": [{ "id": "<qloo-entity-id>", "name": "Coco" }] }
    ]
  }
}
```

One unresolved input fails the whole call. The harness searches names without a type, so almost every name is ambiguous ("Coco" is a film and three albums). The council resolves each name once and remembers it ([entityMemo.ts](../server/taste/entityMemo.ts)):

- **Choosing.** For a signal, `chooseEntity` prefers a work or artist over a person, an author, a brand, a place or an album; one Qloo describes over a bare record; an exact name over a near one; then Qloo's order. A locality is never a taste signal. For a tag, the harness already scopes the search to the target type, and Qloo's first candidate is taken. A name with no candidate is remembered as dropped.
- **Remembering.** Every answer teaches the memo: ids the harness resolved in an `ok` result, and the choice made for each `needs_input` issue. From then on the Qloo id is sent instead of the name: in the retry, in that person's `qloo_rank`, and in every later council. The memo is saved to `taste-entities.json` under `AGORA_DATA_DIR` (up to 500 entries), keyed by name for signals and by target type and name for tags.
- **Demo seed.** With `AGORA_DEMO_SEED=1`, the demo family's favourites and tags start out resolved (as they resolved live on 31 Oct 2026), so a fresh deploy's first council does not pay the `needs_input` round trip. A saved `taste-entities.json` overrides the seed. The place and diet tags are sent as URNs and never need resolving.
- **Repair.** On `needs_input`, the call is retried once with the remembered ids (`repairArgs` and `callWithRepair` in [council.ts](../server/taste/council.ts)). An ambiguous option is dropped. If the summary mentions the demographic, the demographic is dropped. A `qloo_recommend` call left with no signal, tag, demographic or location is not retried.

Both the first call and the retry appear in the call list. A repaired `needs_input` is not counted as a failure. In the live runs below, with the seed, no call answered `needs_input`.

## Caching, rate limits and the entity memo

From [qlooClient.ts](../server/taste/qlooClient.ts):

- **One child process.** `qloo mcp` (or `QLOO_BIN mcp`) starts on first use and is reused. If it dies, the next call starts a new one, once.
- **Cache.** Results with status `ok` or `empty` are cached for 30 minutes, keyed by tool name and arguments, up to 200 entries. Asking the same council again within 30 minutes makes no new Qloo calls.
- **One in flight.** By default one Qloo call runs at a time and the rest wait (`AGORA_QLOO_IN_FLIGHT`, 1 to 4). The harness resolves the names and ids in one call with its own parallel requests, so one call is already a small burst; a four-person council's 8 calls go one after another.
- **429 retries.** A rate-limited (429) or other retryable answer is retried twice, 1.5 s and then 4 s later, holding the slot so the queued calls back off too. A retry is made only if its wait ends before the council's deadline.
- **Council deadline.** 40 seconds. Past it, queued calls are skipped and the council answers with what it has, marked `degraded`, with the note "The council ran out of time, so some Qloo calls were skipped." A call that started just before can still take its own 20 s, which keeps the whole under the page's 60 s.
- **Entity memo.** Names resolve once, then travel as Qloo ids. See [Ambiguity](#ambiguity-needs_input).
- **Timeouts.** 20 seconds per call, 8 seconds for start-up and the readiness check.
- **Readiness.** Before each council, `qloo_capabilities` checks that the child started and its adapter is ready. The harness answers it without contacting Qloo. Not ready means a clear message ("Qloo is not set up on this server yet. Run qloo setup or set QLOO_API_KEY, then ask again.") and no Qloo calls.
- **Errors never throw.** A failed call becomes an `error` envelope. Error text is cut to 200 characters, and the value of `QLOO_API_KEY` is replaced with `[redacted]` if it ever appears.

## Environment

| Variable | Read by | What it does |
| --- | --- | --- |
| `QLOO_API_KEY` | `qloo mcp` | The Qloo key. Alternative to `qloo setup --qloo`. On Cloud Run it comes from Secret Manager. |
| `QLOO_BASE_URL` | `qloo mcp` | Qloo endpoint. For the hackathon: `https://hackathon.api.qloo.com`. |
| `QLOO_TRUSTED_BASE_URL` | `qloo mcp` | Must equal `QLOO_BASE_URL`. The harness sends a key to a custom endpoint only when both match. `qloo config set base-url` stores both instead. |
| `QLOO_HOME` | `qloo mcp` | Harness state directory. Default `~/.qloo`. The Dockerfile sets `/tmp/qloo`. |
| `QLOO_BIN` | AGORA+ | Path to the `qloo` command. Default `qloo`. |
| `AGORA_TASTE_LOCATION` | AGORA+ | Default location when a request has none. Enables age-band demographics and filters places. |
| `AGORA_DEMO_SEED` | AGORA+ | `1` writes the fictional family into empty memory at startup, and starts the entity memo with the family's resolved Qloo ids. |
| `AGORA_QLOO_IN_FLIGHT` | AGORA+ | Qloo calls in flight at once, 1 to 4. Default 1. |
| `AGORA_SERVER_LLM` | AGORA+ | `vertex` for Gemini on Vertex AI. Also `bedrock` or `openai`. |
| `GOOGLE_CLOUD_PROJECT` | AGORA+ | Google Cloud project for Vertex AI. `GCLOUD_PROJECT` also works. |
| `VERTEX_LOCATION` | AGORA+ | Vertex region. Default `global`. |
| `VERTEX_MODEL` | AGORA+ | Default `google/gemini-3.8-flash`. The `google/` prefix is added if missing. |
| `VERTEX_FAST_MODEL` | AGORA+ | Model for spoken turns. Default `google/gemini-3.5-flash-lite`. |
| `VERTEX_CONCURRENCY` | AGORA+ | Vertex requests in flight. Default 6. |
| `ALEXA_SIM_MODEL` | AGORA+ | Set to `google/gemini-3.8-flash` to use Flash for spoken turns too. |

`QLOO_*` and `AGORA_*` in `.env` reach the server under `npm run dev`. `GOOGLE_CLOUD_PROJECT`, `VERTEX_*` must be set in the shell, because the dev server copies only some names from `.env`. The `qloo mcp` child does not inherit the server's environment. It gets the MCP SDK's minimal default environment (such as `PATH` and `HOME`) plus `QLOO_API_KEY`, `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL`, `QLOO_HOME` and `QLOO_TASTE_RESOLVER_URL`, so other secrets such as OAuth or cloud credentials never reach it.

Vertex authentication is Application Default Credentials: the service account on Cloud Run (it needs `roles/aiplatform.user`), and `gcloud auth application-default login` locally. Outside production, if ADC is not set up, the server falls back to `gcloud auth print-access-token`.

## Setup from a clean environment

You need Node.js 22.19 or newer (the harness's minimum), npm, git, and a Qloo hackathon key.

1. Install Qloo's harness and give it the key. The key prompt is hidden.

   ```bash
   npm install --global @qloo/qloo-harness@0.1.26
   qloo setup --qloo
   qloo config set base-url https://hackathon.api.qloo.com
   qloo setup --status
   ```

   Instead of `qloo setup`, you can export `QLOO_API_KEY`, and set `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` both to `https://hackathon.api.qloo.com`.

2. Get the code and install.

   ```bash
   git clone https://github.com/Ritesh-Root/agora-taste-council.git
   cd agora-taste-council
   npm ci
   cp .env.example .env
   ```

3. Start with the demo family. The Taste Council card needs no language model.

   ```bash
   AGORA_DEMO_SEED=1 AGORA_TASTE_LOCATION=Bengaluru npm run dev
   ```

   Open `http://127.0.0.1:3000/`. The Taste Council card should list Arjun, Dadi, Mia and Rohan. Choose an occasion and press **Ask the council**. The seed only writes when memory is empty. To start over, stop the server and delete `.agora-data/` (this removes all household files).

4. Optional: Gemini for the assistant box. Sign in with `gcloud auth application-default login`, then:

   ```bash
   AGORA_SERVER_LLM=vertex GOOGLE_CLOUD_PROJECT=your-project AGORA_MCP_TOKEN=choose-at-least-32-random-characters \
     AGORA_DEMO_SEED=1 AGORA_TASTE_LOCATION=Bengaluru npm run dev
   ```

   Type "What should we watch tonight?" in the assistant box. On loopback, the assistant reaches `/mcp` with `AGORA_MCP_TOKEN`.

5. Optional: any MCP client.

   ```bash
   claude mcp add --transport http agora http://127.0.0.1:3000/mcp --header "Authorization: Bearer $AGORA_MCP_TOKEN"
   ```

6. Tests. The council is tested against a scripted stand-in for `qloo mcp` ([server/taste/fakeQloo.ts](../server/taste/fakeQloo.ts)), so tests make no Qloo calls.

   ```bash
   npx vitest run server/taste server/mcp src/home
   ```

## Deploy to Cloud Run

One instance only: approvals, the room, and the Qloo cache live in the process, and household files are on the instance disk. On a new instance, empty memory means the demo family is written again.

```bash
PROJECT_ID=your-project
REGION=asia-south1
SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

# The Qloo key, once. Do not put it in the image or in an env var on the command line.
printf '%s' "$QLOO_API_KEY" | gcloud secrets create qloo-api-key --data-file=- --project "$PROJECT_ID"
gcloud secrets add-iam-policy-binding qloo-api-key --project "$PROJECT_ID" \
  --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SA" --role roles/aiplatform.user

gcloud run deploy agora-plus \
  --project "$PROJECT_ID" \
  --source . \
  --region "$REGION" \
  --port 8080 \
  --min-instances 1 \
  --max-instances 1 \
  --timeout 3600 \
  --session-affinity \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --set-secrets QLOO_API_KEY=qloo-api-key:latest \
  --set-env-vars "AGORA_SERVER_LLM=vertex,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,AGORA_DEMO_SEED=1,AGORA_HOUSEHOLD_PASSCODE=$PASSCODE,AGORA_TRUST_PROXY=1,QLOO_BASE_URL=https://hackathon.api.qloo.com,QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com,AGORA_TASTE_LOCATION=Bengaluru"

# Then point the server at its own public origin.
URL="$(gcloud run services describe agora-plus --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
gcloud run services update agora-plus --project "$PROJECT_ID" --region "$REGION" --update-env-vars "AGORA_PUBLIC_URL=$URL"
```

Notes:

- The [Dockerfile](../Dockerfile) installs `@qloo/qloo-harness@0.1.26` globally and sets `QLOO_HOME=/tmp/qloo`. The key comes only from the secret.
- `--source .` builds with the Dockerfile. [.gcloudignore](../.gcloudignore) keeps `.env` and `.agora-data` out of the upload.
- The household passcode is a demo passcode that will be published, so it is an env var here. For a real household, put it in Secret Manager too.
- The assistant box reaches tools through `/mcp`. In production it needs the OAuth settings (`AGORA_OAUTH_CLIENT_ID`, `AGORA_OAUTH_CLIENT_SECRET`, `AGORA_TOKEN_SECRET`), or `AGORA_MCP_TOKEN` with `AGORA_ALLOW_DEV_TOKEN=1`. The Taste Council card does not. See [DEPLOY.md](DEPLOY.md).
- `--allow-unauthenticated` makes the URL reachable; the household passcode still guards the household routes.
- Confirm flag names with `gcloud run deploy --help` for your gcloud version.

## Live results

Measured on the deployed Cloud Run revision `agora-plus-00003` on 31 Oct 2026, around 03:45 IST, with the fictional demo family and the hackathon endpoint. The dinner row is from before the diet signal above. Ranks are Arjun / Dadi / Mia / Rohan, each out of the shortlist (at most 10).

| Occasion | Location | Pick | Arjun | Dadi | Mia | Rohan | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `movie_night` | not given (server default) | 102 Not Out | 4 | 1 | 5 | 5 | |
| `dinner_out` | Bandra, Mumbai | Hotel Shahnaz | 7 | 2 | 5 | 5 | before the diet signal |
| `playlist` | not given (server default) | Parvaaz | 1 | 4 | 5 | 2 | |
| `tv_show` | not given (server default) | Loki | 4 | 4 | 4 | 3 | 12 adult-rated suggestions left out |
| `book_club` | not given (server default) | I Am Malala | 4 | 6 | 4 | 1 | |
| `outing` | Mumbai | Mahakali Caves | 6 | 6 | 2 | 2 | |

Every council answered `ok` with 8 Qloo calls and no `needs_input`. Each took 1.5 to 3 seconds warm; the first, cold call took 18 seconds. These are one run each, not an average.

## Known limitations

What a council result does not establish:

- **Enjoyment.** A rank is where Qloo placed an option among at most 10, for a profile built from a few saved favourites. It is an aggregate affinity, not a prediction about the person.
- **Global quality.** The pick is the fairest option within the shortlist, not the best film or restaurant available.
- **Age suitability.** With someone under 18, only adult ratings (R, NC-17, TV-MA, A, 18) and explicit titles are left out. Only an age band is known, not an age, so TV-14 and PG-13 still pass for a 9-year-old. Books have no rating in Qloo, so only an explicit title or description keeps a book out. The rating shows when Qloo returns one. Check it before a child watches.
- **Allergy or diet safety.** Keeper is a keyword check on names, tags and descriptions. A restaurant that serves peanuts, or is meat-centric, but never says so in Qloo's metadata will pass (Hotel Shahnaz's description says "halal dishes", not meat). The diet tag only reflects whether Qloo lists vegetarian or vegan options. Check the menu.
- **Equal strength across people.** "#2 for Mia" and "#2 for Dadi" are positions, not comparable scores.

Other limits:

- **Children.** There is no "children" demographic. Under-18 is sent as "teens", which the harness maps to its youngest age bucket (24 and younger). Mia (9) and Rohan (16) get the same age signal.
- **Location gates demographics.** Without a location, no age signal is sent, and places may be far away.
- **Location parts.** Only the first comma part filters places ("Bandra, Mumbai" filters to Bandra) and only the second is the audience signal; any further parts are ignored. A neighbourhood name Qloo does not know returns nothing.
- **Tags do not rank.** `qloo_rank` takes no tag signals. A person with only tag likes and no location is not ranked.
- **Chosen, not asked, on ambiguity.** On `needs_input` the council chooses a candidate by type and description (a film or artist over an album of the same name) without asking, and remembers it. It can still be the wrong match, and it stays wrong until `taste-entities.json` is edited or deleted. Tags take Qloo's first candidate.
- **Parser coverage.** The fact parser is English patterns. "Mia's been really into Bluey lately" is not understood. `taste_profile` shows what was parsed.
- **Fairness rule.** Maximin protects the least happy person. It can pass over an option most people rank first.
- **Shortlist size.** 10 options, from at most 8 candidates per person.
- **Cache.** For 30 minutes, the same question returns the same Qloo results.
- **Scale.** One household per server, one Qloo child process, one call at a time by default. A council's time grows with the number of people. The MCP tool tells clients to expect 5 to 20 seconds; the live runs above took 1.5 to 3 seconds warm and 18 seconds cold.
- **Live evidence is small.** The live results above are one run per occasion for one fictional family. Unit and browser tests use a scripted Qloo stand-in and a mocked API.
