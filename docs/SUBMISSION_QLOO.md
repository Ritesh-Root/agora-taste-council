# Devpost submission: Qloo Agentic Hackathon

Copy-ready text for the "Agents, but with taste" entry. Every claim here matches the code; the details are in [QLOO.md](QLOO.md). Fill in the two placeholders before you submit.

**Live demo:** https://agora-plus-295478535981.us-central1.run.app (household passcode: tastecouncil — a fictional family is preloaded)

**Repository:** https://github.com/Ritesh-Root/agora-taste-council (MIT licence, [LICENSE](../LICENSE))

## Project name

**AGORA+ Taste Council**

Alternatives: "Taste Council: nobody left out", "Family Taste Council".

## Tagline

A household agent that turns what it remembers about each person into Qloo signals, ranks one shortlist per person, and picks the option nobody ranks low.

## Inspiration

Our household assistant, AGORA+, already remembered things about each family member: Mia is 9 and loves Encanto, Dadi is 74 and loves Raj Kapoor films, Arjun is vegetarian. Then someone asked it "what should we watch tonight?" and it guessed. It suggested something generic, or something for whoever had spoken last.

In a multigenerational home, which is common in India and in many other places, that question comes up every week: movie night, dinner out, a road-trip playlist, a show to watch together. A language model can list films. It cannot tell you how a grandmother and a 9-year-old would each rank the same five films. Qloo can.

## What it does

The Taste Council picks something a whole family will share, and shows why.

1. It reads each person's taste from household memory: what they love, what they like, their age band, and their allergies, diets and "no horror" rules. Plain code does this, with no model.
2. For each person it asks Qloo's `qloo_recommend` for candidates of the right type: films, shows, artists, books, or places.
3. It merges those into one shortlist of at most 10, taking turns between people so nobody's picks crowd out the others.
4. For each person it asks Qloo's `qloo_rank` to put that same shortlist in order.
5. It picks by maximin: the option whose worst rank across the family is best. Nobody gets their 9th choice so someone else can have their 1st.
6. Keeper removes anything that clashes with a household fact, such as a steakhouse when Arjun is vegetarian, and quotes the fact.
7. It speaks one sentence ("For movie night, B works for everyone: it ranks in the top 3 for Arjun, Dadi, Mia and Rohan.") and shows each person's rank, the runner-ups, and every Qloo call with its arguments, status and time.

You can use it three ways: the **Ask the council** button on the Home page, the voice and text assistant on that page (Gemini on Vertex AI decides to call the council), or any MCP client such as Claude or ChatGPT through the `taste_council` tool.

Occasions: family movie night, a show to watch together, a road-trip playlist, a family book club, dinner out, and a weekend outing.

## How we built it

- **Qloo through its official harness.** The server starts `qloo mcp` from `@qloo/qloo-harness@0.1.26` as a child process and talks to it over MCP stdio. That is the route Qloo's hackathon kit recommends. The harness resolves names like "Encanto" to Qloo entities, and returns a normalised envelope with a status (`ok`, `needs_input`, `error`, ...).
- **Three Qloo tools.** `qloo_recommend` for candidates per person, `qloo_rank` for each person's order of the shared shortlist, and `qloo_capabilities` to check readiness without calling Qloo.
- **Signals from memory.** A person's named favourites become `signals`. Concepts like "thrillers" become `signal_tags`. An age band becomes a demographic phrase ("teens", "adults 35-44", "seniors"), sent with `signal_location` when a location is known. Places also get `filter_location`.
- **Deterministic decision.** The shortlist, maximin, tie-breaks, Keeper's vetoes and the spoken sentence are plain TypeScript. No model chooses the winner.
- **Provenance in the UI.** Every Qloo call is recorded with tool, arguments, status, result count and milliseconds, and shown under "Qloo calls" on the result.
- **MCP tools.** `taste_council` and `taste_profile` join the household server's other tools, so any MCP agent can call them. Streamable HTTP, OAuth, and approval-before-action were already there.
- **Gemini on Vertex AI.** `AGORA_SERVER_LLM=vertex` runs the assistant's tool loop on Gemini (default `gemini-3.8-flash`, and `gemini-3.5-flash-lite` for spoken turns) through Vertex AI's OpenAI-compatible endpoint, authenticated with Application Default Credentials.
- **Cloud Run.** One instance, the Qloo key from Secret Manager, the harness installed in the Docker image, and a fictional demo family written into empty memory at start-up.
- **Tests.** The council is tested against a scripted stand-in for `qloo mcp`, so tests make no Qloo calls. The `server/taste` tests (65) pass, as do the MCP, Home page and Vertex provider tests.

## Challenges we ran into

- **`qloo_rank` takes at most 10 options.** Four people times eight candidates is up to 32. We cut the shortlist to 10, taking candidates round-robin so every person is represented.
- **Scores from separate calls are not comparable.** Qloo says so in the tool description. We use only each person's ordinal rank, which is also what makes maximin meaningful.
- **A demographic needs a location.** Age signals are sent only when the request or `AGORA_TASTE_LOCATION` gives one. Without it the council still works, with no age signal.
- **"Children" is not a recognised demographic.** We map age bands to phrases Qloo's harness understands: teens, young adults 18-24, adults 25-34 through 45-54, seniors. A 9-year-old is sent as "teens", which the harness maps to its youngest bucket (24 and younger).
- **One unresolved entity fails the whole call.** If one of Dadi's favourites is ambiguous, the call returns `needs_input`. We retry once with Qloo's first suggested match in place of the ambiguous name, and show both calls.
- **Gemini 3 thought signatures.** Gemini returns a signature on each function call and rejects the next request with HTTP 400 unless that signature comes back on the call. Our tool loop uses the Messages shape, which has no slot for it, so we carry it on the tool-use block and send it back. For older history with no signature we send Google's documented placeholder.
- **Thinking budgets.** Gemini 3's thinking tokens count against `max_tokens`. The voice loop asked for 400 tokens and got empty answers. We set a 2048-token floor and a low reasoning effort. Flash rejects `minimal` with HTTP 400, so Flash gets `low` and Flash-Lite gets `minimal`.
- **Quota.** A four-person council is eight Qloo calls. We cap calls at two in flight and cache results for 30 minutes.

## Accomplishments that we're proud of

- The decision is fair by construction, and you can see why: each person's rank is on screen, and so is the person the pick suits least.
- Every Qloo call is visible, with its arguments. Nothing is hidden behind "the AI decided".
- Qloo became a tool for any agent. Claude, ChatGPT, or our own Gemini assistant can call `taste_council` and get the same grounded answer.
- No personal data goes to Qloo. First names, exact ages, allergies and diets stay on the server.
- The Home card works with no language model at all. A model is only needed to understand a spoken question.

## What we learned

- Qloo is strongest across domains. A singer and a filmmaker are good signals for ranking films, and that is exactly what a family's mixed favourites look like.
- `qloo_rank` is the right tool for group decisions. Recommending for a blended profile hides whose taste won. Ranking one fixed list per person makes that visible.
- An agent-facing tool needs honest statuses. `needs_input`, `degraded` and `error` each lead to a different next step, and an agent can only act well if it is told which one happened.
- Keep the model out of the decision. Gemini is good at hearing "something for me and Dadi" and calling the tool with the right arguments. Code is better at a rule the family can check.

## What's next

- Ask the person when `needs_input` offers several matches, instead of taking the first, and remember the answer.
- Use more of Qloo's tools: `qloo_describe` and `qloo_entity_tags` to explain a pick in words the family uses, `qloo_find_tags` to turn "street food" into a Qloo tag before it is sent, and `qloo_compare_audiences` to show where two people's tastes overlap.
- A content-rating filter when a child is in the council.
- Let the family weight the rule: maximin by default, with an option to favour the person whose turn it is.
- Learn from outcomes: "we watched B and Dadi loved it" becomes a new memory fact and a new signal.

## Built with

TypeScript, Node.js 22, React 19, Vite, Tailwind CSS 4, Qloo Insights API, Qloo harness (`@qloo/qloo-harness`, `qloo mcp`), Model Context Protocol (TypeScript SDK), Gemini on Vertex AI, google-auth-library, Google Cloud Run, Secret Manager, Docker, zod, Vitest, Playwright.

## Responsible use (for the submission form or the video)

- Qloo results are aggregate cultural affinities, not predictions about a person. The app says so under every result.
- What goes to Qloo: entity names, tags, an age-band phrase, a location, and Qloo entity ids. What stays local: names, exact ages, allergies, diets, and the fact text.
- Keeper's allergy and diet check is a keyword check on Qloo's metadata, not a menu check.
- Nothing is booked or bought.
- The demo family is fictional.

## Known limitations

See [QLOO.md](QLOO.md#known-limitations). In short: a rank is a position in a shortlist of at most 10 for a profile built from a few favourites; there is no content-rating filter; Keeper is a keyword check; under-18s all get the same age signal; and ambiguity is resolved by taking Qloo's first match.
