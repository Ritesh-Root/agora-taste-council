# AGORA+ Taste Council

A household assistant that turns what it remembers about each person into Qloo signals, ranks one shortlist for each of them, and picks the option nobody ranks low.

**Live demo:** https://agora-plus-295478535981.us-central1.run.app (household passcode: tastecouncil — a fictional family is preloaded)

Submitted to the Qloo Agentic Hackathon ("Agents, but with taste"). Source code is MIT ([LICENSE](LICENSE)). The deep dive is [docs/QLOO.md](docs/QLOO.md). Copy-ready submission text is [docs/SUBMISSION_QLOO.md](docs/SUBMISSION_QLOO.md).

## The problem

AGORA+ is a self-hosted household assistant. It keeps facts about each family member in a file on your server, every write comes back with a receipt, and anything with side effects waits for a person's yes. It is reachable as an MCP server (Claude, ChatGPT, Alexa+-style clients) and from a voice and text assistant on its Home page.

It already knew "Mia loves Encanto", "Dadi is 74" and "Arjun is vegetarian". But when someone asked "what should we watch tonight?", a language model alone could only guess. It tends to pick something generic, or something for whoever spoke last. It has no grounded way to say how a 74-year-old who loves Raj Kapoor films and a 9-year-old who loves Encanto would each rank the same five films.

That is a daily question in multigenerational homes, which are common in India and in many other places: movie night, dinner out, a road-trip playlist, a show to watch together, a family book club, a weekend outing. The Taste Council answers it with Qloo, and shows its work.

## Try it in 60 seconds

On the live demo (a fictional family: Mia 9, Rohan 16, Arjun 41, Dadi 74):

1. Open the link and enter the household passcode. Home opens.
2. Find the **Taste Council** card. There is one chip per person, with their age band, what they love, and what Keeper watches for (for example "Keeper watches: vegetarian").
3. Leave everyone in, choose **Family movie night**, and press **Ask the council**.
4. The result sheet shows the pick, each person's rank for it ("#2 of 10"), who it suits least ("Lowest fit"), Qloo's tags, and the runners-up.
5. Open **Qloo calls** at the bottom. Every call is listed: the tool, who it was for, the status, the result count, the time in ms, and the exact arguments sent.
6. Choose **Dinner out**. If Qloo's candidates include a steakhouse or a satay place, Keeper sets it aside under "Keeper removed" and quotes the fact ("Arjun is vegetarian", "Mia is allergic to peanuts").
7. Tap a chip to leave someone out, for example only Mia and Dadi, and ask again.
8. In the assistant box, type "What should we watch tonight?". The model calls the `taste_council` MCP tool, and **Under the hood** shows that `tools/call`.

## How the council decides

```mermaid
flowchart TD
  mem["Household memory: 'Mia loves Encanto', 'Dadi is 74', 'Arjun is vegetarian'"]
  parse["profile.ts: per person loves, likes, age band, constraints (no model)"]
  rec["qloo_recommend, once per person: their loves as signals, plus age band and location"]
  short["Shortlist: round-robin across people, deduplicated, at most 10"]
  rank["qloo_rank, once per person, same shortlist: ordinal ranks"]
  maximin["Maximin: best worst-rank, then best mean rank"]
  keeper["Keeper: drop picks that clash with a diet, allergy or 'no X' fact, and quote it"]
  out["Top 5 picks, one spoken sentence, every Qloo call"]
  mem --> parse --> rec --> short --> rank --> maximin --> keeper --> out
  home["Home page: POST /api/taste/council"] --> parse
  mcp["MCP tool taste_council: Claude, ChatGPT, the Gemini voice assistant"] --> parse
```

1. **Facts become signals.** [server/taste/profile.ts](server/taste/profile.ts) reads household memory with plain rules. "Dadi loves Raj Kapoor films, Lata Mangeshkar and Mughal-e-Azam" gives three named loves. "Arjun likes thrillers" gives a tag. "Dadi is 74" gives the band `55+`. "Mia is allergic to peanuts" gives a constraint.
2. **Candidates per person.** One `qloo_recommend` call per person, for the target type of the occasion (movie, tv_show, artist, book, or place).
3. **One shared shortlist.** Round-robin across people, so everyone's candidates get in. At most 10 options, because `qloo_rank` accepts at most 10.
4. **Rank the same list per person.** One `qloo_rank` call per person over that shortlist. Qloo says scores from separate calls are not comparable, so the council keeps only each person's order (1st, 2nd, ...).
5. **Maximin.** The winner is the option whose worst rank across people is best. Ties go to the better mean rank. Nobody gets their 9th choice so that someone else gets their 1st.
6. **Keeper.** Picks that clash with a diet, allergy, or "no horror" fact are removed, and the fact is quoted. Here Keeper is plain code, not the model agent of the same name in the household team.
7. **Receipts.** The result carries every Qloo call. The Home page keeps the last few councils after a reload.

The algorithm is in [server/taste/council.ts](server/taste/council.ts). The contract shared by server and page is [shared/taste.ts](shared/taste.ts).

## Qloo tools used, and why

The council talks to Qloo through Qloo's official harness, `qloo mcp` (package `@qloo/qloo-harness@0.1.26`), started as a child process over stdio ([server/taste/qlooClient.ts](server/taste/qlooClient.ts)). That is the route Qloo's hackathon kit recommends. There are no raw HTTP calls to Qloo in this repository.

| Tool | When | What we send | Why this tool |
| --- | --- | --- | --- |
| `qloo_recommend` | Once per person | `target_type`, `limit: 8`, the person's loves as `signals` (up to 4), likes as `signal_tags`, and, when a location is known, `signal_location` plus an age-band `demographic`. Places also get `filter_location`. | Turns each person's favourites into candidates of the right type, across domains: an artist can be the signal for films. |
| `qloo_rank` | Once per person | The same `options` (Qloo entity ids from the shortlist), `option_type`, and that person's `signals`, `signal_location` and `demographic`. | Ranks one fixed list against one person's taste. Comparing positions across people is what makes the choice fair. |
| `qloo_capabilities` | Before each council, and for the card's "ready" state | Nothing | Checks that `qloo mcp` started and has a credential. The harness answers it without contacting Qloo. |

The harness offers nine workflow tools. The council uses the two that fit a group decision. `qloo_describe`, `qloo_entity_tags`, `qloo_find_tags`, `qloo_compare_audiences`, `qloo_audience_demographics`, `qloo_where_popular` and `qloo_trends` are not used yet.

When Qloo cannot resolve a name, the harness returns `needs_input` with candidate matches. The council retries once with Qloo's first candidate id, and both calls show in the call list. Calls are cached for 30 minutes, and at most two are in flight at once. See [docs/QLOO.md](docs/QLOO.md).

## What is Qloo, what is code, what is Gemini

| Part | Done by |
| --- | --- |
| Resolving "Encanto" or "A. R. Rahman" to Qloo entities | Qloo (inside the harness) |
| Candidate options per person | Qloo `qloo_recommend` |
| Each person's ordering of the shared shortlist | Qloo `qloo_rank` |
| Tags, year, rating, address and images on a pick | Qloo result metadata |
| Reading facts into loves, likes, age bands and constraints | Deterministic code, no model |
| Shortlist, maximin, tie-breaks, Keeper vetoes, the spoken sentence | Deterministic code, no model |
| Hearing "what should we watch tonight?", choosing `taste_council` and its arguments, saying the answer | The agent's model. On the server that is Gemini on Vertex AI (`AGORA_SERVER_LLM=vertex`). Any MCP client brings its own model. |

No model chooses the winner. The Home page's **Ask the council** button runs with no model at all.

## Why it needs Qloo

Take Qloo out and the council has nothing to rank with.

- **Cross-domain taste.** Dadi's signals are a filmmaker, a playback singer and a 1960 film. Mia's are two animated films and a pop star. Qloo's taste graph turns both into ranked films, books or restaurants. A model can name films, but it has no measured affinity behind the order.
- **Audience demographics.** An age band and a location become a Qloo demographic signal, so "seniors in Bengaluru" and "teens in Bengaluru" pull the ranking in different directions.
- **Rank against a profile.** `qloo_rank` puts one fixed list in order for one person. That per-person order is the input to the fairness rule. A model has no grounded per-audience ranking to give.

## Responsible use

- **What goes to Qloo:** entity names as written in memory ("Encanto"), abstract likes as tags ("thrillers"), an age-band phrase ("seniors", "adults 35-44"), a location string, the target type, and the shortlist's Qloo entity ids. An "avoid" fact such as "no horror" is sent as an exclude tag for films, shows, music and books.
- **What stays on the server:** first names, exact ages, allergies, diets, and the text of the facts. Names appear only in the local call log ("for Mia"). Keeper checks diets and allergies locally.
- **The key** is read by the `qloo mcp` child from `QLOO_API_KEY` or the harness's own config. Our code never logs it or returns it, and scrubs it from error text.
- **Aggregate, not personal.** Qloo results are aggregate cultural affinities, not predictions about any one person. The card and the result sheet both say so.
- **Nothing is booked or bought.** The council suggests. Adding a pick to the to-do list is a separate button.
- **The demo family is fictional.** It is written only when `AGORA_DEMO_SEED=1` and memory is empty, and it is tagged `demo`.

## Limits

What a council result does **not** establish:

- That a person will enjoy the pick. "#2 of 10 for Dadi" means Qloo placed it second among those ten options for a profile built from Dadi's saved favourites.
- That the pick is the best option anywhere. Ranks are only within a shortlist of at most 10.
- That the pick is suitable for a child. There is no content-rating filter. The rating shows when Qloo returns one; a parent should check it.
- That a place is safe for an allergy or a diet. Keeper is a keyword check on names, tags and descriptions, not a menu or ingredient check.
- That "#2 for Mia" and "#2 for Dadi" mean the same strength of liking. Only order within one person's call is used.

Other limits:

- Under-18 maps to the phrase "teens", which Qloo's harness turns into its youngest age bucket (24 and younger). There is no "children" demographic, so a 9-year-old and a 16-year-old get the same age signal.
- Age and location signals are sent only when a location is known (the request, or `AGORA_TASTE_LOCATION`).
- A person with only abstract likes ("street food") and no named favourite or location cannot be ranked. The result says so.
- The fact parser is English pattern rules. Unusual phrasing is missed. `taste_profile` shows what it understood.
- Maximin is one fairness rule. It can choose a pick everyone ranks third over one most people rank first.
- When `needs_input` offers several matches, the council takes Qloo's first candidate. It can be the wrong "Coco".
- One household per server.

## Run it yourself

Full setup from a clean machine, environment variables, and the Cloud Run command are in [docs/QLOO.md](docs/QLOO.md#setup-from-a-clean-environment). The short version:

```bash
npm install --global @qloo/qloo-harness@0.1.26
qloo setup --qloo                                        # paste the key; it is hidden
qloo config set base-url https://hackathon.api.qloo.com
git clone https://github.com/Ritesh-Root/agora-taste-council.git && cd agora-taste-council
npm ci
AGORA_DEMO_SEED=1 AGORA_TASTE_LOCATION=Bengaluru npm run dev
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/). The Taste Council card works without any language model. The assistant box needs one (see [Quick start](#quick-start)).

From Claude Code, with `AGORA_MCP_TOKEN` set (at least 32 characters):

```bash
claude mcp add --transport http agora http://127.0.0.1:3000/mcp --header "Authorization: Bearer $AGORA_MCP_TOKEN"
```

Then ask "What should the family watch tonight?" or "Where should Arjun and Mia eat in Bengaluru?".

---

# The rest of AGORA+

The household layer was first built for the Amazon Developer Hackathon (Alexa+ track), on top of the AGORA office. The sections below describe that base. They are still accurate for this build.

Household memory is a file on a server you run. Every write returns a receipt whose `verified` flag is a second read of that file. Nothing with side effects starts until a person says yes, and that wait is in the tool result, not only in a prompt.

The surfaces that were run for the Alexa+ entry are the unofficial voice page at `/alexa` and the MCP server at `/mcp`, used from Claude Code with `AGORA_MCP_TOKEN`. MCP clients such as Alexa+ add-ons, Claude, and ChatGPT can connect to that same server. ChatGPT was not run against it, and a live Alexa+ add-on was not deployed. The add-on package in [alexa-addon/addon.json](alexa-addon/addon.json) is still a template: every URL contains `<host>`.

![The household Home after a finished plan](docs/images/home-desktop.jpg)

## Why memory with receipts

Other assistants already advertise family memory, shopping lists, and device control. This server keeps household facts on the machine you run, and a plan does not start until a person says yes. Lights, locks, calendars, and countdown timers are not in this build.

The Alexa+ entry was shaped by four complaints from an 8 Oct 2026 research pass: jobs that stop halfway, slow replies, stored facts that disappear, and people who want a checkpoint before an agent acts. Quotes and sources are in [docs/research/alexa-plus-voice-of-customer.md](docs/research/alexa-plus-voice-of-customer.md) and [docs/research/sources.json](docs/research/sources.json). In this build:

- `remember`, `recall`, and `forget` are backed by `memory.json` and the MCP resource `agora://memory`. A fact can name a person (`who`). The Household panel can edit it.
- `forget` and `plan_and_run` return `needs_approval`. Remembering a fact and adding a task do not wait. On `/alexa` the model cannot call `approve_action`. A person says an exact yes or no, or uses a button. `approve_action` stays an MCP tool for external clients.
- A plan shows its steps and waits for a yes before the team starts. The receipt on a write is a separate thing: `verified` is a read-back from disk.

## What it does

- **Household Home** at `/` (also `/alexa`). This is the page to open first. A greeting with the briefing, the assistant, the Taste Council, Today's reminders, the Shopping and To-do lists (tick, untick, remove, clear the basket), Family facts grouped by person with Allergy, Diet, and Medical badges, and Plans. While a plan runs, the Plans card shows each team member's step and its status; a finished plan opens in the page. **Connect** shows the `/mcp` endpoint and the `claude mcp add` command. **Under the hood** opens the MCP trace beside the page.
- **Voice assistant** on Home. Unofficial simulated Alexa+ experience. Type, or tap or hold to talk. Remember, recall ("What is Mia allergic to?"), the briefing, the shopping list, reminders, and an exact yes or no are routed with no model call ([server/alexaSim/fastPath.ts](server/alexaSim/fastPath.ts)). Other turns go to the server model, which calls tools through the real `/mcp` endpoint. A plan asks the model once for the step list, and only after that preview returns steps does the page wait for a yes. Orders, purchases, bookings, payments, and phone calls are refused, with no approval id. The page shows an "Under the hood" trace of each MCP `tools/call`. While it is open it polls `GET /api/household` about every 30 seconds and speaks "Reminder: &lt;title&gt;." once per due task per page load.
- **MCP server** at `/mcp`. Thirteen tools always (including `taste_council` and `taste_profile`), and `web_research` as a fourteenth when `FIRECRAWL_API_KEY` or `EXA_API_KEY` is set. Three resources (`agora://memory`, `agora://tasks`, `agora://runs/{id}/document`) and two prompts (`morning-briefing`, `plan-a-week-of-meals`). Streamable HTTP. The server negotiates protocol 2025-11-25 and newer ([server/mcp/mcp.test.ts](server/mcp/mcp.test.ts)). Alexa's published client sample sends `2025-03-26`. The specification index on 8 Oct 2026 names 2026-07-28 as current ([docs/council/reports/g4-spec-followup.md](docs/council/reports/g4-spec-followup.md)). OAuth is in [server/mcp/oauth.ts](server/mcp/oauth.ts). `daily_briefing` and `list_tasks` put the MCP Apps card on the tool result as well as the tool definition (`ui://daily_briefing/household-card.html`). The tool reference is [skills/agora-household/references/TOOLS.md](skills/agora-household/references/TOOLS.md).
- **People, lists, and reminders.** A fact can store `who` (a leading name such as "Mia is allergic to peanuts" is enough). A task can store `who`, `list` (`shopping` is its own list; absent means the main to-do list), and `dueAt` (ISO 8601 with a numeric offset). The free-text `due` stays. The briefing speaks one memory line, allergies and medicine first ("Remember: Mia is allergic to peanuts."). Recall says both facts when they tie.
- **Agent Skill** [skills/agora-household/SKILL.md](skills/agora-household/SKILL.md). How to connect, which tool to call, and the rule that a `needs_approval` result waits for a person.
- **Server model.** `AGORA_SERVER_LLM` picks it. `vertex` calls Gemini on Vertex AI through its OpenAI-compatible endpoint, with Application Default Credentials ([server/llm/vertexProvider.ts](server/llm/vertexProvider.ts)). `bedrock` calls Amazon Bedrock through the Claude Messages endpoint ([server/llm/bedrockProvider.ts](server/llm/bedrockProvider.ts)), only when AWS credentials are present. `openai` calls any OpenAI-compatible endpoint (`AGORA_LLM_*` in [.env.example](.env.example), [server/llm/openaiProvider.ts](server/llm/openaiProvider.ts)).
- **Household team**: Agora, Scout, Planner, and Keeper ([server/household/team.ts](server/household/team.ts)), on whichever server model is set. Keeper checks plans against memory. A step whose model call fails is marked for help and the rest of the team finishes. The plans recorded during the Alexa+ hackathon used the `openai` mode with open Qwen models on Featherless, because no AWS credentials were present. A live Bedrock call was not recorded in this workspace.
- **Polly** speaks when AWS credentials are present ([server/alexaSim/tts.ts](server/alexaSim/tts.ts)). The browser voice speaks when Polly returns 503. A successful Polly synthesize was not recorded, so time to first audio was not measured.
- **Approvals and receipts.** `forget` and `plan_and_run` wait. Remembering and adding a task do not. Every write can show `{ action, id, verified, at }`. `verified` is a follow-up read. A failed yes leaves the approval pending so it can be retried. Waiting approvals still live in the process and expire after ten minutes.
- **3D office** at `/office`. The Household cast is the roster. A household run is written to `runs/<id>.json` with `status: "running"` when it starts, and again when it ends. The Society panel shows `spokenSummary` when the run has one.
- **Alexa+ add-on package** in [alexa-addon/addon.json](alexa-addon/addon.json), plus [public/privacy.html](public/privacy.html) and [public/terms.html](public/terms.html). Account linking is enabled in the file (authorization code, PKCE S256). The manifest lists the United States only, and every URL is still `https://<host>/...`. `alexa-ai` was not deployed from this workspace.

The file map is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Screenshots

Captured from the running app on 10 and 12 Oct 2026, before the Taste Council was added.

<img src="docs/images/home-phone.jpg" alt="The same Home on a phone" width="300" />

Claude Code, a separate MCP client, answering from the same household. The output of a real `claude -p` run, set as text:

![Claude Code calling recall and list_tasks on the household MCP server](docs/images/claude-mcp-recall.png)

A `forget` request sent over MCP comes back as `needs_approval` and waits on the Home page for a person:

![A forget request from MCP waiting under "Waiting for you"](docs/images/mcp-approval.jpg)

## Quick start

You need Node.js and npm. The [Dockerfile](Dockerfile) uses Node 22. Qloo's harness asks for Node 22.19.0 or newer. The repository does not declare an engines field.

```bash
git clone https://github.com/Ritesh-Root/agora-taste-council.git
cd agora-taste-council
npm ci
cp .env.example .env
```

The voice page, remember, the briefing, the shopping list, recall, and the Taste Council card do not need a language model. The Taste Council needs Qloo ([docs/QLOO.md](docs/QLOO.md)).

For Gemini on Vertex AI, sign in with `gcloud auth application-default login` and start the server with these in the shell. `npm run dev` copies only `AGORA_*`, `AWS_*`, `BEDROCK_*`, `POLLY_*`, `QLOO_*` and a few other named settings from `.env` into the server, so `GOOGLE_CLOUD_PROJECT` and `VERTEX_*` must come from the shell:

```bash
AGORA_SERVER_LLM=vertex GOOGLE_CLOUD_PROJECT=your-project npm run dev
```

Defaults are `google/gemini-3.8-flash`, and `google/gemini-3.5-flash-lite` for spoken turns. Override with `VERTEX_MODEL` and `VERTEX_FAST_MODEL`, or set `ALEXA_SIM_MODEL=google/gemini-3.8-flash` to use Flash for spoken turns too.

For Amazon Bedrock instead, with AWS credentials on the standard chain (`aws login`, a profile, or a task role), in `.env` (values only, never commit the file):

```bash
AGORA_SERVER_LLM=bedrock
AWS_REGION=us-east-1
```

Bedrock defaults are `anthropic.claude-sonnet-5` and `anthropic.claude-haiku-4-5`. Override with `BEDROCK_MODEL` and `BEDROCK_FAST_MODEL` if you need to.

Claude Code needs a development token of at least 32 characters. A shorter value is ignored.

```bash
AGORA_MCP_TOKEN=choose-at-least-32-random-characters
```

OAuth also needs `AGORA_OAUTH_CLIENT_ID`, `AGORA_OAUTH_CLIENT_SECRET`, and `AGORA_TOKEN_SECRET` (at least 32 characters). A public process also needs `AGORA_PUBLIC_URL` and `AGORA_HOUSEHOLD_PASSCODE`. If the OAuth secrets are empty, those routes return 503 and the development token is the one that can call tools. The token is ignored when `NODE_ENV=production` or `AGORA_PUBLIC_URL` is https, unless `AGORA_ALLOW_DEV_TOKEN=1`. The voice assistant reaches its tools through `/mcp`, so it needs OAuth or an accepted development token too.

```bash
npm run dev
```

`npm run dev` starts Vite on port 3000 and binds `127.0.0.1`, with the room relay and `/mcp`. Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) for the household Home. The optional 3D team view is [http://127.0.0.1:3000/office](http://127.0.0.1:3000/office). `/alexa` is the same Home. `npm run dev:lan` binds `0.0.0.0`. On that bind, `/mcp` and OAuth return 503 until `AGORA_PUBLIC_URL` is set, and household routes from another machine return 403 until `AGORA_HOUSEHOLD_PASSCODE` is set.

### Environment

Names the server reads. Empty in [.env.example](.env.example) means unset. The Qloo and Vertex names are in [docs/QLOO.md](docs/QLOO.md#environment). The full table, including office and deploy names, is [docs/DEPLOY.md](docs/DEPLOY.md). Do not commit real values.

| Variable | What it does |
| --- | --- |
| `AGORA_HOUSEHOLD_PASSCODE` | When set, household HTTP routes need the `agora_household` cookie. Production listens on `0.0.0.0` only when this is set. Five wrong guesses, then 15 minutes and HTTP 429. |
| `AGORA_MCP_TOKEN` | Development bearer for Claude Code and the Inspector. At least 32 characters. Ignored in production or behind an https public URL unless `AGORA_ALLOW_DEV_TOKEN=1`. |
| `AGORA_ALLOW_DEV_TOKEN` | Set to `1` to keep the development token in those cases. |
| `AGORA_TOKEN_SECRET` | HMAC secret for access and refresh tokens. OAuth stays off when it is shorter than 32 characters. |
| `AGORA_OAUTH_CLIENT_ID` | OAuth client id. |
| `AGORA_OAUTH_CLIENT_SECRET` | OAuth client secret. HTTP Basic or the form body, never both. |
| `AGORA_OAUTH_REDIRECT_URIS` | Comma-separated exact `redirect_uri` values. The simulator's own `http://127.0.0.1`, `http://localhost`, and `::1` callbacks are always allowed. |
| `AGORA_PUBLIC_URL` | Public HTTPS origin, no path. Required before OAuth or `/mcp` will answer on a process that is not bound to loopback. |
| `AGORA_TRUST_PROXY` | Set to `1` before `X-Forwarded-Proto` affects the Secure cookie or the OAuth issuer. |
| `AGORA_DATA_DIR` | Household files. Default `.agora-data`. Refresh records are `oauth-refreshes.json` in this directory. |
| `AGORA_TIMEZONE` | Calendar day for "due today" and reminder times. The server reads it. `.env.example` does not list it yet. Unset uses the server's zone. |
| `AGORA_SERVER_LLM` | `vertex`, `bedrock`, or `openai`: the server model used when the browser sent no key. |
| `AGORA_DEMO_SEED` | Set to `1` to write the fictional demo family into empty memory at startup. |
| `AGORA_TASTE_LOCATION` | Default location for the Taste Council. Enables age-band signals and filters places. |
| `DEMO_HOST_SECRET` | Room host code. On an open bind with no passcode, the office has no first-caller host. |

Other scripts:

```bash
npm run build        # client in dist/, and the household card
npm run preview      # static client only; no room and no MCP
npm run lint         # client typecheck
npm run lint:server  # server typecheck
npm test             # unit tests
npm run test:e2e     # Playwright; starts its own server on port 3000
```

`./run-agora.sh` is an optional Chrome launcher for hardware WebGPU on Linux. The office runs without it.

Hosting (named tunnel, ECS, Cloud Run) is [docs/DEPLOY.md](docs/DEPLOY.md). The Cloud Run command with Qloo and Vertex is in [docs/QLOO.md](docs/QLOO.md#deploy-to-cloud-run).

## Connect from Claude Code or any MCP client

The skill is [skills/agora-household/SKILL.md](skills/agora-household/SKILL.md). With the development token:

```bash
claude mcp add --transport http agora http://127.0.0.1:3000/mcp --header "Authorization: Bearer $AGORA_MCP_TOKEN"
```

Any other client uses Streamable HTTP `POST http://127.0.0.1:3000/mcp` with `Accept: application/json, text/event-stream` and `Authorization: Bearer <token>`. A client-credentials token (`scope=mcp:service`) can list tools. Calling them needs `mcp:tools`, from the authorization-code grant or from `AGORA_MCP_TOKEN`.

Try: "What is Mia allergic to?" after you have saved that fact on `/alexa`, or "What should the family watch tonight?" once Qloo is set up.

## History: the Alexa+ hackathon (Aug 31 – Oct 23, 2026)

AGORA existed before that window. The baseline tag `pre-window` is commit `4f61371` (2026-08-20). `git diff --stat pre-window..HEAD` on 8 Oct 2026, at commit `fa7a9c0`, was 288 files changed, 29768 insertions, 2318 deletions, over 40 commits dated 2026-09-23 through 2026-10-08. September kept building the office. 8 Oct added the household brain and the fix wave: people on facts and tasks, the shopping list, reminders, the approval gate in the voice loop, the household lock, persisted OAuth refresh, the MCP Apps card on tool results, and the Household cast in the office. The phase log is [docs/HACKATHON_CHANGES.md](docs/HACKATHON_CHANGES.md).

That entry's tracks were Alexa+ (primary), AWS Builder, and Open Source. Its Devpost text is [docs/SUBMISSION.md](docs/SUBMISSION.md). Also: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AWS.md](docs/AWS.md), [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md), [docs/FEEDBACK.md](docs/FEEDBACK.md), [docs/FRICTION_LOG.md](docs/FRICTION_LOG.md).

The number to read on `/alexa` is time to first audio. It was not measured: the browsers on the build machine had no speech voices, so the fast path only ever showed "text only", and Polly and the model path need credentials. Older local timings were acknowledgement and screen times, not first audio: phase 4 saw the acknowledgement on the wire in 5 ms and on screen in 50 ms and 63 ms; phase 6 logged 55–58 ms to that acknowledgement, about 100 ms for a full remember turn, and about 800 ms from "plan dinners" to the approval card when a preview existed.

The Taste Council, the Vertex AI provider, the demo family, and the Qloo docs were added after that window, for the Qloo Agentic Hackathon.

## Household limits

- One household per server, and one office room in the memory of that process ([server/roomState.ts](server/roomState.ts), [docs/DEPLOY.md](docs/DEPLOY.md)). Waiting approvals and authorization codes are in that same process. Approvals expire after ten minutes. OAuth refresh records and the simulator's linked account are files and survive a restart.
- Household files are on the task disk (`.agora-data` or `AGORA_DATA_DIR`). Replacing the task deletes them unless that directory is on a volume. `POST /api/memory` and `POST /api/tasks` do not yet accept `who`, `list`, or `dueAt`. A fact that starts with a capitalised name still stores `who`. The MCP tools accept the fields.
- The Alexa+ add-on manifest distributes to the US only and was not deployed ([alexa-addon/addon.json](alexa-addon/addon.json)).
- No device control, no calendar, and no countdown timer. Lights, locks, and Hue routines stay out of the demo ([docs/research/feature-matrix.md](docs/research/feature-matrix.md)).
- The microphone uses Web Speech ([src/alexa/useSpeechInput.ts](src/alexa/useSpeechInput.ts)). Record in Chrome. The text box works when that API is missing.
- A live Bedrock call and a successful Polly clip were not recorded here.
- Taste Council limits are [above](#limits) and in [docs/QLOO.md](docs/QLOO.md#known-limitations).

## The shared office

![Five agents in the shared office](docs/images/agora-office.jpg)

AGORA is Ritesh-Root’s open-source workspace where people and AI agents share tasks, chat, and one Markdown document. The session is drawn as a 3D office. When WebGPU and WebGL2 are both unavailable, the same session uses a 2D office.

This repository is a working local workspace, not a finished hosted product. A room lives in the memory of one server process. The current source includes a production process and host controls. The office has no public deployment URL of its own; the live demo link at the top is the household Home.

## What you can do

Implemented in the current source:

- Join one shared room, up to five people, with a display name and a color. There are no accounts.
- Talk in the room. `@all` asks the team to discuss the idea. `@name` addresses one teammate. Chat does not start the document.
- The host submits a brief and starts the run with **Run Swarm**, then **Execute Swarm**.
- Watch planning, worker tasks, a debate when the run calls for one, and the assembled Markdown document.
- See the session in a 3D office (WebGPU, or WebGL2) or the 2D fallback.
- Save the document to your own machine as `agora-document.md`.
- Leave on your own, or, as host, end the session for everyone.
- Save more than one OpenAI-compatible model connection in this browser. One is the default. An agent can use another connection and override its model. Keys stay in the browser and are not stored in the room.
- Start the header’s benchmark control. That automated comparison is not a user study. See [Validation and performance](#validation-and-performance).

Not in this build: saved cloud rooms, accounts, spending caps, and host approval before a document edit becomes final. See [Roadmap](#roadmap).

![The public room, with each person in their own color](docs/images/agora-room.jpg)

<img src="docs/images/agora-agent.jpg" alt="An agent" width="280" />

## Joining the office

Install and run from [Quick start](#quick-start). Open `http://127.0.0.1:3000/` for the household Home. The optional 3D team view is `http://127.0.0.1:3000/office`.

On loopback, with no `DEMO_HOST_SECRET`, the first person to join is the host. On an open bind (`0.0.0.0`) with that secret unset, the first caller is not the host. The host seat is a household session, which exists only when `AGORA_HOUSEHOLD_PASSCODE` is set. With neither the secret nor the passcode, that room has no host. With the secret set, only a matching host code, or the server-issued resume token, makes someone the host. A display name does not. When a passcode is set, the office socket needs the `agora_household` cookie.

A browser-supplied model key stays in `localStorage` under Model connections. The room does not store it. With a server model set (`AGORA_SERVER_LLM`), the office can call it when the browser sent no key. See [docs/AWS.md](docs/AWS.md).

## How a session works

1. People join the room. Everyone connected can see the brief, the tasks, the document, and public chat.
2. `@all` and `@name` send chat. The named agents can reply. That discussion does not create the document.
3. The host runs **Execute Swarm**. A second Execute while a run is active is refused with “A run is already in progress.”
4. Planning splits the brief into tasks. Workers run those tasks. An invalid worker output can be retried once.
5. Debate is conditional. With fewer than two usable worker outputs, there is no debate. Otherwise the first two are debated for up to two rounds. A referee scores each round, and a clear winner ends it early. Without one, the referee sums up the decision the host has to make. Then the lead writes one Markdown document.
6. If the brief says “under 400 words,” the document may be at most 399 words. A word is a whitespace-separated span after trimming, and headings count. Up to two shortening passes may run. A draft that is still over the limit is kept and labelled “Needs revision: exceeds word limit.” If both the word limit and required sections fail, the word-limit label is the one shown. Repair calls are counted separately from the other model calls.
7. Section checks run only when the brief names problem, audience, priorities, and next steps. A miss is labelled “Needs revision: missing required sections.”
8. **Save a copy** downloads the Markdown. The room copy disappears when the process restarts.

**Leave room** drops only that person. **End session**, confirmed with **End for everyone**, is host-only. The server rejects anyone else with “Only the room host can end the session.” and does not wipe the room. A successful end stops scheduling, clears the room and the run, tells every client, and closes the sockets. A late model result cannot restore that document.

After you leave or the host ends the session, the page stays disconnected. An unexpected drop shows a reconnect screen. The separate **Watch a live run** control is an explicit local replay.

## System architecture

```mermaid
flowchart LR
  ui[Browser UI]
  http[HTTP and WebSocket server]
  room[In-memory room and run]
  orch[Orchestrator]
  model[OpenAI-compatible chat API]

  ui --> http
  http --> room
  room --> orch
  orch --> model
  model --> orch
  orch --> room
  room --> ui
```

The browser shows the office, chat, task board, and document. In development, the Vite server attaches the relay and the `/api/cors-proxy` route. The production entry, [server/prod.ts](server/prod.ts), listens on `PORT` (8080 if unset). It binds `0.0.0.0` only when `AGORA_HOUSEHOLD_PASSCODE` is set, and `127.0.0.1` otherwise. It serves `dist/` and attaches the same relay and proxy.

One process holds one room: roster, the last 100 public chat messages, cabin assignment, and a single run. Stages reported on that run are planning, working, debating, assembling, and repairing.

The orchestrator asks an OpenAI-compatible `/chat/completions` endpoint. The browser proxy forwards only an `https` URL whose path ends in `/chat/completions`, and only when the caller sends `Authorization`. It refuses private, loopback, and link-local targets, and it refuses redirects.

The office room is still the memory of one process. A restart clears the roster, the chat, and the live run. Household facts, tasks, and finished runs are files under `.agora-data` (or `AGORA_DATA_DIR`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Model configuration

Open **Model connections** in the header. Each saved connection has a name, an OpenAI-compatible base URL, an API key, and a default model ID. **Test connection** calls that endpoint and shows a short error. It does not print the key.

One connection is the default for this browser. An agent uses that default unless you pick another connection for it. A model ID on the agent replaces the connection’s model only when it differs. Every browser connection uses the same chat-completions protocol. The server's Bedrock path is separate and uses the Claude Messages endpoint. See [docs/AWS.md](docs/AWS.md).

A single configuration saved earlier under `byok-config` is copied into the connection list on the next load. The key, URL, and model are kept. The copy is stored in this browser under `agora-model-connections`.

Key handling:

- Your connections and keys stay in this browser. Room state stores chat, tasks, and the document. It does not store keys.
- A caller key is sent as-is and is never replaced by the server key or by another connection’s key.
- A call without a caller key fails with “Add an API key for that model endpoint.” when no server model is set. With `AGORA_SERVER_LLM` set to `bedrock`, `openai`, or `vertex`, [server/relay.ts](server/relay.ts) uses that server model instead.
- A failed call does not switch to another person’s key, or to a different saved connection.
- The browser proxy copies the caller’s `Authorization` header and does not attach the server key.
- Provider failures shown in the room are short messages, such as “The API key was rejected.” or “That model is not available.” The provider body and the key are not shown.

Do not commit keys. `.env` is gitignored.

## Validation and performance

These are **reported local validation results** from clean commit `6983ddc` (“Keep a swarm document inside the brief and one active run per room.”). They are functional gate checks. They are not real-user benchmarks and they are not proof of usefulness. This README pass did not rerun them. Later commits, including the production entry and host controls, are not covered by this table.

| Check | Run | Recorded result |
|---|---|---|
| Consecutive film brief 1 | `0c4df963` | 258 words |
| Consecutive film brief 2 | `cef22a0f` | 349 words |
| Consecutive film brief 3 | `97163fb1` | 396 words; one repair |
| WebGL-disabled completion | `33b3584e` | 302 words; 2D fallback |
| Workers reload, first attempt | `6e0e9d8c` | State restored and duplicate Execute refused; model timed out after three HTTP attempts; no document |
| Workers reload, second attempt | `204d6509` | State restored; 1,136-word document on a brief without a word cap |
| Debate reload | `e23c0668` | Same run restored at a later stage; 378 words; 55.06 seconds; one repair |
| Assembly reload | `fae60359` | Same run restored; 1,490 words; 114.86 seconds; brief had no stated word cap |

For the debate-reload run, reported usage was 13 model calls: eight planning/worker/merge, four debate/other, one repair; 7,176 input tokens and 4,651 output tokens.

For the assembly-reload run, reported usage was 11 calls: seven planning/worker/merge and four debate/other; 13,239 input tokens and 13,573 output tokens.

How to read the numbers:

- A word is a whitespace-separated span, including headings. The current source still counts that way in [server/society/documentCheck.ts](server/society/documentCheck.ts).
- “Under 400 words” means at most 399.
- Up to two shortening passes are allowed.
- A draft still over the limit is preserved and labelled “Needs revision: exceeds word limit.”
- Repair usage is counted separately.
- The reload checks did not create a second run id.
- Cost was unavailable. It is not zero.
- The timings are single observations on different briefs and conditions. They are not averages and they are not a speed ranking.
- No controlled single-agent versus swarm comparison, and no independent user study, has been completed.
- Swarm Bench’s automated judge is not evidence that the workspace is useful to a person.

## Deployment

Verified from this repository:

- `npm run dev` serves the app and the room together.
- `npm run build` writes the client to `dist/`.
- `npm run preview` serves that client and does not start the room.
- [Dockerfile](Dockerfile) builds the client, bundles [server/prod.ts](server/prod.ts) to `dist/server.mjs`, and runs `node dist/server.mjs`.
- That process listens on `PORT`, default 8080, and binds `0.0.0.0` only when `AGORA_HOUSEHOLD_PASSCODE` is set. It serves `dist/` and attaches the relay.

The static prototype is [https://agora-gamma-seven.vercel.app](https://agora-gamma-seven.vercel.app). Joining there opens a local preview in the browser. It does not start the shared room, and it does not call a model.

For the Alexa+ entry, a container image and a Cloud Run service were not verified from that workspace, and the tunnel, ECS, and Cloud Run commands in [docs/DEPLOY.md](docs/DEPLOY.md) were not run. The Qloo build's Cloud Run command is in [docs/QLOO.md](docs/QLOO.md#deploy-to-cloud-run). There is no static Pages deploy, because a static copy has no `/api`, `/mcp`, or room. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) type-checks the client and server, runs the unit tests, and builds on every push and pull request.

When every browser disconnects, the sockets close. With a platform that stops an idle process, the in-memory room is gone. A model call still in flight is not a background job. This repository does not promise that a document finishes after everyone leaves, or that it survives a restart.

## Current limitations and security

- One process, one room, at most five people.
- Everyone in the room can see the brief, the tasks, the document, and public chat.
- There are no accounts. On loopback, with no `DEMO_HOST_SECRET`, the first joiner is the host. On an open bind without that secret, the household session holds the host seat when a passcode is set, and the room has no host when it is not. With the secret set, host authority is the host code or the resume token.
- Only the host can start a swarm, start a benchmark, or end the session.
- Room state is memory. A restart or an idle shutdown clears it. Save a copy if you want a file.
- There is no spending cap.
- A provider can reject a key, lack a model, or time out. The room shows a short error and does not echo the upstream body.
- Browser keys remain in `localStorage` on that origin. They are not part of the room snapshot.
- The server key must not be used against an arbitrary base URL. The proxy is not an open forwarder.
- Bundled 3D models are CC BY-NC 4.0. They are placeholders and are not licensed for commercial use. See [License and maintainer](#license-and-maintainer).

## Roadmap

The household MCP server, approvals, receipts, and on-disk memory are built. See [What it does](#what-it-does). No dates are set for the office items below.

- Persist a cloud room across restarts, and keep an in-flight run when nobody is connected.
- Hold lasting document edits until the host accepts them.
- Replace the CC BY-NC office models before any commercial use.
- Planned, not built: a temporary workspace, separate from the room server, where a participant can install a CLI and connect a compatible tool to the room. Installing a CLI does not make it an agent. The deliverable today remains one Markdown document.

## License and maintainer

Source code is MIT. See [LICENSE](LICENSE).

Third-party code and assets have their own notices. Those notices stay in the files the licenses require:

- [NOTICE.md](NOTICE.md) — MIT attribution for the upstream office shell, and the CC BY-NC terms for the bundled models.
- [public/models/ASSETS-LICENSE.md](public/models/ASSETS-LICENSE.md) — CC BY-NC 4.0 for the 3D assets.
- [public/models/README.txt](public/models/README.txt) — the same asset terms, next to the model files.

Maintainer: Ritesh-Root &lt;workstationritalks@gmail.com&gt; · https://github.com/Ritesh-Root

Repository: https://github.com/Ritesh-Root/agora-taste-council (forked from https://github.com/Ritesh-Root/agora-plus) · built on AGORA, https://github.com/Ritesh-Root/agora
