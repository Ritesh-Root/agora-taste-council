# The Taste Council and Qloo

How AGORA+ uses Qloo to pick something a whole family will share. This is the technical companion to the [README](../README.md). Every behaviour below is in the code linked next to it.

| File | What it holds |
| --- | --- |
| [shared/taste.ts](../shared/taste.ts) | The contract: occasions, members, picks, call records, results. |
| [server/taste/profile.ts](../server/taste/profile.ts) | Household facts to per-person taste. No model. |
| [server/taste/qlooClient.ts](../server/taste/qlooClient.ts) | The `qloo mcp` child process, cache, two-slot limit, result normalisation. |
| [server/taste/council.ts](../server/taste/council.ts) | Candidates, shortlist, ranks, maximin, Keeper, speech. |
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

One `qloo_recommend` call per person, in parallel (but see [the two-slot limit](#caching-and-the-two-in-flight-limit)). Up to 4 loves go in as `signals`, up to 3 tag likes as `signal_tags` with `signal_tags_operator: "union"`, and `limit` is 8.

When a location is known (from the request, or `AGORA_TASTE_LOCATION`), the call also carries `signal_location` and the person's age band as a `demographic` phrase. Qloo needs a location alongside a demographic, so without a location no age signal is sent. Places also get `filter_location`, so results are in that area.

| Age band | Phrase sent to Qloo |
| --- | --- |
| `0-17` | `teens` |
| `18-24` | `young adults 18-24` |
| `25-34` | `adults 25-34` |
| `35-44` | `adults 35-44` |
| `45-54` | `adults 45-54` |
| `55+` | `seniors` |

An avoid fact ("no horror") becomes `exclude_tags` for films, shows, music and books. It is not sent for places. A person with no loves, no tag likes, and no location is not asked.

### 3. One shared shortlist

Each person's candidates are interleaved round-robin (first from each person, then second from each person, and so on) and deduplicated by Qloo entity id, then by name. The list stops at 10 options, because `qloo_rank` accepts at most 10. Round-robin means the shortlist is not dominated by whoever had the most results.

### 4. Rank the same list for each person

One `qloo_rank` call per person, with the same `options` (the Qloo entity ids), `option_type`, and that person's `signals`, `signal_location` and `demographic`. `qloo_rank` has no tag-signal field, so tag likes are not used here.

Qloo's own tool description says scores from separate calls are not comparable. So the council throws scores away and keeps only each person's order: their 1st, 2nd, ... 10th.

- An option a person's call did not return counts as last (rank = shortlist size) in the score, and shows as "Not ranked".
- A person whose call failed is left out of the score, and the result is marked `degraded`.
- A person with no named favourite and no location cannot be ranked. They are listed in the note, and the result is not marked degraded for that.
- If no rank call came back at all, each person's `qloo_recommend` order is used instead, and the note says so.

### 5. Maximin

For each option: `worstRank` is the highest (worst) rank any person gave it, and `meanRank` is the average. Sort by `worstRank`, then `meanRank`, then shortlist order. The first is the winner. Up to 5 picks are returned.

### 6. Keeper

Keeper is code here, not a model. It reads each candidate's name, Qloo tags, subtitle and description, and removes the candidate if it mentions a word that clashes with someone's constraint:

- `no X` applies to every occasion: "no horror" removes anything mentioning horror.
- Diets and allergies apply to places only. `vegetarian` watches for words such as steakhouse, bbq, barbecue, meat, butcher, churrascaria. A peanut allergy watches for peanut, satay, groundnut. The full lists are `DIET_WORDS` and `ALLERGEN_WORDS` in [council.ts](../server/taste/council.ts).

Each veto records the option, the person, and the quoted fact. The first veto is added to the spoken sentence.

### 7. Speech and receipts

The spoken sentence is built from the winner's ranks, by code. For example: "For movie night, X works for everyone: it ranks in the top 3 for Arjun, Dadi, Mia and Rohan." The result also carries every Qloo call (tool, arguments, status, summary, result count, ms, and who it was for), a status (`ok`, `degraded`, `error`), and a note when something was missing. The last 5 results are saved to `taste-recent.json` under `AGORA_DATA_DIR`. A "Qloo is not set up" error is not saved, so it cannot fill the list.

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

**Dinner out, location Bengaluru.** The same steps with `target_type: "place"` and `filter_location`. If a candidate's name, tags or description mention "steakhouse" or "bbq", Keeper removes it and quotes "Arjun is vegetarian". If one mentions "satay" or "peanut", it quotes "Mia is allergic to peanuts". The spoken sentence then ends with, for example, "Keeper set aside X because Arjun is vegetarian."

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

`qloo_recommend` for Rohan, dinner out, location Bengaluru:

```json
{
  "target_type": "place",
  "limit": 8,
  "signals": ["Spider-Man: Into the Spider-Verse", "Arijit Singh"],
  "signal_location": "Bengaluru",
  "demographic": "teens",
  "signal_tags": ["street food"],
  "signal_tags_operator": "union",
  "filter_location": "Bengaluru"
}
```

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

One unresolved input fails the whole call, so the council repairs it and retries once (`repairArgs` and `callWithRepair` in [council.ts](../server/taste/council.ts)):

- In `signals`, `signal_tags`, `include_tags` and `exclude_tags`, the ambiguous value is replaced with Qloo's first candidate id. A value with no candidate is dropped.
- In `options`, an ambiguous option is dropped.
- If the summary mentions the demographic, the demographic is dropped.
- A `qloo_recommend` call left with no signal, tag, demographic or location is not retried.

Both the first call and the retry appear in the call list. A repaired `needs_input` is not counted as a failure.

## Caching and the two-in-flight limit

From [qlooClient.ts](../server/taste/qlooClient.ts):

- **One child process.** `qloo mcp` (or `QLOO_BIN mcp`) starts on first use and is reused. If it dies, the next call starts a new one, once.
- **Cache.** Results with status `ok` or `empty` are cached for 30 minutes, keyed by tool name and arguments, up to 200 entries. Asking the same council again within 30 minutes makes no new Qloo calls.
- **Two in flight.** At most two Qloo calls run at once. The rest wait. A four-person council makes 8 calls without bursting the hackathon quota.
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
| `AGORA_DEMO_SEED` | AGORA+ | `1` writes the fictional family into empty memory at startup. |
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

## Known limitations

What a council result does not establish:

- **Enjoyment.** A rank is where Qloo placed an option among at most 10, for a profile built from a few saved favourites. It is an aggregate affinity, not a prediction about the person.
- **Global quality.** The pick is the fairest option within the shortlist, not the best film or restaurant available.
- **Age suitability.** No content-rating filter is applied. The rating shows when Qloo returns one. Check it before a child watches.
- **Allergy or diet safety.** Keeper is a keyword check on names, tags and descriptions. A restaurant that serves peanuts but never says so in Qloo's metadata will pass. Check the menu.
- **Equal strength across people.** "#2 for Mia" and "#2 for Dadi" are positions, not comparable scores.

Other limits:

- **Children.** There is no "children" demographic. Under-18 is sent as "teens", which the harness maps to its youngest age bucket (24 and younger). Mia (9) and Rohan (16) get the same age signal.
- **Location gates demographics.** Without a location, no age signal is sent, and places may be far away.
- **Tags do not rank.** `qloo_rank` takes no tag signals. A person with only tag likes and no location is not ranked.
- **First candidate on ambiguity.** On `needs_input` the council takes Qloo's first candidate without asking. It can be the wrong match.
- **Parser coverage.** The fact parser is English patterns. "Mia's been really into Bluey lately" is not understood. `taste_profile` shows what was parsed.
- **Fairness rule.** Maximin protects the least happy person. It can pass over an option most people rank first.
- **Shortlist size.** 10 options, from at most 8 candidates per person.
- **Cache.** For 30 minutes, the same question returns the same Qloo results.
- **Scale.** One household per server, one Qloo child process, two calls at a time. A council's time grows with the number of people. The MCP tool tells clients to expect 5 to 20 seconds; that range was not measured here.
- **No live run is recorded in this repository.** Unit and browser tests use a scripted Qloo stand-in and a mocked API.
